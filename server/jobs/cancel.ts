import type { Job, QueueState, Repositories } from '../db/interface.js';
import { getKaggleAuthContextForUser, type KaggleAuthContext } from '../kaggle/auth.js';
import { deleteKernel, getKernelStatus } from '../kaggle/client.js';
import { deleteSourceMedia } from '../storage/job-objects.js';

const TERMINAL_KAGGLE_STATUSES = new Set(['complete', 'error', 'cancelAcknowledged']);
const ACTIVE_KAGGLE_JOB_STATUSES = new Set<Job['status']>([
  'WORKER_STARTING',
  'PROCESSING',
  'PREPROCESSING',
  'TRANSCRIBING',
  'FINALIZING',
]);
const FORCE_DELETE_STUCK_CANCEL_MS = 30_000;
const ACTIVE_FAILURE_CHECK_DELAY_MS = 15_000;
const COMPLETE_CALLBACK_GRACE_MS = 25_000;

export async function finalizeJobCancellation(
  job: Job,
  userId: string,
  repositories: Repositories,
): Promise<{ status: Job['status']; queueState: QueueState }> {
  if (job.workerRunId) {
    await repositories.jobs.acknowledgeCancellation(job.id, userId, job.workerRunId);
  }
  const latest = await repositories.jobs.getByIdForUser(job.id, userId);
  let finalStatus: Job['status'] = latest?.status ?? job.status;
  if (finalStatus === 'CANCEL_REQUESTED') {
    const updated = await repositories.jobs.updateForUser(
      job.id,
      userId,
      {
        status: 'CANCELLED',
        completedAt: new Date(),
        callbackTokenHash: null,
        callbackTokenExpiresAt: null,
      },
      'CANCEL_REQUESTED',
    );
    if (updated) {
      finalStatus = updated.status;
    }
  }

  const queued = await repositories.queue.countQueuedForUser(userId);
  const nextQueueState: QueueState = queued > 0 ? 'PAUSED' : 'IDLE';
  await repositories.queue.setQueueState(userId, nextQueueState);
  await deleteSourceMedia(latest ?? job).catch(() => undefined);

  return { status: finalStatus, queueState: nextQueueState };
}

async function failRemoteStoppedJob(
  job: Job,
  userId: string,
  repositories: Repositories,
  errorCode: 'FAILED_WORKER_START' | 'FAILED_INFERENCE' | 'FAILED_OUTPUT',
  errorMessage: string,
): Promise<void> {
  let updated: Job | null = null;
  if (job.workerRunId) {
    updated = await repositories.jobs.failForWorker(job.id, userId, job.workerRunId, errorCode, errorMessage);
  }
  if (!updated) {
    await repositories.jobs.updateForUser(
      job.id,
      userId,
      {
        status: errorCode,
        errorCode,
        errorMessage,
        completedAt: new Date(),
        callbackTokenHash: null,
        callbackTokenExpiresAt: null,
      },
      job.status,
    );
  }
  const queued = await repositories.queue.countQueuedForUser(userId);
  await repositories.queue.setQueueState(userId, queued > 0 ? 'PAUSED' : 'IDLE');
}

export async function reconcileUserKaggleJobs(
  userId: string,
  jobs: Job[],
  repositories: Repositories,
): Promise<boolean> {
  const now = Date.now();
  const pendingCancels = jobs.filter((job) => job.status === 'CANCEL_REQUESTED');
  const checkableActive = jobs.filter(
    (job) =>
      ACTIVE_KAGGLE_JOB_STATUSES.has(job.status)
      && Boolean(job.kaggleKernelRef)
      && now - job.updatedAt.getTime() >= ACTIVE_FAILURE_CHECK_DELAY_MS,
  );
  if (pendingCancels.length === 0 && checkableActive.length === 0) return false;

  let auth: KaggleAuthContext | null | undefined;
  const loadAuth = async () => {
    if (auth !== undefined) return auth;
    try {
      auth = await getKaggleAuthContextForUser(userId, repositories);
    } catch {
      auth = null;
    }
    return auth;
  };

  let changed = false;

  for (const job of pendingCancels) {
    const refs = [job.kaggleKernelRef, job.kaggleShard1Ref].filter((ref): ref is string => Boolean(ref));
    if (refs.length === 0) {
      await finalizeJobCancellation(job, userId, repositories);
      changed = true;
      continue;
    }

    const kaggleAuth = await loadAuth();
    if (!kaggleAuth) continue;

    const stuckLongEnough = now - job.updatedAt.getTime() >= FORCE_DELETE_STUCK_CANCEL_MS;
    const outcomes = await Promise.all(
      refs.map(async (ref) => {
        try {
          const remote = await getKernelStatus(kaggleAuth.headers, ref, {
            fallbackOwner: kaggleAuth.username,
          });
          if (TERMINAL_KAGGLE_STATUSES.has(remote.status) || stuckLongEnough) {
            await deleteKernel(kaggleAuth.headers, ref, {
              fallbackOwner: kaggleAuth.username,
            }).catch(() => undefined);
            return true;
          }
          return false;
        } catch {
          if (stuckLongEnough) {
            try {
              await deleteKernel(kaggleAuth.headers, ref, {
                fallbackOwner: kaggleAuth.username,
              });
              return true;
            } catch {
              return false;
            }
          }
          return false;
        }
      }),
    );

    if (outcomes.every(Boolean)) {
      await finalizeJobCancellation(job, userId, repositories);
      changed = true;
    }
  }

  for (const job of checkableActive) {
    const kaggleAuth = await loadAuth();
    if (!kaggleAuth || !job.kaggleKernelRef) continue;
    const refs = [job.kaggleKernelRef, job.kaggleShard1Ref].filter((ref): ref is string => Boolean(ref));

    try {
      const remote = await getKernelStatus(kaggleAuth.headers, job.kaggleKernelRef, {
        fallbackOwner: kaggleAuth.username,
      });

      if (remote.status === 'error' || remote.status === 'cancelAcknowledged') {
        const errorCode = job.status === 'WORKER_STARTING' ? 'FAILED_WORKER_START' : 'FAILED_INFERENCE';
        await failRemoteStoppedJob(
          job,
          userId,
          repositories,
          errorCode,
          remote.failureMessage || 'Kaggle notebook stopped unexpectedly.',
        );
        await Promise.all(
          refs.map((ref) => deleteKernel(kaggleAuth.headers, ref, { fallbackOwner: kaggleAuth.username }).catch(() => undefined)),
        );
        changed = true;
        continue;
      }

      if (remote.status === 'complete' && now - job.updatedAt.getTime() >= COMPLETE_CALLBACK_GRACE_MS) {
        await failRemoteStoppedJob(
          job,
          userId,
          repositories,
          'FAILED_OUTPUT',
          'Kaggle notebook finished without uploading the transcript.',
        );
        await Promise.all(
          refs.map((ref) => deleteKernel(kaggleAuth.headers, ref, { fallbackOwner: kaggleAuth.username }).catch(() => undefined)),
        );
        changed = true;
      }
    } catch {
      // Transient Kaggle poll errors leave the job active until the next poll cycle.
    }
  }

  return changed;
}

export const reconcilePendingCancellationsForUser = reconcileUserKaggleJobs;
