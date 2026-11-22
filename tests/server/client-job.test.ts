import assert from 'node:assert/strict';
import test from 'node:test';

import type { Job } from '../../server/db/interface';
import { toClientJob } from '../../server/jobs/public';

test('client job contract does not expose ownership or storage pathnames', () => {
  const now = new Date('2026-10-02T00:00:00.000Z');
  const job: Job = {
    id: 'job_1',
    userId: 'usr_secret',
    originalFilename: 'lecture.mp4',
    sourceObjectKey: 'users/usr_secret/jobs/job_1/source/lecture.mp4',
    outputObjectKey: null,
    srtObjectKey: 'users/usr_secret/jobs/job_1/output/transcript.srt',
    contentType: 'video/mp4',
    fileSizeBytes: 123,
    modelId: 'bofenghuang/whisper-large-v3-french-distil-dec16',
    language: 'fr',
    status: 'QUEUED',
    progress: 0,
    durationSec: null,
    processedAudioSec: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    uploadCompletedAt: now,
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    workerRunId: null,
    callbackTokenHash: 'secret_sha256_hash',
    callbackTokenExpiresAt: now,
    kaggleKernelRef: 'alice/chep-job-1',
    kaggleShard1Ref: 'alice/chep-job-1-s1',
    dualMode: true,
    shard0Done: false,
    shard1Done: false,
    storageCleanedAt: null,
  };
  const client = toClientJob(job) as unknown as Record<string, unknown>;
  assert.equal('userId' in client, false);
  assert.equal('sourceObjectKey' in client, false);
  assert.equal('outputObjectKey' in client, false);
  assert.equal('srtObjectKey' in client, false);
  assert.equal('callbackTokenHash' in client, false);
  assert.equal('callbackTokenExpiresAt' in client, false);
  assert.equal('kaggleKernelRef' in client, false);
  assert.equal('kaggleShard1Ref' in client, false);
  assert.equal('storageCleanedAt' in client, false);
  assert.equal(client.hasSrt, true);
  assert.equal(client.dualMode, true);
  assert.equal(client.modelId, 'bofenghuang/whisper-large-v3-french-distil-dec16');
  assert.equal(client.language, 'fr');
});
