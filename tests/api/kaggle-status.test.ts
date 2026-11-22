import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { DELETE, GET, POST } from '../../api/kaggle/[action]';
import { signAnonymousToken } from '../../server/auth/anonymous';
import { setRepositoriesForTests } from '../../server/db/index';
import type { KaggleCredentialsRecord, Repositories, UpsertKaggleCredentialsInput } from '../../server/db/interface';

function createSessionCookie(secret: string, userId = 'usr_anon_0123456789abcdefabcd'): string {
  const token = signAnonymousToken(userId, secret);
  return `chep_anon_session=${encodeURIComponent(token)}`;
}

test('Kaggle connection endpoints require authentication and manage encrypted API tokens safely', async () => {
  const previousSecret = process.env.AUTH_SECRET;
  const previousKey = process.env.KAGGLE_TOKEN_ENCRYPTION_KEY;
  process.env.AUTH_SECRET = 'test-only-session-secret';
  process.env.KAGGLE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');

  const userId = 'usr_anon_0123456789abcdefabcd';
  let storedRecord: KaggleCredentialsRecord | null = null;

  const fakeRepos = {
    users: {
      async getById(id: string) {
        if (id !== userId) return null;
        return {
          id: userId,
          email: `${userId}@anonymous.chep.local`,
          displayName: 'Anonymous Guest',
          imageUrl: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    kaggleCredentials: {
      async getKaggleCredentials(uid: string) {
        return uid === userId ? storedRecord : null;
      },
      async upsertKaggleCredentials(input: UpsertKaggleCredentialsInput) {
        storedRecord = {
          ...input,
          gpuStatus: 'unchecked',
          gpuMessage: null,
          gpuCheckedAt: null,
          gpuProbeRef: null,
          connectedAt: new Date('2026-10-02T00:00:00.000Z'),
          updatedAt: new Date('2026-10-02T00:00:00.000Z'),
        };
        return storedRecord;
      },
      async updateGpuCheck(uid: string, patch) {
        if (uid !== userId || !storedRecord) return null;
        storedRecord = {
          ...storedRecord,
          gpuStatus: patch.gpuStatus,
          gpuMessage: patch.gpuMessage,
          gpuCheckedAt: patch.gpuCheckedAt ?? null,
          gpuProbeRef: patch.gpuProbeRef ?? null,
          updatedAt: new Date(),
        };
        return storedRecord;
      },
      async deleteKaggleCredentials(uid: string) {
        if (uid === userId) storedRecord = null;
      },
    },
  } as unknown as Repositories;

  setRepositoriesForTests(fakeRepos);
  const originalFetch = globalThis.fetch;

  try {
    // 1. Unauthenticated requests rejected
    const unauthStatus = await GET(new Request('https://example.test/api/kaggle/status'));
    assert.equal(unauthStatus.status, 401);
    assert.equal(unauthStatus.headers.get('cache-control'), 'no-store');

    const cookie = createSessionCookie(process.env.AUTH_SECRET, userId);

    // 2. Initial status reports disconnected
    const initialRes = await GET(new Request('https://example.test/api/kaggle/status', {
      headers: { cookie },
    }));
    assert.equal(initialRes.status, 200);
    const initialJson = await initialRes.json();
    assert.equal(initialJson.connected, false);
    assert.equal(initialJson.oauthEnabled, false);

    // 3. Invalid Kaggle token rejected with 401
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    const invalidRes = await POST(new Request('https://example.test/api/kaggle/connect', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://example.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiToken: 'KGAT_invalid_token_123456' }),
    }));
    assert.equal(invalidRes.status, 401);
    assert.equal(storedRecord, null);

    // 4. Valid Kaggle token stored encrypted and never exposed in response
    globalThis.fetch = async () => Response.json([{ ref: 'alice/test-notebook' }]);
    const rawToken = 'KGAT_valid_secret_token_987654';
    const connectRes = await POST(new Request('https://example.test/api/kaggle/connect', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://example.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiToken: rawToken }),
    }));
    assert.equal(connectRes.status, 200);
    const connectText = await connectRes.text();
    assert.equal(connectText.includes(rawToken), false);
    assert.equal(connectText.includes('encryptedToken'), false);

    const connectJson = JSON.parse(connectText);
    assert.equal(connectJson.connected, true);
    assert.equal(connectJson.username, 'alice');
    assert.equal(connectJson.authMode, 'api_token');
    assert.ok(storedRecord !== null);
    assert.equal(storedRecord!.encryptedToken.includes(rawToken), false);

    // 5. Status returns connected without token
    const statusRes = await GET(new Request('https://example.test/api/kaggle/status', {
      headers: { cookie },
    }));
    const statusText = await statusRes.text();
    assert.equal(statusText.includes(rawToken), false);
    assert.equal(JSON.parse(statusText).connected, true);

    // 6. Disconnect removes stored credentials
    const disconnectRes = await DELETE(new Request('https://example.test/api/kaggle/disconnect', {
      method: 'DELETE',
      headers: { cookie, origin: 'https://example.test' },
    }));
    assert.equal(disconnectRes.status, 200);
    assert.equal(JSON.parse(await disconnectRes.text()).connected, false);
    assert.equal(storedRecord, null);
  } finally {
    setRepositoriesForTests(undefined);
    globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.KAGGLE_TOKEN_ENCRYPTION_KEY;
    else process.env.KAGGLE_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});
