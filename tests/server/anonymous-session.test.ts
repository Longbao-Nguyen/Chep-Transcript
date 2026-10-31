import assert from 'node:assert/strict';
import test from 'node:test';

import { POST } from '../../api/auth/[...auth]';
import { getAnonymousCookie, signAnonymousToken, verifyAnonymousToken } from '../../server/auth/anonymous';

test('guest token is bound to its secret and rejects malformed cookies', () => {
  const token = signAnonymousToken('usr_anon_0123456789abcdefabcd', 'private-test-secret');
  assert.deepEqual(verifyAnonymousToken(token, 'private-test-secret'), { userId: 'usr_anon_0123456789abcdefabcd' });
  assert.equal(verifyAnonymousToken(token, 'different-secret'), null);
  assert.equal(verifyAnonymousToken(token.replace('usr_anon_', 'usr_other_'), 'private-test-secret'), null);
  assert.equal(getAnonymousCookie(new Request('https://example.com', { headers: { cookie: 'chep_anon_session=%ZZ' } })), null);
});

test('guest reset requires same-origin POST and clears the HttpOnly cookie', async () => {
  const url = 'https://example.com/api/auth/guest/reset';
  const rejected = await POST(new Request(url, { method: 'POST', headers: { origin: 'https://attacker.example' } }));
  assert.equal(rejected.status, 403);
  const accepted = await POST(new Request(url, { method: 'POST', headers: { origin: 'https://example.com' } }));
  assert.equal(accepted.status, 204);
  assert.match(accepted.headers.get('set-cookie') || '', /Max-Age=0; HttpOnly/);
});
