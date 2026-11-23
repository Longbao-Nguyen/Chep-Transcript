import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError } from '../../server/http/responses';
import {
  cancelKernel,
  getKernelStatus,
  normalizeKaggleKernelStatus,
  pushKernel,
  verifyCredentials,
} from '../../server/kaggle/client';

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

test('normalizeKaggleKernelStatus, pushKernel ref normalization, and getKernelStatus handle Kaggle variants', async () => {
  assert.equal(normalizeKaggleKernelStatus('COMPLETE'), 'complete');
  assert.equal(normalizeKaggleKernelStatus('KernelWorkerStatus.COMPLETE'), 'complete');
  assert.equal(normalizeKaggleKernelStatus('KERNEL_WORKER_STATUS_COMPLETE'), 'complete');
  assert.equal(normalizeKaggleKernelStatus('KERNEL_WORKER_STATUS_CANCEL_ACKNOWLEDGED'), 'cancelAcknowledged');
  assert.equal(normalizeKaggleKernelStatus(1), 'queued');
  assert.equal(normalizeKaggleKernelStatus(2), 'running');
  assert.equal(normalizeKaggleKernelStatus(3), 'complete');
  assert.equal(normalizeKaggleKernelStatus(4), 'error');
  assert.equal(normalizeKaggleKernelStatus(6), 'cancelAcknowledged');

  const slashPush = await pushKernel(
    { Authorization: 'Bearer KGAT_1234567890abcdef' },
    {
      slug: 'alice/chep-job-slash',
      notebook: { nbformat: 4, nbformat_minor: 5, cells: [] },
    },
    {
      fetchFn: async () => Response.json({ ref: '/alice/chep-job-slash/' }),
    },
  );
  assert.equal(slashPush.ref, 'alice/chep-job-slash');

  const slugOnlyPush = await pushKernel(
    { Authorization: 'Bearer KGAT_1234567890abcdef' },
    {
      slug: 'alice/chep-job-slugonly',
      notebook: { nbformat: 4, nbformat_minor: 5, cells: [] },
    },
    {
      fetchFn: async () => Response.json({ ref: 'chep-job-slugonly' }),
    },
  );
  assert.equal(slugOnlyPush.ref, 'alice/chep-job-slugonly');

  const numericStatus = await getKernelStatus(
    { Authorization: 'Bearer KGAT_1234567890abcdef' },
    '/alice/chep-job-slash/',
    {
      fetchFn: async (url) => {
        assert.equal(
          String(url),
          'https://www.kaggle.com/api/v1/kernels/status?userName=alice&kernelSlug=chep-job-slash',
        );
        return Response.json({ status: 3 });
      },
    },
  );
  assert.equal(numericStatus.status, 'complete');
  assert.equal(numericStatus.rawStatus, '3');

  const prefixedStatus = await getKernelStatus(
    { Authorization: 'Bearer KGAT_1234567890abcdef' },
    'alice/chep-job-slash',
    {
      fetchFn: async () => Response.json({ status: 'KERNEL_WORKER_STATUS_COMPLETE' }),
    },
  );
  assert.equal(prefixedStatus.status, 'complete');

  const nullableComplete = await getKernelStatus(
    { Authorization: 'Bearer KGAT_1234567890abcdef' },
    'alice/chep-job-slash',
    {
      fetchFn: async () => Response.json({ statusNullable: 'COMPLETE', failureMessageNullable: null }),
    },
  );
  assert.deepEqual(nullableComplete, { status: 'complete', rawStatus: 'COMPLETE', failureMessage: null });

  const nullableError = await getKernelStatus(
    { Authorization: 'Bearer KGAT_1234567890abcdef' },
    'alice/chep-job-slash',
    {
      fetchFn: async () => Response.json({
        statusNullable: 'ERROR',
        failureMessageNullable: 'GPU quota exceeded',
      }),
    },
  );
  assert.deepEqual(nullableError, {
    status: 'error',
    rawStatus: 'ERROR',
    failureMessage: 'GPU quota exceeded',
  });
});
