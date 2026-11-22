import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { HttpError } from '../../server/http/responses';
import { decryptKaggleSecret, encryptKaggleSecret, parseEncryptionKey } from '../../server/kaggle/crypto';

test('parseEncryptionKey supports 32-byte base64 and 64-char hex keys', () => {
  const raw = randomBytes(32);
  assert.deepEqual(parseEncryptionKey(raw.toString('base64')), raw);
  assert.deepEqual(parseEncryptionKey(raw.toString('hex')), raw);

  assert.throws(
    () => parseEncryptionKey(''),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
  assert.throws(
    () => parseEncryptionKey('too-short'),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
});

test('encryptKaggleSecret and decryptKaggleSecret round-trip with unique IVs and reject tampering', () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ kind: 'bearer', token: 'KGAT_super_secret_token_value' });

  const first = encryptKaggleSecret(plaintext, { aad: 'usr_123', key });
  const second = encryptKaggleSecret(plaintext, { aad: 'usr_123', key });

  assert.notEqual(first.tokenIv, second.tokenIv);
  assert.notEqual(first.encryptedToken, second.encryptedToken);
  assert.equal(first.encryptedToken.includes('KGAT_'), false);

  assert.equal(decryptKaggleSecret(first, { aad: 'usr_123', key }), plaintext);
  assert.equal(decryptKaggleSecret(second, { aad: 'usr_123', key }), plaintext);

  assert.throws(
    () => decryptKaggleSecret(first, { aad: 'usr_other', key }),
    (error: unknown) => error instanceof HttpError && error.code === 'KAGGLE_DECRYPT_FAILED',
  );

  const tamperedCiphertext = Buffer.from(first.encryptedToken, 'base64');
  tamperedCiphertext[0] ^= 0xff;
  assert.throws(
    () => decryptKaggleSecret({ ...first, encryptedToken: tamperedCiphertext.toString('base64') }, { aad: 'usr_123', key }),
    (error: unknown) => error instanceof HttpError && error.code === 'KAGGLE_DECRYPT_FAILED',
  );

  const tamperedTag = Buffer.from(first.tokenAuthTag, 'base64');
  tamperedTag[0] ^= 0xff;
  assert.throws(
    () => decryptKaggleSecret({ ...first, tokenAuthTag: tamperedTag.toString('base64') }, { aad: 'usr_123', key }),
    (error: unknown) => error instanceof HttpError && error.code === 'KAGGLE_DECRYPT_FAILED',
  );
});
