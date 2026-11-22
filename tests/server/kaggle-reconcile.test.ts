import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import type { Job, JobPatch, Repositories } from '../../server/db/interface';
import { encryptKaggleSecret } from '../../server/kaggle/crypto';
import { reconcileStalledKaggleJobs } from '../../server/kaggle/reconcile';
import type { ObjectStorage } from '../../server/storage/interface';

function makeJob(overrides: Partial<Job>): Job {
  const now = new Date('2026-10-02T00:00:00.000Z');
  return {
    id: 'job_1',
    userId: 'usr_1',
    originalFilename: 'lecture.mp4',
    sourceObjectKey: 'users/usr_1/jobs/job_1/source/lecture.mp4',
    outputObjectKey: null,
    srtObjectKey: null,
    contentType: 'video/mp4',
    fileSizeBytes: 123,
    modelId: 'bofenghuang/whisper-large-v3-french-distil-dec16',
    language: 'fr',
    status: 'TRANSCRIBING',
    progress: 0.2,
    durationSec: null,
    processedAudioSec: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    uploadCompletedAt: now,
    startedAt: now,
    completedAt: null,
    expiresAt: null,
    workerRunId: 'run_1',
    callbackTokenHash: 'hash_1',
    callbackTokenExpiresAt: new Date(now.getTime() + 3600_000),
    kaggleKernelRef: 'alice/chep-job-1',
    kaggleShard1Ref: null,
    dualMode: false,
    shard0Done: false,
    shard1Done: false,
    storageCleanedAt: null,
    ...overrides,
  };
}

test('reconcileStalledKaggleJobs handles error, cancelAcknowledged, missed complete, and timed-out jobs', async () => {
  const previousKey = process.env.KAGGLE_TOKEN_ENCRYPTION_KEY;
  process.env.KAGGLE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');

  try {
    const envelope = encryptKaggleSecret(JSON.stringify({ kind: 'bearer', token: 'KGAT_reconcile_token_123' }), {
      aad: 'usr_1',
    });

    const jobs = new Map<string, Job>([
      ['job_err', makeJob({ id: 'job_err', status: 'WORKER_STARTING', kaggleKernelRef: 'alice/k-err' })],
      ['job_can', makeJob({ id: 'job_can', status: 'CANCEL_REQUESTED', kaggleKernelRef: 'alice/k-can' })],
      ['job_cmp', makeJob({ id: 'job_cmp', status: 'FINALIZING', kaggleKernelRef: 'alice/k-cmp' })],
      ['job_tmo', makeJob({
        id: 'job_tmo',
        status: 'TRANSCRIBING',
        kaggleKernelRef: 'alice/k-tmo',
        startedAt: new Date('2026-10-01T00:00:00.000Z'),
      })],
    ]);

    const patches = new Map<string, JobPatch>();
    const deletedPaths: string[] = [];
    let acknowledged = false;
    let queueState = 'RUNNING';

    const fakeRepos = {
      kaggleCredentials: {
        async getKaggleCredentials() {
          return {
            userId: 'usr_1',
            authMode: 'api_token' as const,
            kaggleUsername: 'alice',
            encryptedToken: envelope.encryptedToken,
            tokenIv: envelope.tokenIv,
            tokenAuthTag: envelope.tokenAuthTag,
            gpuStatus: 'unchecked' as const,
            gpuMessage: null,
            gpuCheckedAt: null,
            gpuProbeRef: null,
            connectedAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      jobs: {
        async listStalledKaggleJobs() {
          return Array.from(jobs.values());
        },
        async updateForUser(jobId: string, _userId: string, patch: JobPatch) {
          patches.set(jobId, patch);
          const existing = jobs.get(jobId)!;
          const updated = { ...existing, ...patch };
          jobs.set(jobId, updated);
          return updated;
        },
        async acknowledgeCancellation(jobId: string) {
          acknowledged = true;
          const existing = jobs.get(jobId)!;
          return { job: { ...existing, status: 'CANCELLED' as const }, queueState: 'PAUSED' as const };
        },
      },
      queue: {
        async countQueuedForUser() {
          return 1;
        },
        async setQueueState(_userId: string, state: 'IDLE' | 'RUNNING' | 'PAUSING' | 'PAUSED') {
          queueState = state;
        },
      },
    } as unknown as Repositories;

    const fakeStorage = {
      async deleteObject(pathname: string) {
        deletedPaths.push(pathname);
      },
    } as unknown as ObjectStorage;

    const summary = await reconcileStalledKaggleJobs({
      repositories: fakeRepos,
      storage: fakeStorage,
      now: new Date('2026-10-02T14:00:00.000Z').getTime(),
      fetchFn: async (url) => {
        const str = String(url);
        if (str.includes('k-err')) return Response.json({ status: 'ERROR', failureMessage: 'Out of memory' });
        if (str.includes('k-can')) return Response.json({ status: 'CANCEL_ACKNOWLEDGED' });
        if (str.includes('k-cmp')) return Response.json({ status: 'COMPLETE' });
        if (str.includes('k-tmo')) return Response.json({ status: 'RUNNING' });
        return Response.json({ ok: true });
      },
    });

    assert.equal(summary.checked, 4);
    assert.equal(summary.updated, 4);
    assert.equal(summary.errors.length, 0);
    assert.equal(patches.get('job_err')?.status, 'FAILED_WORKER_START');
    assert.equal(patches.get('job_err')?.callbackTokenHash, null);
    assert.equal(acknowledged, true);
    assert.deepEqual(deletedPaths, ['users/usr_1/jobs/job_1/source/lecture.mp4']);
    assert.equal(patches.get('job_cmp')?.status, 'FAILED_OUTPUT');
    assert.equal(patches.get('job_tmo')?.status, 'FAILED_INFERENCE');
    assert.equal(queueState, 'PAUSED');
  } finally {
    if (previousKey === undefined) delete process.env.KAGGLE_TOKEN_ENCRYPTION_KEY;
    else process.env.KAGGLE_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});
