import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from '../../api/cron/cleanup';
import { setRepositoriesForTests } from '../../server/db/index';
import type { Job, JobPatch, Repositories } from '../../server/db/interface';
import { getJobRetentionHours, runCleanupJob } from '../../server/jobs/cleanup';
import { setObjectStorageForTests } from '../../server/storage/index';
import type { ObjectStorage } from '../../server/storage/interface';

function makeJob(overrides: Partial<Job>): Job {
  const now = new Date('2026-10-01T00:00:00.000Z');
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
    status: 'UPLOADING',
    progress: 0,
    durationSec: null,
    processedAudioSec: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    uploadCompletedAt: null,
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    workerRunId: null,
    callbackTokenHash: null,
    callbackTokenExpiresAt: null,
    kaggleKernelRef: null,
    kaggleShard1Ref: null,
    dualMode: false,
    shard0Done: false,
    shard1Done: false,
    storageCleanedAt: null,
    ...overrides,
  };
}

test('GET /api/cron/cleanup enforces CRON_SECRET authorization', async () => {
  const previousSecret = process.env.CRON_SECRET;

  try {
    delete process.env.CRON_SECRET;
    const unconfigured = await GET(new Request('https://example.test/api/cron/cleanup'));
    assert.equal(unconfigured.status, 503);

    process.env.CRON_SECRET = 'super-secret-cron-value';
    const missingAuth = await GET(new Request('https://example.test/api/cron/cleanup'));
    assert.equal(missingAuth.status, 401);

    const wrongAuth = await GET(new Request('https://example.test/api/cron/cleanup', {
      headers: { authorization: 'Bearer wrong-secret' },
    }));
    assert.equal(wrongAuth.status, 401);

    const fakeRepos = {
      jobs: {
        async listAbandonedUploads() { return []; },
        async listRetentionExpiredJobs() { return []; },
        async listStalledKaggleJobs() { return []; },
      },
    } as unknown as Repositories;
    const fakeStorage = {} as ObjectStorage;
    setRepositoriesForTests(fakeRepos);
    setObjectStorageForTests(fakeStorage);

    const authorized = await GET(new Request('https://example.test/api/cron/cleanup', {
      headers: { authorization: 'Bearer super-secret-cron-value' },
    }));
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('cache-control'), 'no-store');
    const summary = await authorized.json();
    assert.equal(summary.abandonedCleaned, 0);
    assert.equal(summary.expiredCleaned, 0);
  } finally {
    setRepositoriesForTests(undefined);
    setObjectStorageForTests(undefined);
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test('runCleanupJob removes abandoned uploads, retention-expired artifacts, and tolerates individual errors', async () => {
  const previousRetention = process.env.JOB_RETENTION_HOURS;
  process.env.JOB_RETENTION_HOURS = '48';
  assert.equal(getJobRetentionHours(), 48);

  try {
    const abandonedJob = makeJob({ id: 'job_abandoned', status: 'UPLOADING' });
    const expiredCompleted = makeJob({
      id: 'job_completed',
      status: 'COMPLETED',
      outputObjectKey: 'users/usr_1/jobs/job_completed/output/transcript.txt',
      completedAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    const expiredCancelled = makeJob({
      id: 'job_cancelled',
      status: 'CANCELLED',
      completedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const failingDeleteJob = makeJob({
      id: 'job_storage_err',
      status: 'FAILED_MEDIA',
      sourceObjectKey: 'users/usr_1/jobs/job_storage_err/source/fail.mp4',
    });

    const patches = new Map<string, JobPatch>();
    const deleted: string[] = [];

    const fakeRepos = {
      jobs: {
        async listAbandonedUploads() {
          return [abandonedJob];
        },
        async listRetentionExpiredJobs() {
          return [expiredCompleted, expiredCancelled, failingDeleteJob];
        },
        async updateForUser(jobId: string, _userId: string, patch: JobPatch) {
          patches.set(jobId, patch);
          return makeJob({ id: jobId, ...patch });
        },
      },
    } as unknown as Repositories;

    const fakeStorage = {
      async deleteObject(pathname: string) {
        if (pathname.includes('fail.mp4')) {
          throw new Error('Transient blob error');
        }
        deleted.push(pathname);
      },
    } as unknown as ObjectStorage;

    const summary = await runCleanupJob({
      repositories: fakeRepos,
      storage: fakeStorage,
      now: new Date('2026-10-03T12:00:00.000Z').getTime(),
      reconcileStalled: false,
    });

    assert.equal(summary.abandonedCleaned, 1);
    assert.equal(summary.expiredCleaned, 2);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].jobId, 'job_storage_err');

    assert.equal(patches.get('job_abandoned')?.status, 'FAILED_UPLOAD');
    assert.equal(patches.get('job_abandoned')?.errorCode, 'UPLOAD_EXPIRED');
    assert.ok(patches.get('job_abandoned')?.storageCleanedAt instanceof Date);

    assert.equal(patches.get('job_completed')?.status, 'EXPIRED');
    assert.equal(patches.get('job_completed')?.outputObjectKey, null);
    assert.ok(patches.get('job_completed')?.storageCleanedAt instanceof Date);

    assert.equal(patches.get('job_cancelled')?.status, undefined);
    assert.ok(patches.get('job_cancelled')?.storageCleanedAt instanceof Date);

    assert.deepEqual(deleted, [
      'users/usr_1/jobs/job_1/source/lecture.mp4',
      'users/usr_1/jobs/job_1/source/lecture.mp4',
      'users/usr_1/jobs/job_completed/output/transcript.txt',
      'users/usr_1/jobs/job_1/source/lecture.mp4',
    ]);
  } finally {
    if (previousRetention === undefined) delete process.env.JOB_RETENTION_HOURS;
    else process.env.JOB_RETENTION_HOURS = previousRetention;
  }
});
