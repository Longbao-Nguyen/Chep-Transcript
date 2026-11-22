import assert from 'node:assert/strict';
import test from 'node:test';

import type { Job } from '../../server/db/interface';
import { HttpError } from '../../server/http/responses';
import { canTransitionJob } from '../../server/jobs/state';
import { generateJobCallbackToken, verifyJobCallbackToken } from '../../server/worker/callback-auth';

function activeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date('2026-10-02T00:00:00.000Z');
  return {
    id: 'job_a',
    userId: 'usr_a',
    originalFilename: 'lecture.mp4',
    sourceObjectKey: 'users/usr_a/jobs/job_a/source/lecture.mp4',
    outputObjectKey: null,
    srtObjectKey: null,
    contentType: 'video/mp4',
    fileSizeBytes: 123,
    modelId: 'bofenghuang/whisper-large-v3-french-distil-dec16',
    language: 'fr',
    status: 'TRANSCRIBING',
    progress: 0.5,
    durationSec: 60,
    processedAudioSec: 30,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    uploadCompletedAt: now,
    startedAt: now,
    completedAt: null,
    expiresAt: null,
    workerRunId: 'run_a',
    callbackTokenHash: null,
    callbackTokenExpiresAt: null,
    kaggleKernelRef: 'alice/chep-job-a',
    kaggleShard1Ref: null,
    dualMode: false,
    shard0Done: false,
    shard1Done: false,
    storageCleanedAt: null,
    ...overrides,
  };
}

test('job state machine requires acknowledgement after active cancellation', () => {
  for (const phase of ['PROCESSING', 'WORKER_STARTING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING'] as const) {
    assert.equal(canTransitionJob(phase, 'CANCEL_REQUESTED'), true);
    assert.equal(canTransitionJob(phase, 'CANCELLED'), false);
  }
  assert.equal(canTransitionJob('CANCEL_REQUESTED', 'CANCELLED'), true);
  assert.equal(canTransitionJob('QUEUED', 'CANCELLED'), true);
  assert.equal(canTransitionJob('COMPLETED', 'CANCELLED'), false);
});

test('per-job callback token validates matching job and rejects wrong, expired, cross-job, and terminal jobs', () => {
  const now = 1_700_000_000_000;
  const generatedA = generateJobCallbackToken(60_000, now);
  const jobA = activeJob({
    id: 'job_a',
    callbackTokenHash: generatedA.tokenHash,
    callbackTokenExpiresAt: generatedA.expiresAt,
  });

  const generatedB = generateJobCallbackToken(60_000, now);
  const jobB = activeJob({
    id: 'job_b',
    callbackTokenHash: generatedB.tokenHash,
    callbackTokenExpiresAt: generatedB.expiresAt,
  });

  const validRequest = new Request('https://example.test/api/internal/jobs/job_a/cancel-state', {
    headers: { authorization: `Bearer ${generatedA.token}` },
  });
  assert.equal(verifyJobCallbackToken(validRequest, jobA, now + 1_000).id, 'job_a');

  // Missing header
  assert.throws(
    () => verifyJobCallbackToken(new Request('https://example.test'), jobA, now),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );

  // Wrong token
  assert.throws(
    () => verifyJobCallbackToken(
      new Request('https://example.test', { headers: { authorization: `Bearer ${'0'.repeat(64)}` } }),
      jobA,
      now,
    ),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );

  // Cross-job token (Job A token used against Job B)
  assert.throws(
    () => verifyJobCallbackToken(validRequest, jobB, now),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );

  // Expired token
  assert.throws(
    () => verifyJobCallbackToken(validRequest, jobA, now + 60_001),
    (error: unknown) => error instanceof HttpError && error.status === 401 && error.code === 'WORKER_TOKEN_EXPIRED',
  );

  // Terminal job
  assert.throws(
    () => verifyJobCallbackToken(validRequest, { ...jobA, status: 'COMPLETED' }, now),
    (error: unknown) => error instanceof HttpError && error.status === 403 && error.code === 'JOB_TERMINAL',
  );

  // Revoked token (callbackTokenHash cleared)
  assert.throws(
    () => verifyJobCallbackToken(validRequest, { ...jobA, callbackTokenHash: null }, now),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
});
