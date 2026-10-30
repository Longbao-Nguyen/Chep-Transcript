import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from '../../api/jobs';

test('Kaggle availability requires an authenticated session and is not cached', async () => {
  const previous = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'test-only-session-secret';
  try {
    const response = await GET(new Request('https://example.test/api/jobs?view=kaggle-status'));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    assert.equal(payload.error.code, 'UNAUTHENTICATED');
  } finally {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  }
});
