import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError } from '../../server/http/responses';
import { cancelKernel, getKernelStatus, pushKernel, verifyCredentials } from '../../server/kaggle/client';

test('verifyCredentials verifies via /hello, resolves username via group=profile when needed, and never leaks tokens', async () => {
  const seenUrls: string[] = [];
  const validDirect = await verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
    fetchFn: async (url) => {
      seenUrls.push(String(url));
      return Response.json({ userName: 'alice' });
    },
  });
  assert.deepEqual(validDirect, { valid: true, username: 'alice' });
  assert.equal(seenUrls[0], 'https://www.kaggle.com/api/v1/hello');

  const fallbackUrls: string[] = [];
  const validWithLookup = await verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
    fetchFn: async (url) => {
      const target = String(url);
      fallbackUrls.push(target);
      assert.equal(target.includes('mine='), false);
      if (target.endsWith('/hello')) return Response.json({ ok: true });
      return Response.json([{ ref: 'alice/demo-kernel' }]);
    },
  });
  assert.deepEqual(validWithLookup, { valid: true, username: 'alice' });
  assert.deepEqual(fallbackUrls, [
    'https://www.kaggle.com/api/v1/hello',
    'https://www.kaggle.com/api/v1/kernels/list?group=profile&pageSize=1',
  ]);

  const validFrom404 = await verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
    fetchFn: async (url) => {
      const target = String(url);
      assert.equal(target.includes('mine='), false);
      if (target.endsWith('/hello')) return new Response('not found', { status: 404 });
      return Response.json([{ author: 'alice' }]);
    },
  });
  assert.deepEqual(validFrom404, { valid: true, username: 'alice' });

  const rejected = await verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
    fetchFn: async () => new Response('unauthorized', { status: 401 }),
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.username, null);

  await assert.rejects(
    () => verifyCredentials({ Authorization: 'Bearer KGAT_secret_123456' }, null, {
      fetchFn: async () => new Response(JSON.stringify({ message: 'Upstream failure' }), { status: 500 }),
    }),
    (error: unknown) => error instanceof HttpError && error.status === 502 && error.message.includes('500') && error.message.includes('Upstream failure'),
  );

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
