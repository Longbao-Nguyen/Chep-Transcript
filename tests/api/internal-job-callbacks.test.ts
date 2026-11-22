import assert from 'node:assert/strict';
import test from 'node:test';

import { GET, POST } from '../../api/internal/jobs/[jobId]/[action]';
import { setRepositoriesForTests } from '../../server/db/index';
import type { Job, Repositories } from '../../server/db/interface';
import { setObjectStorageForTests } from '../../server/storage/index';
import type { ObjectStorage } from '../../server/storage/interface';
import { generateJobCallbackToken } from '../../server/worker/callback-auth';

function createJob(id: string, userId: string, tokenHash: string, expiresAt: Date): Job {
  const now = new Date();
  return {
    id,
    userId,
    originalFilename: 'lecture.mp4',
    sourceObjectKey: `users/${userId}/jobs/${id}/source/lecture.mp4`,
    outputObjectKey: null,
    srtObjectKey: null,
    contentType: 'video/mp4',
    fileSizeBytes: 100,
    modelId: 'bofenghuang/whisper-large-v3-french-distil-dec16',
    language: 'fr',
    status: 'WORKER_STARTING',
    progress: 0,
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
    callbackTokenHash: tokenHash,
    callbackTokenExpiresAt: expiresAt,
    kaggleKernelRef: `alice/chep-${id}`,
    kaggleShard1Ref: null,
    dualMode: false,
    shard0Done: false,
    shard1Done: false,
    storageCleanedAt: null,
  };
}

test('internal worker callbacks enforce per-job tokens, prevent cross-job access, and clear token on terminal transition', async () => {
  const tokA = generateJobCallbackToken(60 * 60 * 1000);
  const tokB = generateJobCallbackToken(60 * 60 * 1000);
  const jobs = new Map<string, Job>([
    ['job_a', createJob('job_a', 'usr_a', tokA.tokenHash, tokA.expiresAt)],
    ['job_b', createJob('job_b', 'usr_b', tokB.tokenHash, tokB.expiresAt)],
  ]);

  const storedObjects = new Map<string, string>();
  const deletedObjects: string[] = [];

  const fakeRepos = {
    jobs: {
      async getById(jobId: string) {
        return jobs.get(jobId) ?? null;
      },
      async updateProgressForWorker(jobId: string, userId: string, workerRunId: string, patch: {
        status: 'PREPROCESSING' | 'TRANSCRIBING' | 'FINALIZING';
        progress?: number | null;
        durationSec?: number | null;
        processedAudioSec?: number | null;
      }) {
        const job = jobs.get(jobId);
        if (!job || job.userId !== userId || job.workerRunId !== workerRunId) return null;
        const updated: Job = {
          ...job,
          status: patch.status,
          progress: patch.progress ?? job.progress,
          durationSec: patch.durationSec ?? job.durationSec,
          processedAudioSec: patch.processedAudioSec ?? job.processedAudioSec,
        };
        jobs.set(jobId, updated);
        return updated;
      },
      async completeForWorker(
        jobId: string,
        userId: string,
        workerRunId: string,
        outputKey: string,
        options?: { srtObjectKey?: string | null },
      ) {
        const job = jobs.get(jobId);
        if (!job || job.userId !== userId || job.workerRunId !== workerRunId || job.status !== 'FINALIZING') {
          return null;
        }
        const completed: Job = {
          ...job,
          status: 'COMPLETED',
          progress: 1,
          outputObjectKey: outputKey,
          srtObjectKey: options?.srtObjectKey ?? null,
          completedAt: new Date(),
          callbackTokenHash: null,
          callbackTokenExpiresAt: null,
        };
        jobs.set(jobId, completed);
        return completed;
      },
      async failForWorker(
        jobId: string,
        userId: string,
        workerRunId: string,
        errorCode: Job['errorCode'],
        errorMessage: string,
      ) {
        const job = jobs.get(jobId);
        if (!job || job.userId !== userId || job.workerRunId !== workerRunId) return null;
        const failed: Job = {
          ...job,
          status: errorCode as Job['status'],
          errorCode,
          errorMessage,
          completedAt: new Date(),
          callbackTokenHash: null,
          callbackTokenExpiresAt: null,
        };
        jobs.set(jobId, failed);
        return failed;
      },
    },
    queue: {
      async getStateForUser() {
        return 'RUNNING' as const;
      },
      async countQueuedForUser() {
        return 0;
      },
      async setQueueState() {},
    },
    kaggleCredentials: {
      async getKaggleCredentials() {
        return null;
      },
    },
  } as unknown as Repositories;

  const fakeStorage = {
    async putPrivateObject(pathname: string, body: string) {
      storedObjects.set(pathname, body);
      return { pathname, size: Buffer.byteLength(body), contentType: 'text/plain; charset=utf-8', etag: 'e1' };
    },
    async deleteObject(pathname: string) {
      deletedObjects.push(pathname);
    },
  } as unknown as ObjectStorage;

  setRepositoriesForTests(fakeRepos);
  setObjectStorageForTests(fakeStorage);

  try {
    // 1. Cross-job token rejected
    const crossJob = await GET(new Request('https://example.test/api/internal/jobs/job_b/cancel-state', {
      headers: { authorization: `Bearer ${tokA.token}` },
    }));
    assert.equal(crossJob.status, 401);

    // 2. Wrong token rejected
    const wrongTok = await GET(new Request('https://example.test/api/internal/jobs/job_a/cancel-state', {
      headers: { authorization: `Bearer ${'a'.repeat(64)}` },
    }));
    assert.equal(wrongTok.status, 401);

    // 3. Valid token succeeds on cancel-state & progress
    const stateRes = await GET(new Request('https://example.test/api/internal/jobs/job_a/cancel-state', {
      headers: { authorization: `Bearer ${tokA.token}` },
    }));
    assert.equal(stateRes.status, 200);
    assert.deepEqual(await stateRes.json(), { shouldCancel: false, queueState: 'RUNNING' });

    for (const payload of [
      { status: 'PREPROCESSING', progress: 0.05 },
      { status: 'TRANSCRIBING', progress: 0.5, durationSec: 120, processedAudioSec: 60 },
      { status: 'FINALIZING', progress: 0.98, durationSec: 120, processedAudioSec: 120 },
    ]) {
      const progRes = await POST(new Request('https://example.test/api/internal/jobs/job_a/progress', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokA.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      }));
      assert.equal(progRes.status, 200);
    }

    // 4. Complete persists transcript, clears token hash, deletes source media
    const completeRes = await POST(new Request('https://example.test/api/internal/jobs/job_a/complete', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokA.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transcriptText: '[00:00:00 - 00:00:05] Bonjour.\n',
        subtitleSrt: '1\n00:00:00,000 --> 00:00:05,000\nBonjour.\n\n',
        durationSec: 120,
      }),
    }));
    assert.equal(completeRes.status, 200);
    assert.equal(jobs.get('job_a')?.callbackTokenHash, null);
    assert.equal(storedObjects.get('users/usr_a/jobs/job_a/output/transcript.txt'), '[00:00:00 - 00:00:05] Bonjour.\n');
    assert.equal(
      storedObjects.get('users/usr_a/jobs/job_a/output/transcript.srt'),
      '1\n00:00:00,000 --> 00:00:05,000\nBonjour.\n\n',
    );
    assert.deepEqual(deletedObjects, ['users/usr_a/jobs/job_a/source/lecture.mp4']);

    // 5. Replaying token after completion returns 403
    const replayRes = await GET(new Request('https://example.test/api/internal/jobs/job_a/cancel-state', {
      headers: { authorization: `Bearer ${tokA.token}` },
    }));
    assert.equal(replayRes.status, 403);

    // 6. Fail clears token hash on job_b
    const failRes = await POST(new Request('https://example.test/api/internal/jobs/job_b/fail', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokB.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ errorCode: 'FAILED_MEDIA', errorMessage: 'No audio track' }),
    }));
    assert.equal(failRes.status, 200);
    assert.equal(jobs.get('job_b')?.status, 'FAILED_MEDIA');
    assert.equal(jobs.get('job_b')?.callbackTokenHash, null);
  } finally {
    setRepositoriesForTests(undefined);
    setObjectStorageForTests(undefined);
  }
});
