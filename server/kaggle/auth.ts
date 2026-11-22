import { getRepositories } from '../db/index.js';
import type { KaggleAuthMode, Repositories } from '../db/interface.js';
import { HttpError } from '../http/responses.js';
import { decryptKaggleSecret, parseEncryptionKey } from './crypto.js';

export type StoredKaggleSecret =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; key: string }
  | { kind: 'oauth2'; accessToken: string; refreshToken?: string; expiresAt?: number };

export interface KaggleAuthContext {
  headers: Record<string, string>;
  authMode: KaggleAuthMode;
  username: string | null;
}

export interface KaggleAuthProvider {
  readonly mode: KaggleAuthMode;
  isConfigured(): boolean;
  getKaggleAuthHeaders(userId: string): Promise<Record<string, string>>;
  getKaggleAuthContext(userId: string): Promise<KaggleAuthContext>;
}

export interface ParsedKaggleConnectInput {
  secret: StoredKaggleSecret;
  username: string | null;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TOKEN_PATTERN = /^\S{8,512}$/;

function validateUsername(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'Kaggle username must be a string.', 'INVALID_KAGGLE_CREDENTIALS');
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw new HttpError(400, 'Kaggle username contains unsupported characters.', 'INVALID_KAGGLE_CREDENTIALS');
  }
  return trimmed;
}

export function parseKaggleConnectInput(body: unknown): ParsedKaggleConnectInput {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'Kaggle credentials payload is required.', 'INVALID_KAGGLE_CREDENTIALS');
  }

  const candidate = body as {
    apiToken?: unknown;
    username?: unknown;
    apiKey?: unknown;
    key?: unknown;
  };

  const username = validateUsername(candidate.username);
  const rawToken = typeof candidate.apiToken === 'string' ? candidate.apiToken.trim() : '';
  const rawKey = typeof candidate.apiKey === 'string'
    ? candidate.apiKey.trim()
    : typeof candidate.key === 'string'
      ? candidate.key.trim()
      : '';

  if (rawToken.startsWith('{')) {
    let parsed: { username?: unknown; key?: unknown };
    try {
      parsed = JSON.parse(rawToken) as { username?: unknown; key?: unknown };
    } catch {
      throw new HttpError(400, 'Invalid kaggle.json credentials format.', 'INVALID_KAGGLE_CREDENTIALS');
    }
    const jsonUsername = validateUsername(parsed.username);
    const jsonKey = typeof parsed.key === 'string' ? parsed.key.trim() : '';
    if (!jsonUsername || !TOKEN_PATTERN.test(jsonKey)) {
      throw new HttpError(400, 'kaggle.json must include valid username and key fields.', 'INVALID_KAGGLE_CREDENTIALS');
    }
    return {
      secret: { kind: 'basic', username: jsonUsername, key: jsonKey },
      username: jsonUsername,
    };
  }

  if (rawToken.startsWith('KGAT_')) {
    if (!TOKEN_PATTERN.test(rawToken) || rawToken.length < 16) {
      throw new HttpError(400, 'Enter a complete Kaggle API token starting with KGAT_.', 'INVALID_KAGGLE_CREDENTIALS');
    }
    return {
      secret: { kind: 'bearer', token: rawToken },
      username,
    };
  }

  const legacyKey = rawKey || rawToken;
  if (username && TOKEN_PATTERN.test(legacyKey)) {
    return {
      secret: { kind: 'basic', username, key: legacyKey },
      username,
    };
  }

  throw new HttpError(
    400,
    'Enter a Kaggle API token (KGAT_...) or your Kaggle username and API key.',
    'INVALID_KAGGLE_CREDENTIALS',
  );
}

export function buildKaggleAuthHeadersFromSecret(secret: StoredKaggleSecret): Record<string, string> {
  if (secret.kind === 'bearer') {
    return { Authorization: `Bearer ${secret.token}` };
  }
  if (secret.kind === 'oauth2') {
    return { Authorization: `Bearer ${secret.accessToken}` };
  }
  const encoded = Buffer.from(`${secret.username}:${secret.key}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

export function isKaggleOAuthEnabled(): boolean {
  return (
    process.env.KAGGLE_OAUTH_ENABLED === 'true'
    && Boolean(process.env.KAGGLE_OAUTH_CLIENT_ID?.trim())
    && Boolean(process.env.KAGGLE_OAUTH_REDIRECT_URI?.trim())
  );
}

export class ApiTokenAuthProvider implements KaggleAuthProvider {
  readonly mode: KaggleAuthMode = 'api_token';

  constructor(private readonly repositories?: Repositories) {}

  isConfigured(): boolean {
    try {
      parseEncryptionKey();
      return true;
    } catch {
      return false;
    }
  }

  async getKaggleAuthContext(userId: string): Promise<KaggleAuthContext> {
    const repositories = this.repositories ?? await getRepositories();
    const record = await repositories.kaggleCredentials.getKaggleCredentials(userId);
    if (!record || record.authMode !== 'api_token') {
      throw new HttpError(409, 'Connect your Kaggle account before running transcription.', 'KAGGLE_NOT_CONNECTED');
    }

    const plaintext = decryptKaggleSecret(
      {
        encryptedToken: record.encryptedToken,
        tokenIv: record.tokenIv,
        tokenAuthTag: record.tokenAuthTag,
      },
      { aad: userId },
    );

    let secret: StoredKaggleSecret;
    try {
      secret = JSON.parse(plaintext) as StoredKaggleSecret;
    } catch {
      throw new HttpError(500, 'Stored Kaggle credentials are invalid.', 'KAGGLE_DECRYPT_FAILED');
    }

    const username = record.kaggleUsername ?? (secret.kind === 'basic' ? secret.username : null);
    return {
      headers: buildKaggleAuthHeadersFromSecret(secret),
      authMode: 'api_token',
      username,
    };
  }

  async getKaggleAuthHeaders(userId: string): Promise<Record<string, string>> {
    const context = await this.getKaggleAuthContext(userId);
    return context.headers;
  }
}

export class OAuth2AuthProvider implements KaggleAuthProvider {
  readonly mode: KaggleAuthMode = 'oauth2';

  isConfigured(): boolean {
    return isKaggleOAuthEnabled();
  }

  async getKaggleAuthContext(_userId: string): Promise<KaggleAuthContext> {
    throw new HttpError(501, 'Kaggle OAuth 2.0 is not enabled yet.', 'KAGGLE_OAUTH_NOT_ENABLED');
  }

  async getKaggleAuthHeaders(userId: string): Promise<Record<string, string>> {
    const context = await this.getKaggleAuthContext(userId);
    return context.headers;
  }
}

export function getKaggleAuthProvider(
  mode: KaggleAuthMode = 'api_token',
  repositories?: Repositories,
): KaggleAuthProvider {
  if (mode === 'oauth2') {
    return new OAuth2AuthProvider();
  }
  return new ApiTokenAuthProvider(repositories);
}

export async function getKaggleAuthContextForUser(
  userId: string,
  repositories?: Repositories,
): Promise<KaggleAuthContext> {
  const resolved = repositories ?? await getRepositories();
  const record = await resolved.kaggleCredentials.getKaggleCredentials(userId);
  if (!record) {
    throw new HttpError(409, 'Connect your Kaggle account before running transcription.', 'KAGGLE_NOT_CONNECTED');
  }
  return getKaggleAuthProvider(record.authMode, resolved).getKaggleAuthContext(userId);
}
