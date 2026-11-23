import { createId } from '../db/ids.js';
import type { Job, Repositories } from '../db/interface.js';
import { HttpError } from '../http/responses.js';
import { getKaggleAuthContextForUser, type KaggleAuthContext } from '../kaggle/auth.js';
import { pushKernel } from '../kaggle/client.js';
import { buildTranscriptionNotebook } from '../kaggle/notebook-builder.js';
import { resolveModelAndLanguage, toNotebookModelConfig } from '../models/catalog.js';
import type { ObjectStorage } from '../storage/interface.js';
import { DEFAULT_CALLBACK_TOKEN_TTL_MS, generateJobCallbackToken } from '../worker/callback-auth.js';

export interface DispatchClaimedJobInput {
  job: Job;
  userId: string;
  workerRunId: string;
  auth: KaggleAuthContext;
  repositories: Repositories;
  storage: ObjectStorage;
  callbackBaseUrl: string;
  fetchFn?: typeof fetch;
}

export interface DispatchNextQueuedJobInput {
  userId: string;
  repositories: Repositories;
  storage: ObjectStorage;
  callbackBaseUrl: string;
  claimWhenRunning?: boolean;
  fetchFn?: typeof fetch;
}

export interface DispatchResult {
  jobId: string;
  workerRunId: string;
  kernelRef: string;
  modelId: string;
  language: string;
  status: Job['status'];
}

export function resolveCallbackBaseUrl(requestUrl: string): string {
  const configured = process.env.APP_BASE_URL?.trim();
  const isVercel = Boolean(process.env.VERCEL);
  if (configured) {
    try {
      const parsed = new URL(configured);
      const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (!(isVercel && isLocalHost)) {
        return parsed.toString().replace(/\/+$/, '');
      }
    } catch {
      // Ignore malformed APP_BASE_URL and fall back to runtime origin.
    }
  }
  if (isVercel && process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    return `https://${host}`;
  }
  return new URL(requestUrl).origin.replace(/\/+$/, '');
}

export async function dispatchClaimedJob(input: DispatchClaimedJobInput): Promise<DispatchResult> {
  const { job, userId, workerRunId, auth, repositories, storage, callbackBaseUrl, fetchFn } = input;
  if (!auth.username) {
    throw new HttpError(
      400,
      'Could not resolve your Kaggle username from this API token. Reconnect your Kaggle API token and try again.',
      'KAGGLE_USERNAME_REQUIRED',
    );
  }

  try {
    const resolvedModel = resolveModelAndLanguage({ modelId: job.modelId, language: job.language });
    const notebookModel = toNotebookModelConfig(resolvedModel.entry);
    const { token: callbackToken, tokenHash, expiresAt } = generateJobCallbackToken(DEFAULT_CALLBACK_TOKEN_TTL_MS);

    await repositories.jobs.updateForUser(job.id, userId, {
      callbackTokenHash: tokenHash,
      callbackTokenExpiresAt: expiresAt,
    });

    const audioDownloadUrl = await storage.createSignedDownloadUrl(
      job.sourceObjectKey,
      DEFAULT_CALLBACK_TOKEN_TTL_MS,
    );

    const notebook = buildTranscriptionNotebook({
      jobId: job.id,
      workerRunId,
      language: resolvedModel.language,
      model: notebookModel,
      audioDownloadUrl,
      callbackBaseUrl: callbackBaseUrl.replace(/\/+$/, ''),
      callbackToken,
    });

    const safeSlug = `chep-${job.id.replace(/[^a-zA-Z0-9_-]/g, '')}`.toLowerCase();
    const pushed = await pushKernel(
      auth.headers,
      {
        slug: `${auth.username}/${safeSlug}`,
        title: safeSlug,
        notebook,
        datasetDataSources: [notebookModel.kaggleDataset],
        enableGpu: true,
        enableInternet: true,
        accelerator: resolvedModel.entry.accelerator || 'NvidiaTeslaT4',
      },
      { fetchFn },
    );

    await repositories.jobs.updateForUser(job.id, userId, {
      kaggleKernelRef: pushed.ref,
    });

    return {
      jobId: job.id,
      workerRunId,
      kernelRef: pushed.ref,
      modelId: resolvedModel.modelId,
      language: resolvedModel.language,
      status: job.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Could not start Kaggle notebook.';
    await repositories.jobs
      .failForWorker(job.id, userId, workerRunId, 'FAILED_WORKER_START', message)
      .catch(() => undefined);
    throw error;
  }
}

export async function dispatchNextQueuedJob(input: DispatchNextQueuedJobInput): Promise<DispatchResult | null> {
  const { userId, repositories, storage, callbackBaseUrl, claimWhenRunning = false, fetchFn } = input;

  let auth: KaggleAuthContext;
  try {
    auth = await getKaggleAuthContextForUser(userId, repositories);
  } catch (error) {
    if (claimWhenRunning) {
      const queued = await repositories.queue.countQueuedForUser(userId);
      await repositories.queue.setQueueState(userId, queued > 0 ? 'PAUSED' : 'IDLE');
      return null;
    }
    throw error;
  }

  if (!auth.username) {
    if (claimWhenRunning) {
      const queued = await repositories.queue.countQueuedForUser(userId);
      await repositories.queue.setQueueState(userId, queued > 0 ? 'PAUSED' : 'IDLE');
      return null;
    }
    throw new HttpError(
      400,
      'Could not resolve your Kaggle username from this API token. Reconnect your Kaggle API token and try again.',
      'KAGGLE_USERNAME_REQUIRED',
    );
  }

  const workerRunId = createId('run');
  const job = claimWhenRunning
    ? await repositories.jobs.claimNextQueuedJob(userId, workerRunId)
    : await repositories.jobs.startQueueAndClaimNextJob(userId, workerRunId);

  if (!job) {
    if (claimWhenRunning) {
      const queued = await repositories.queue.countQueuedForUser(userId);
      await repositories.queue.setQueueState(userId, queued > 0 ? 'PAUSED' : 'IDLE');
      return null;
    }
    throw new HttpError(409, 'No queued jobs could be claimed right now.', 'QUEUE_EMPTY');
  }

  try {
    return await dispatchClaimedJob({
      job,
      userId,
      workerRunId,
      auth,
      repositories,
      storage,
      callbackBaseUrl,
      fetchFn,
    });
  } catch (error) {
    if (claimWhenRunning) return null;
    throw error;
  }
}
