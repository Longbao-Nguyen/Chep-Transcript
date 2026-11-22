import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import type { Repositories } from '../../server/db/interface';
import { HttpError } from '../../server/http/responses';
import {
  ApiTokenAuthProvider,
  OAuth2AuthProvider,
  buildKaggleAuthHeadersFromSecret,
  getKaggleAuthProvider,
  isKaggleOAuthEnabled,
  parseKaggleConnectInput,
} from '../../server/kaggle/auth';
import { encryptKaggleSecret } from '../../server/kaggle/crypto';

test('parseKaggleConnectInput supports KGAT_ tokens, kaggle.json, and username/key pairs', () => {
  const bearer = parseKaggleConnectInput({ apiToken: 'KGAT_0123456789abcdef', username: 'alice_1' });
  assert.deepEqual(bearer, {
    secret: { kind: 'bearer', token: 'KGAT_0123456789abcdef' },
    username: 'alice_1',
  });
  assert.deepEqual(buildKaggleAuthHeadersFromSecret(bearer.secret), {
    Authorization: 'Bearer KGAT_0123456789abcdef',
  });

  const fromJson = parseKaggleConnectInput({ apiToken: '{"username":"bob","key":"secretkey1234"}' });
  assert.deepEqual(fromJson, {
    secret: { kind: 'basic', username: 'bob', key: 'secretkey1234' },
    username: 'bob',
  });

  const legacyPair = parseKaggleConnectInput({ username: 'carol', apiKey: 'legacykey1234' });
  assert.deepEqual(legacyPair, {
    secret: { kind: 'basic', username: 'carol', key: 'legacykey1234' },
    username: 'carol',
  });
  assert.deepEqual(buildKaggleAuthHeadersFromSecret(legacyPair.secret), {
    Authorization: `Basic ${Buffer.from('carol:legacykey1234').toString('base64')}`,
  });

  assert.throws(
    () => parseKaggleConnectInput({ apiToken: 'KGAT_short' }),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  assert.throws(
    () => parseKaggleConnectInput({ apiToken: 'non-kgat-without-username' }),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test('ApiTokenAuthProvider decrypts stored credentials and OAuth2AuthProvider respects feature flag', async () => {
  const previousKey = process.env.KAGGLE_TOKEN_ENCRYPTION_KEY;
  const previousOAuth = process.env.KAGGLE_OAUTH_ENABLED;
  const previousClientId = process.env.KAGGLE_OAUTH_CLIENT_ID;
  const previousRedirect = process.env.KAGGLE_OAUTH_REDIRECT_URI;

  const rawKey = randomBytes(32).toString('base64');
  process.env.KAGGLE_TOKEN_ENCRYPTION_KEY = rawKey;
  delete process.env.KAGGLE_OAUTH_ENABLED;

  try {
    const envelope = encryptKaggleSecret(JSON.stringify({ kind: 'bearer', token: 'KGAT_stored_token_12345' }), {
      aad: 'usr_1',
    });
    const fakeRepos = {
      kaggleCredentials: {
        async getKaggleCredentials(userId: string) {
          if (userId !== 'usr_1') return null;
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
    } as unknown as Repositories;

    const provider = getKaggleAuthProvider('api_token', fakeRepos);
    assert.equal(provider instanceof ApiTokenAuthProvider, true);
    assert.equal(provider.isConfigured(), true);
    const context = await provider.getKaggleAuthContext('usr_1');
    assert.equal(context.username, 'alice');
    assert.deepEqual(context.headers, { Authorization: 'Bearer KGAT_stored_token_12345' });

    await assert.rejects(
      () => provider.getKaggleAuthHeaders('usr_missing'),
      (error: unknown) => error instanceof HttpError && error.code === 'KAGGLE_NOT_CONNECTED',
    );

    assert.equal(isKaggleOAuthEnabled(), false);
    const oauth = getKaggleAuthProvider('oauth2', fakeRepos);
    assert.equal(oauth instanceof OAuth2AuthProvider, true);
    assert.equal(oauth.isConfigured(), false);
    await assert.rejects(
      () => oauth.getKaggleAuthHeaders('usr_1'),
      (error: unknown) => error instanceof HttpError && error.status === 501,
    );

    process.env.KAGGLE_OAUTH_ENABLED = 'true';
    process.env.KAGGLE_OAUTH_CLIENT_ID = 'org:french-transcript';
    process.env.KAGGLE_OAUTH_REDIRECT_URI = 'https://app.example.com/api/kaggle/callback';
    assert.equal(isKaggleOAuthEnabled(), true);
    assert.equal(oauth.isConfigured(), true);
  } finally {
    if (previousKey === undefined) delete process.env.KAGGLE_TOKEN_ENCRYPTION_KEY;
    else process.env.KAGGLE_TOKEN_ENCRYPTION_KEY = previousKey;
    if (previousOAuth === undefined) delete process.env.KAGGLE_OAUTH_ENABLED;
    else process.env.KAGGLE_OAUTH_ENABLED = previousOAuth;
    if (previousClientId === undefined) delete process.env.KAGGLE_OAUTH_CLIENT_ID;
    else process.env.KAGGLE_OAUTH_CLIENT_ID = previousClientId;
    if (previousRedirect === undefined) delete process.env.KAGGLE_OAUTH_REDIRECT_URI;
    else process.env.KAGGLE_OAUTH_REDIRECT_URI = previousRedirect;
  }
});
