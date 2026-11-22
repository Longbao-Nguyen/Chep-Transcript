import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError } from '../../server/http/responses';
import { cancelKernel, getKernelStatus, pushKernel, verifyCredentials } from '../../server/kaggle/client';

test('verifyCredentials handles valid, invalid, and unavailable responses without leaking headers', async () => {
  const valid = await verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
    fetchFn: async () => Response.json([{ ref: 'alice/demo-kernel' }]),
  });
  assert.deepEqual(valid, { valid: true, username: 'alice' });

  const rejected = await verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
    fetchFn: async () => new Response('unauthorized', { status: 401 }),
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.username, null);

  await assert.rejects(
    () => verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
      fetchFn: async () => { throw new Error('network down Bearer KGAT_secret_123456'); },
    }),
    (error: unknown) => error instanceof HttpError && error.status === 502 && !error.message.includes('KGAT_secret_123456'),
  );
});

test('pushKernel, getKernelStatus, and cancelKernel interact with Kaggle API payloads cleanly', async () => {
  const pushResult = await pushKernel(
    { Authorization: 'Bearer KGAT_1234567890abcdef' },
    {
      slug: 'alice/chep-job-1',
      notebook: { nbformat: 4, nbformat_minor: 5, cells: [] },
      datasetDataSources: ['french-transcript/french-whisper-ct2/1'],
    },
    {
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.slug, 'alice/chep-job-1');
        assert.equal(body.enableGpu, true);
        assert.equal(body.accelerator, 'NvidiaTeslaT4');
        assert.deepEqual(body.datasetDataSources, ['french-transcript/french-whisper-ct2/1']);
        return Response.json({ ref: 'alice/chep-job-1', url: 'https://www.kaggle.com/code/alice/chep-job-1', versionNumber: 1 });
      },
    },
  );
  assert.equal(pushResult.ref, 'alice/chep-job-1');
  assert.equal(pushResult.versionNumber, 1);

  const statusResult = await getKernelStatus({ Authorization: 'Bearer KGAT_1234567890abcdef' }, 'alice/chep-job-1', {
    fetchFn: async () => Response.json({ status: 'KernelWorkerStatus.RUNNING', failureMessage: '' }),
  });
  assert.equal(statusResult.status, 'running');

  const cancelled = await cancelKernel({ Authorization: 'Bearer KGAT_1234567890abcdef' }, 'alice/chep-job-1', {
    fetchFn: async (url) => {
      if (String(url).endsWith('/kernels/cancel')) {
        return new Response('Method Not Allowed', { status: 405 });
      }
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(cancelled, { cancelled: true, method: 'delete' });
});
