import { createHash, timingSafeEqual } from 'node:crypto';

import type { Repositories } from '../db/interface.js';
import { HttpError } from '../http/responses.js';
import { parseEncryptionKey } from '../kaggle/crypto.js';
import { reconcileStalledKaggleJobs, type ReconcileSummary } from '../kaggle/reconcile.js';
import type { ObjectStorage } from '../storage/interface.js';
import { deleteSourceMedia, deleteTranscriptArtifact } from '../storage/job-objects.js';

export interface CleanupJobOptions {
  repositories: Repositories;
  storage: ObjectStorage;
  now?: number;
  abandonedUploadHours?: number;
  retentionHours?: number;
  reconcileStalled?: boolean;
  fetchFn?: typeof fetch;
}

export interface CleanupSummary {
  abandonedCleaned: number;
  expiredCleaned: number;
  reconciled: ReconcileSummary | null;
  errors: Array<{ jobId: string; phase: 'abandoned' | 'expired'; message: string }>;
}

export function getJobRetentionHours(): number {
  const configured = Number(process.env.JOB_RETENTION_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : 24;
}

export function getAbandonedUploadHours(): number {
  const configured = Number(process.env.ABANDONED_UPLOAD_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : 2;
}

export function verifyCronAuthorization(request: Request): void {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    throw new HttpError(503, 'Cleanup cron secret is not configured.', 'CRON_NOT_CONFIGURED');
  }

  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token) {
    throw new HttpError(401, 'Cron authorization is required.', 'CRON_UNAUTHORIZED');
  }

  const providedHash = createHash('sha256').update(token, 'utf8').digest();
  const expectedHash = createHash('sha256').update(secret, 'utf8').digest();
  if (!timingSafeEqual(providedHash, expectedHash)) {
    throw new HttpError(401, 'Invalid cron authorization.', 'CRON_UNAUTHORIZED');
  }
}

function isEncryptionConfigured(): boolean {
  try {
    parseEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

export async function runCleanupJob(options: CleanupJobOptions): Promise<CleanupSummary> {
  const now = options.now ?? Date.now();
  const abandonedHours = options.abandonedUploadHours ?? getAbandonedUploadHours();
  const retentionHours = options.retentionHours ?? getJobRetentionHours();

  const abandonedCutoff = new Date(now - abandonedHours * 3600_000);
  const retentionCutoff = new Date(now - retentionHours * 3600_000);
  const nowDate = new Date(now);

  const summary: CleanupSummary = {
    abandonedCleaned: 0,
    expiredCleaned: 0,
    reconciled: null,
    errors: [],
  };

  const abandoned = await options.repositories.jobs.listAbandonedUploads(abandonedCutoff);
  for (const job of abandoned) {
    try {
      await deleteSourceMedia(job, options.storage);
      await options.repositories.jobs.updateForUser(job.id, job.userId, {
        status: 'FAILED_UPLOAD',
        errorCode: 'UPLOAD_EXPIRED',
        errorMessage: 'The upload was not completed in time and was removed.',
        completedAt: nowDate,
        storageCleanedAt: nowDate,
        callbackTokenHash: null,
        callbackTokenExpiresAt: null,
      });
      summary.abandonedCleaned += 1;
    } catch (error) {
      summary.errors.push({
        jobId: job.id,
        phase: 'abandoned',
        message: error instanceof Error ? error.message : 'Failed to clean abandoned upload.',
      });
    }
  }

  const expired = await options.repositories.jobs.listRetentionExpiredJobs(retentionCutoff, nowDate);
  for (const job of expired) {
    try {
      await deleteSourceMedia(job, options.storage);
      await deleteTranscriptArtifact(job, options.storage);
      await options.repositories.jobs.updateForUser(job.id, job.userId, {
        ...(job.status === 'COMPLETED' ? { status: 'EXPIRED' as const } : {}),
        outputObjectKey: null,
        storageCleanedAt: nowDate,
        callbackTokenHash: null,
        callbackTokenExpiresAt: null,
      });
      summary.expiredCleaned += 1;
    } catch (error) {
      summary.errors.push({
        jobId: job.id,
        phase: 'expired',
        message: error instanceof Error ? error.message : 'Failed to clean expired job.',
      });
    }
  }

  const shouldReconcile = options.reconcileStalled ?? isEncryptionConfigured();
  if (shouldReconcile) {
    summary.reconciled = await reconcileStalledKaggleJobs({
      repositories: options.repositories,
      storage: options.storage,
      now,
      fetchFn: options.fetchFn,
    });
  }

  return summary;
}
