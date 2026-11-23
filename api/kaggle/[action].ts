import { randomBytes } from 'node:crypto';

import { requireUser } from '../../server/auth/session.js';
import { getRepositories } from '../../server/db/index.js';
import type { KaggleCredentialsRecord } from '../../server/db/interface.js';
import { HttpError, extractPathId, jsonResponse, readJson, route } from '../../server/http/responses.js';
import {
  buildKaggleAuthHeadersFromSecret,
  getKaggleAuthContextForUser,
  isKaggleOAuthEnabled,
  parseKaggleConnectInput,
} from '../../server/kaggle/auth.js';
import { cancelKernel, getKernelStatus, pushKernel, verifyCredentials } from '../../server/kaggle/client.js';
import { encryptKaggleSecret } from '../../server/kaggle/crypto.js';
import { buildGpuProbeNotebook } from '../../server/kaggle/notebook-builder.js';

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'Cross-origin request rejected.', 'FORBIDDEN_ORIGIN');
  }
}

function toSafeStatus(record: KaggleCredentialsRecord | null, overrideMessage?: string) {
  const oauthEnabled = isKaggleOAuthEnabled();
  if (!record) {
    return {
      connected: false,
      available: false,
      authMode: null,
      username: null,
      oauthEnabled,
      gpuStatus: 'unchecked' as const,
      gpuMessage: null,
      gpuCheckedAt: null,
      connectedAt: null,
      message: overrideMessage || 'Connect your Kaggle API token to run transcription on Kaggle T4 GPUs.',
    };
  }

  return {
    connected: true,
    available: true,
    authMode: record.authMode,
    username: record.kaggleUsername,
    oauthEnabled,
    gpuStatus: record.gpuStatus,
    gpuMessage: record.gpuMessage,
    gpuCheckedAt: record.gpuCheckedAt ? record.gpuCheckedAt.toISOString() : null,
    connectedAt: record.connectedAt.toISOString(),
    message:
      overrideMessage
      || (record.kaggleUsername
        ? `Connected to Kaggle as ${record.kaggleUsername}.`
        : 'Connected to Kaggle via API token.'),
  };
}

const GPU_PROBE_TIMEOUT_MS = 10 * 60_000;

export const GET = route(async (request) => {
  const action = extractPathId(new URL(request.url).pathname, '/api/kaggle/');
  if (action !== 'status') {
    throw new HttpError(404, 'Kaggle endpoint not found.', 'NOT_FOUND');
  }
  const user = await requireUser(request);
  const repositories = await getRepositories();
  let record = await repositories.kaggleCredentials.getKaggleCredentials(user.id);

  if (record && record.gpuStatus === 'checking' && record.gpuProbeRef) {
    const timedOut = Boolean(
      record.gpuCheckedAt && Date.now() - record.gpuCheckedAt.getTime() > GPU_PROBE_TIMEOUT_MS,
    );
    try {
      const auth = await getKaggleAuthContextForUser(user.id, repositories);
      const remote = await getKernelStatus(auth.headers, record.gpuProbeRef);
      if (remote.status === 'complete') {
        const updated = await repositories.kaggleCredentials.updateGpuCheck(user.id, {
          gpuStatus: 'ready',
          gpuMessage: 'Kaggle T4 GPU confirmed.',
          gpuCheckedAt: new Date(),
          gpuProbeRef: null,
        });
        await cancelKernel(auth.headers, record.gpuProbeRef).catch(() => undefined);
        if (updated) record = updated;
      } else if (remote.status === 'error' || remote.status === 'cancelAcknowledged') {
        const updated = await repositories.kaggleCredentials.updateGpuCheck(user.id, {
          gpuStatus: 'error',
          gpuMessage:
            remote.failureMessage
            || 'Kaggle could not start a T4 GPU session. Verify your phone number in Kaggle Settings.',
          gpuCheckedAt: new Date(),
          gpuProbeRef: null,
        });
        await cancelKernel(auth.headers, record.gpuProbeRef).catch(() => undefined);
        if (updated) record = updated;
      } else if (timedOut) {
        const updated = await repositories.kaggleCredentials.updateGpuCheck(user.id, {
          gpuStatus: 'error',
          gpuMessage: 'Kaggle GPU check timed out. Click Check GPU condition to try again.',
          gpuCheckedAt: new Date(),
          gpuProbeRef: null,
        });
        await cancelKernel(auth.headers, record.gpuProbeRef).catch(() => undefined);
        if (updated) record = updated;
      }
    } catch (error) {
      console.warn('kaggle_gpu_probe_poll_failed', error instanceof Error ? error.message : String(error));
      if (timedOut) {
        const updated = await repositories.kaggleCredentials.updateGpuCheck(user.id, {
          gpuStatus: 'error',
          gpuMessage: 'Kaggle GPU check timed out. Click Check GPU condition to try again.',
          gpuCheckedAt: new Date(),
          gpuProbeRef: null,
        });
        if (updated) record = updated;
      }
    }
  }

  return jsonResponse(toSafeStatus(record));
});

export const POST = route(async (request) => {
  const action = extractPathId(new URL(request.url).pathname, '/api/kaggle/');
  assertSameOrigin(request);
  const user = await requireUser(request);
  const repositories = await getRepositories();

  if (action === 'connect') {
    const body = await readJson<unknown>(request);
    const parsed = parseKaggleConnectInput(body);
    const headers = buildKaggleAuthHeadersFromSecret(parsed.secret);
    const verification = await verifyCredentials(headers, parsed.username);

    if (!verification.valid) {
      throw new HttpError(401, verification.error || 'Invalid Kaggle API credentials.', 'INVALID_KAGGLE_CREDENTIALS');
    }

    const username = verification.username ?? parsed.username ?? null;
    const envelope = encryptKaggleSecret(JSON.stringify(parsed.secret), { aad: user.id });
    const saved = await repositories.kaggleCredentials.upsertKaggleCredentials({
      userId: user.id,
      authMode: 'api_token',
      kaggleUsername: username,
      encryptedToken: envelope.encryptedToken,
      tokenIv: envelope.tokenIv,
      tokenAuthTag: envelope.tokenAuthTag,
    });

    return jsonResponse(toSafeStatus(saved));
  }

  if (action === 'gpu-check') {
    const queueState = await repositories.queue.getStateForUser(user.id);
    if (queueState === 'RUNNING' || queueState === 'PAUSING') {
      throw new HttpError(409, 'Wait for the current transcription job to finish before checking GPU condition.', 'QUEUE_BUSY');
    }

    const auth = await getKaggleAuthContextForUser(user.id, repositories);
    if (!auth.username) {
      throw new HttpError(
        400,
        'Could not resolve your Kaggle username from this API token. Reconnect your Kaggle API token and try again.',
        'KAGGLE_USERNAME_REQUIRED',
      );
    }

    const existing = await repositories.kaggleCredentials.getKaggleCredentials(user.id);
    if (existing?.gpuProbeRef) {
      await cancelKernel(auth.headers, existing.gpuProbeRef).catch(() => undefined);
    }

    const probeSlug = `chep-gpu-check-${randomBytes(8).toString('hex')}`;
    const pushed = await pushKernel(auth.headers, {
      slug: `${auth.username}/${probeSlug}`,
      title: probeSlug,
      notebook: buildGpuProbeNotebook(),
      datasetDataSources: [],
      enableGpu: true,
      enableInternet: false,
      accelerator: 'NvidiaTeslaT4',
    });

    const updated = await repositories.kaggleCredentials.updateGpuCheck(user.id, {
      gpuStatus: 'checking',
      gpuMessage: 'Checking Kaggle T4 GPU access...',
      gpuCheckedAt: new Date(),
      gpuProbeRef: pushed.ref,
    });

    return jsonResponse(toSafeStatus(updated));
  }

  throw new HttpError(404, 'Kaggle endpoint not found.', 'NOT_FOUND');
});

export const DELETE = route(async (request) => {
  const action = extractPathId(new URL(request.url).pathname, '/api/kaggle/');
  if (action !== 'disconnect') {
    throw new HttpError(404, 'Kaggle endpoint not found.', 'NOT_FOUND');
  }
  assertSameOrigin(request);
  const user = await requireUser(request);
  const repositories = await getRepositories();
  await repositories.kaggleCredentials.deleteKaggleCredentials(user.id);
  return jsonResponse(toSafeStatus(null, 'Kaggle account disconnected.'));
});
