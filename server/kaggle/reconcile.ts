import type { Job, Repositories } from '../db/interface.js';
import type { ObjectStorage } from '../storage/interface.js';
import { deleteSourceMedia } from '../storage/job-objects.js';
import { getKaggleAuthContextForUser } from './auth.js';
import { cancelKernel, getKernelStatus } from './client.js';

export interface ReconcileOptions {
  repositories: Repositories;
  storage?: ObjectStorage;
  staleMinutes?: number;
  maxRuntimeHours?: number;
  now?: number;
  fetchFn?: typeof fetch;
}

export interface ReconcileSummary {
  checked: number;
  updated: number;
  cancelled: number;
  failed: number;
  errors: Array<{ jobId: string; message: string }>;
}

async function resetQueueAfterTerminalJob(repositories: Repositories, userId: string): Promise<void> {
  const queued = await repositories.queue.countQueuedForUser(userId);
  await repositories.queue.setQueueState(userId, queued > 0 ? 'PAUSED' : 'IDLE');
}

async function markFailedAndClearToken(
  repositories: Repositories,
  job: Job,
  errorCode: 'FAILED_WORKER_START' | 'FAILED_INFERENCE' | 'FAILED_OUTPUT',
  errorMessage: string,
  now: number,
): Promise<void> {
  await repositories.jobs.updateForUser(job.id, job.userId, {
    status: errorCode,
    errorCode,
    errorMessage,
    completedAt: new Date(now),
    callbackTokenHash: null,
    callbackTokenExpiresAt: null,
  });
  await resetQueueAfterTerminalJob(repositories, job.userId);
}

export async function reconcileStalledKaggleJobs(options: ReconcileOptions): Promise<ReconcileSummary> {
  const staleMinutes = options.staleMinutes ?? 15;
  const maxRuntimeHours = options.maxRuntimeHours ?? 12;
  const now = options.now ?? Date.now();
  const olderThan = new Date(now - staleMinutes * 60_000);
  const maxRuntimeCutoff = now - maxRuntimeHours * 3600_000;

  const stalledJobs = await options.repositories.jobs.listStalledKaggleJobs(olderThan);
  const summary: ReconcileSummary = {
    checked: 0,
    updated: 0,
    cancelled: 0,
    failed: 0,
    errors: [],
  };

  for (const job of stalledJobs) {
    if (!job.kaggleKernelRef) continue;
    summary.checked += 1;

    try {
      const auth = await getKaggleAuthContextForUser(job.userId, options.repositories);
      const remote = await getKernelStatus(auth.headers, job.kaggleKernelRef, { fetchFn: options.fetchFn });

      if (remote.status === 'error') {
        const errorCode = job.status === 'WORKER_STARTING' ? 'FAILED_WORKER_START' : 'FAILED_INFERENCE';
        await markFailedAndClearToken(
          options.repositories,
          job,
          errorCode,
          remote.failureMessage || 'Kaggle notebook stopped unexpectedly.',
          now,
        );
        summary.updated += 1;
        summary.failed += 1;
        continue;
      }

      if (remote.status === 'cancelAcknowledged') {
        if (job.status === 'CANCEL_REQUESTED' && job.workerRunId) {
          await options.repositories.jobs.acknowledgeCancellation(job.id, job.userId, job.workerRunId);
        } else {
          await options.repositories.jobs.updateForUser(job.id, job.userId, {
            status: 'CANCELLED',
            completedAt: new Date(now),
            callbackTokenHash: null,
            callbackTokenExpiresAt: null,
          });
          await resetQueueAfterTerminalJob(options.repositories, job.userId);
        }
        await deleteSourceMedia(job, options.storage);
        summary.updated += 1;
        summary.cancelled += 1;
        continue;
      }

      if (remote.status === 'complete') {
        await markFailedAndClearToken(
          options.repositories,
          job,
          'FAILED_OUTPUT',
          'Kaggle notebook finished without uploading the transcript.',
          now,
        );
        summary.updated += 1;
        summary.failed += 1;
        continue;
      }

      const startedTime = (job.startedAt ?? job.createdAt).getTime();
      if ((remote.status === 'queued' || remote.status === 'running') && startedTime <= maxRuntimeCutoff) {
        const refs = [job.kaggleKernelRef, job.kaggleShard1Ref].filter((ref): ref is string => Boolean(ref));
        await Promise.all(refs.map((ref) => cancelKernel(auth.headers, ref, { fetchFn: options.fetchFn }).catch(() => undefined)));
        await markFailedAndClearToken(
          options.repositories,
          job,
          'FAILED_INFERENCE',
          'Kaggle session exceeded maximum allowed runtime.',
          now,
        );
        summary.updated += 1;
        summary.failed += 1;
      }
    } catch (error) {
      summary.errors.push({
        jobId: job.id,
        message: error instanceof Error ? error.message : 'Reconciliation failed.',
      });
    }
  }

  return summary;
}
