import { getRepositories } from '../../../../server/db/index.js';
import type { JobStatus, Repositories } from '../../../../server/db/interface.js';
import { HttpError, jsonResponse, readJson, route } from '../../../../server/http/responses.js';
import { dispatchNextQueuedJob, resolveCallbackBaseUrl } from '../../../../server/jobs/dispatcher.js';
import { assertJobTransition } from '../../../../server/jobs/state.js';
import { getKaggleAuthContextForUser } from '../../../../server/kaggle/auth.js';
import { deleteKernel, pushKernel } from '../../../../server/kaggle/client.js';
import {
  DUAL_THRESHOLD_SECONDS,
  formatTranscripts,
  mergeSegments,
  shardRanges,
  type TranscriptSegment,
} from '../../../../server/kaggle/merge.js';
import { buildTranscriptionNotebook } from '../../../../server/kaggle/notebook-builder.js';
import { resolveModelAndLanguage, toNotebookModelConfig } from '../../../../server/models/catalog.js';
import { getObjectStorage } from '../../../../server/storage/index.js';
import type { ObjectStorage } from '../../../../server/storage/interface.js';
import { deleteSourceMedia } from '../../../../server/storage/job-objects.js';
import {
  createOutputObjectPathname,
  createShardObjectPathname,
  createSubtitleObjectPathname,
} from '../../../../server/storage/pathnames.js';
import { DEFAULT_CALLBACK_TOKEN_TTL_MS, verifyJobCallbackToken } from '../../../../server/worker/callback-auth.js';

type ProgressPhase = 'PREPROCESSING' | 'TRANSCRIBING' | 'FINALIZING';
type WorkerErrorCode = 'FAILED_WORKER_START' | 'FAILED_MEDIA' | 'FAILED_INFERENCE' | 'FAILED_OUTPUT';

const PROGRESS_PHASES = new Set<ProgressPhase>(['PREPROCESSING', 'TRANSCRIBING', 'FINALIZING']);
const WORKER_ERROR_CODES = new Set<WorkerErrorCode>([
  'FAILED_WORKER_START',
  'FAILED_MEDIA',
  'FAILED_INFERENCE',
  'FAILED_OUTPUT',
]);

function parseInternalRoute(pathname: string): { jobId: string; action: string } {
  const prefix = '/api/internal/jobs/';
  if (!pathname.startsWith(prefix)) {
    throw new HttpError(400, 'Invalid route path.', 'INVALID_ROUTE');
  }
  const parts = pathname.slice(prefix.length).split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HttpError(400, 'Invalid route path.', 'INVALID_ROUTE');
  }
  return {
    jobId: decodeURIComponent(parts[0]),
    action: decodeURIComponent(parts[1]),
  };
}

function getRetentionHours(): number {
  const configured = Number(process.env.JOB_RETENTION_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : 24;
}

async function readStoredJson<T>(storage: ObjectStorage, pathname: string): Promise<T> {
  const object = await storage.getPrivateObject(pathname);
  if (!object) {
    throw new HttpError(409, `Missing shard payload: ${pathname}`, 'SHARD_NOT_FOUND');
  }
  const reader = object.stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

async function cleanupFinishedKaggleKernels(
  job: { kaggleKernelRef: string | null; kaggleShard1Ref: string | null },
  userId: string,
  repositories: Repositories,
): Promise<void> {
  const refs = [job.kaggleKernelRef, job.kaggleShard1Ref].filter((ref): ref is string => Boolean(ref));
  if (refs.length === 0) return;
  try {
    const auth = await getKaggleAuthContextForUser(userId, repositories);
    await Promise.all(
      refs.map((ref) => deleteKernel(auth.headers, ref, { fallbackOwner: auth.username }).catch(() => undefined)),
    );
  } catch {
    // Kernel cleanup is best-effort after durable job state transition.
  }
}

async function advanceQueueIfStillRunning(
  userId: string,
  request: Request,
  repositories: Repositories,
  storage: ObjectStorage,
): Promise<void> {
  const queueState = await repositories.queue.getStateForUser(userId);
  if (queueState !== 'RUNNING') return;
  const callbackBaseUrl = resolveCallbackBaseUrl(request.url);
  await dispatchNextQueuedJob({
    userId,
    repositories,
    storage,
    callbackBaseUrl,
    claimWhenRunning: true,
  }).catch(() => undefined);
}

export const GET = route(async (request) => {
  const { jobId, action } = parseInternalRoute(new URL(request.url).pathname);
  if (action !== 'cancel-state') {
    throw new HttpError(404, 'Internal job action not found.', 'NOT_FOUND');
  }

  const repositories = await getRepositories();
  const job = verifyJobCallbackToken(request, await repositories.jobs.getById(jobId));
  const queueState = await repositories.queue.getStateForUser(job.userId);
  return jsonResponse({ shouldCancel: job.status === 'CANCEL_REQUESTED', queueState });
});

export const POST = route(async (request) => {
  const { jobId, action } = parseInternalRoute(new URL(request.url).pathname);
  const repositories = await getRepositories();
  const job = verifyJobCallbackToken(request, await repositories.jobs.getById(jobId));
  if (!job.workerRunId) {
    throw new HttpError(401, 'Worker run scope is missing.', 'WORKER_UNAUTHORIZED');
  }

  if (action === 'cancelled') {
    const result = await repositories.jobs.acknowledgeCancellation(job.id, job.userId, job.workerRunId);
    if (!result || result.job.workerRunId !== job.workerRunId) {
      throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
    }
    if (result.job.status !== 'CANCELLED' || result.queueState !== 'PAUSED') {
      throw new HttpError(409, 'Cancellation is not pending.', 'CANCELLATION_NOT_PENDING');
    }
    await deleteSourceMedia(result.job).catch(() => undefined);
    return jsonResponse({ jobId: job.id, status: 'CANCELLED', queueState: 'PAUSED' });
  }

  if (action === 'progress') {
    const body = await readJson<{
      status?: unknown;
      progress?: unknown;
      durationSec?: unknown;
      processedAudioSec?: unknown;
    }>(request);

    if (typeof body.status !== 'string' || !PROGRESS_PHASES.has(body.status as ProgressPhase)) {
      throw new HttpError(400, 'Invalid progress phase.', 'INVALID_PROGRESS');
    }
    const nextStatus = body.status as ProgressPhase;

    if (job.status === 'CANCEL_REQUESTED') {
      return jsonResponse({ jobId: job.id, status: job.status, shouldCancel: true });
    }
    if (job.status !== nextStatus) {
      assertJobTransition(job.status as JobStatus, nextStatus);
    }

    const progress =
      typeof body.progress === 'number' && Number.isFinite(body.progress)
        ? Math.min(1, Math.max(0, body.progress))
        : undefined;
    const durationSec =
      typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) && body.durationSec > 0
        ? body.durationSec
        : undefined;
    const processedAudioSec =
      typeof body.processedAudioSec === 'number' && Number.isFinite(body.processedAudioSec) && body.processedAudioSec >= 0
        ? body.processedAudioSec
        : undefined;

    const updated = await repositories.jobs.updateProgressForWorker(job.id, job.userId, job.workerRunId, {
      status: nextStatus,
      progress,
      durationSec,
      processedAudioSec,
    });
    if (!updated) {
      throw new HttpError(409, 'Job could not be updated in its current state.', 'INVALID_JOB_STATE');
    }
    return jsonResponse({ jobId: updated.id, status: updated.status, progress: updated.progress });
  }

  if (action === 'plan') {
    const body = await readJson<{ durationSec?: unknown }>(request);
    const durationSec = typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) ? body.durationSec : 0;
    if (durationSec < DUAL_THRESHOLD_SECONDS || job.status === 'CANCEL_REQUESTED' || job.dualMode) {
      return jsonResponse({ dual: false, span: null });
    }

    const bearerMatch = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
    const callbackToken = bearerMatch?.[1];
    if (!callbackToken) {
      return jsonResponse({ dual: false, span: null });
    }

    try {
      const spans = shardRanges(durationSec);
      const auth = await getKaggleAuthContextForUser(job.userId, repositories);
      if (!auth.username) {
        return jsonResponse({ dual: false, span: null });
      }
      const storage = getObjectStorage();
      const audioDownloadUrl = await storage.createSignedDownloadUrl(
        job.sourceObjectKey,
        DEFAULT_CALLBACK_TOKEN_TTL_MS,
      );
      const callbackBaseUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
      const resolvedModel = resolveModelAndLanguage({ modelId: job.modelId, language: job.language });
      const notebookModel = toNotebookModelConfig(resolvedModel.entry);
      const notebook = buildTranscriptionNotebook({
        jobId: job.id,
        workerRunId: job.workerRunId,
        language: resolvedModel.language,
        model: notebookModel,
        audioDownloadUrl,
        callbackBaseUrl,
        callbackToken,
        shardIndex: 1,
        span: spans[1],
      });

      const safeSlug = `chep-${job.id.replace(/[^a-zA-Z0-9_-]/g, '')}-s1`.toLowerCase();
      const pushed = await pushKernel(auth.headers, {
        slug: `${auth.username}/${safeSlug}`,
        title: safeSlug,
        notebook,
        datasetDataSources: [notebookModel.kaggleDataset],
        enableGpu: true,
        enableInternet: true,
        accelerator: resolvedModel.entry.accelerator || 'NvidiaTeslaT4',
      });

      await repositories.jobs.updateForUser(job.id, job.userId, {
        dualMode: true,
        kaggleShard1Ref: pushed.ref,
        durationSec,
      });

      return jsonResponse({ dual: true, span: spans[0] });
    } catch {
      return jsonResponse({ dual: false, span: null });
    }
  }

  if (action === 'shard') {
    const body = await readJson<{
      shardIndex?: unknown;
      segments?: unknown;
      durationSec?: unknown;
    }>(request);

    if (body.shardIndex !== 0 && body.shardIndex !== 1) {
      throw new HttpError(400, 'shardIndex must be 0 or 1.', 'INVALID_SHARD');
    }
    if (!Array.isArray(body.segments)) {
      throw new HttpError(400, 'segments must be an array.', 'INVALID_SHARD');
    }
    const durationSec =
      typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) && body.durationSec >= DUAL_THRESHOLD_SECONDS
        ? body.durationSec
        : job.durationSec;
    if (!durationSec || durationSec < DUAL_THRESHOLD_SECONDS) {
      throw new HttpError(400, 'Valid durationSec is required for dual shard merge.', 'INVALID_SHARD');
    }

    if (job.status === 'CANCEL_REQUESTED') {
      throw new HttpError(409, 'Job cancellation was requested before shard merge.', 'COMPLETION_CONFLICT');
    }

    const storage = getObjectStorage();
    const shardKey = createShardObjectPathname(job.userId, job.id, body.shardIndex);
    await storage.putPrivateObject(shardKey, JSON.stringify(body.segments), 'application/json; charset=utf-8');

    const updated = await repositories.jobs.recordShardForWorker(
      job.id,
      job.userId,
      job.workerRunId,
      body.shardIndex,
      durationSec,
    );
    if (!updated) {
      throw new HttpError(409, 'Job could not record shard in its current state.', 'INVALID_JOB_STATE');
    }

    if (!updated.shard0Done || !updated.shard1Done) {
      return jsonResponse({ jobId: updated.id, shardIndex: body.shardIndex, merged: false });
    }

    const shard0Key = createShardObjectPathname(job.userId, job.id, 0);
    const shard1Key = createShardObjectPathname(job.userId, job.id, 1);
    const [shard0Segments, shard1Segments] = await Promise.all([
      readStoredJson<TranscriptSegment[]>(storage, shard0Key),
      readStoredJson<TranscriptSegment[]>(storage, shard1Key),
    ]);

    const spans = shardRanges(durationSec);
    const merged = mergeSegments([shard0Segments, shard1Segments], spans);
    const { txt, srt } = formatTranscripts(merged.segments);

    const outputKey = createOutputObjectPathname(job.userId, job.id);
    const srtKey = createSubtitleObjectPathname(job.userId, job.id);
    await Promise.all([
      storage.putPrivateObject(outputKey, txt, 'text/plain; charset=utf-8'),
      storage.putPrivateObject(srtKey, srt, 'application/x-subrip; charset=utf-8'),
    ]);

    const expiresAt = new Date(Date.now() + getRetentionHours() * 3600_000);
    const completed = await repositories.jobs.completeForWorker(
      job.id,
      job.userId,
      job.workerRunId,
      outputKey,
      { srtObjectKey: srtKey, expiresAt, durationSec, processedAudioSec: durationSec },
    );

    if (!completed) {
      await Promise.all([
        storage.deleteObject(outputKey).catch(() => undefined),
        storage.deleteObject(srtKey).catch(() => undefined),
      ]);
      throw new HttpError(409, 'Job completion conflicted with cancellation or state change.', 'COMPLETION_CONFLICT');
    }

    await Promise.all([
      deleteSourceMedia(completed, storage).catch(() => undefined),
      storage.deleteObject(shard0Key).catch(() => undefined),
      storage.deleteObject(shard1Key).catch(() => undefined),
    ]);

    await advanceQueueIfStillRunning(job.userId, request, repositories, storage);
    return jsonResponse({ jobId: completed.id, status: completed.status, merged: true });
  }

  if (action === 'complete') {
    const body = await readJson<{
      transcriptText?: unknown;
      subtitleSrt?: unknown;
      durationSec?: unknown;
      processedAudioSec?: unknown;
    }>(request);

    if (typeof body.transcriptText !== 'string') {
      throw new HttpError(400, 'transcriptText is required.', 'INVALID_COMPLETION_PAYLOAD');
    }

    if (job.status === 'CANCEL_REQUESTED') {
      throw new HttpError(409, 'Job cancellation was requested before completion.', 'COMPLETION_CONFLICT');
    }
    assertJobTransition(job.status as JobStatus, 'COMPLETED');

    const storage = getObjectStorage();
    const outputKey = createOutputObjectPathname(job.userId, job.id);
    await storage.putPrivateObject(outputKey, body.transcriptText, 'text/plain; charset=utf-8');

    let srtKey: string | null = null;
    if (typeof body.subtitleSrt === 'string') {
      srtKey = createSubtitleObjectPathname(job.userId, job.id);
      await storage.putPrivateObject(srtKey, body.subtitleSrt, 'application/x-subrip; charset=utf-8');
    }

    const durationSec =
      typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) && body.durationSec > 0
        ? body.durationSec
        : null;
    const processedAudioSec =
      typeof body.processedAudioSec === 'number' && Number.isFinite(body.processedAudioSec) && body.processedAudioSec >= 0
        ? body.processedAudioSec
        : null;
    const expiresAt = new Date(Date.now() + getRetentionHours() * 3600_000);

    const completed = await repositories.jobs.completeForWorker(
      job.id,
      job.userId,
      job.workerRunId,
      outputKey,
      { srtObjectKey: srtKey, expiresAt, durationSec, processedAudioSec },
    );

    if (!completed) {
      await Promise.all([
        storage.deleteObject(outputKey).catch(() => undefined),
        srtKey ? storage.deleteObject(srtKey).catch(() => undefined) : Promise.resolve(),
      ]);
      throw new HttpError(409, 'Job completion conflicted with cancellation or state change.', 'COMPLETION_CONFLICT');
    }

    await deleteSourceMedia(completed, storage).catch(() => undefined);
    await cleanupFinishedKaggleKernels(completed, job.userId, repositories);
    await advanceQueueIfStillRunning(job.userId, request, repositories, storage);
    return jsonResponse({ jobId: completed.id, status: completed.status });
  }

  if (action === 'fail') {
    const body = await readJson<{ errorCode?: unknown; errorMessage?: unknown }>(request);
    const errorCode =
      typeof body.errorCode === 'string' && WORKER_ERROR_CODES.has(body.errorCode as WorkerErrorCode)
        ? (body.errorCode as WorkerErrorCode)
        : 'FAILED_INFERENCE';
    const errorMessage =
      typeof body.errorMessage === 'string' && body.errorMessage.trim()
        ? body.errorMessage.trim().slice(0, 500)
        : 'Transcription failed on the Kaggle worker.';

    console.warn('kaggle_worker_reported_fail', {
      jobId: job.id,
      errorCode,
      errorMessage,
    });

    const failed = await repositories.jobs.failForWorker(
      job.id,
      job.userId,
      job.workerRunId,
      errorCode,
      errorMessage,
    );
    if (!failed) {
      throw new HttpError(409, 'Job could not be marked failed in its current state.', 'INVALID_JOB_STATE');
    }
    await cleanupFinishedKaggleKernels(failed, job.userId, repositories);
    return jsonResponse({ jobId: failed.id, status: failed.status });
  }

  throw new HttpError(404, 'Internal job action not found.', 'NOT_FOUND');
});
