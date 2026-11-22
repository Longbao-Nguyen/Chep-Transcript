import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { TERMINAL_JOB_STATUSES, type Job } from '../db/interface.js';
import { HttpError } from '../http/responses.js';

export const DEFAULT_CALLBACK_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export interface GeneratedCallbackToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function hashCallbackToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateJobCallbackToken(
  ttlMs = DEFAULT_CALLBACK_TOKEN_TTL_MS,
  now = Date.now(),
): GeneratedCallbackToken {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashCallbackToken(token),
    expiresAt: new Date(now + ttlMs),
  };
}

export function verifyJobCallbackToken(request: Request, job: Job | null, now = Date.now()): Job {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];

  if (!token || token.length < 32) {
    throw new HttpError(401, 'Worker authorization is required.', 'WORKER_UNAUTHORIZED');
  }

  if (!job) {
    throw new HttpError(401, 'Invalid worker authorization.', 'WORKER_UNAUTHORIZED');
  }

  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    throw new HttpError(403, 'This job is already in a terminal state.', 'JOB_TERMINAL');
  }

  if (!job.callbackTokenHash || !job.callbackTokenExpiresAt) {
    throw new HttpError(401, 'Worker authorization has been revoked.', 'WORKER_UNAUTHORIZED');
  }

  if (job.callbackTokenExpiresAt.getTime() <= now) {
    throw new HttpError(401, 'Worker authorization has expired.', 'WORKER_TOKEN_EXPIRED');
  }

  const providedHash = Buffer.from(hashCallbackToken(token), 'hex');
  const expectedHash = Buffer.from(job.callbackTokenHash, 'hex');
  if (
    expectedHash.length !== 32
    || providedHash.length !== expectedHash.length
    || !timingSafeEqual(providedHash, expectedHash)
  ) {
    throw new HttpError(401, 'Invalid worker authorization.', 'WORKER_UNAUTHORIZED');
  }

  return job;
}
