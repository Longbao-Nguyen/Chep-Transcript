import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { HttpError } from '../http/responses.js';

export interface EncryptedSecretEnvelope {
  encryptedToken: string;
  tokenIv: string;
  tokenAuthTag: string;
}

export interface CryptoOptions {
  aad?: string;
  key?: Buffer;
}

export function parseEncryptionKey(raw = process.env.KAGGLE_TOKEN_ENCRYPTION_KEY): Buffer {
  const value = raw?.trim();
  if (!value) {
    throw new HttpError(503, 'Kaggle token encryption is not configured.', 'KAGGLE_ENCRYPTION_NOT_CONFIGURED');
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
      return decoded;
    }
  }

  throw new HttpError(503, 'Kaggle token encryption key must be 32 bytes (base64 or hex).', 'KAGGLE_ENCRYPTION_NOT_CONFIGURED');
}

export function encryptKaggleSecret(plaintext: string, options: CryptoOptions = {}): EncryptedSecretEnvelope {
  const key = options.key ?? parseEncryptionKey();
  if (key.length !== 32) {
    throw new HttpError(503, 'Kaggle token encryption key must be 32 bytes.', 'KAGGLE_ENCRYPTION_NOT_CONFIGURED');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (options.aad) {
    cipher.setAAD(Buffer.from(options.aad, 'utf8'));
  }

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedToken: encrypted.toString('base64'),
    tokenIv: iv.toString('base64'),
    tokenAuthTag: authTag.toString('base64'),
  };
}

export function decryptKaggleSecret(envelope: EncryptedSecretEnvelope, options: CryptoOptions = {}): string {
  const key = options.key ?? parseEncryptionKey();
  if (key.length !== 32) {
    throw new HttpError(503, 'Kaggle token encryption key must be 32 bytes.', 'KAGGLE_ENCRYPTION_NOT_CONFIGURED');
  }

  const iv = Buffer.from(envelope.tokenIv, 'base64');
  const authTag = Buffer.from(envelope.tokenAuthTag, 'base64');
  const ciphertext = Buffer.from(envelope.encryptedToken, 'base64');

  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new HttpError(500, 'Stored Kaggle credentials are malformed.', 'KAGGLE_DECRYPT_FAILED');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (options.aad) {
      decipher.setAAD(Buffer.from(options.aad, 'utf8'));
    }
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new HttpError(500, 'Stored Kaggle credentials could not be decrypted.', 'KAGGLE_DECRYPT_FAILED');
  }
}
