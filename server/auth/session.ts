import { getToken } from '@auth/core/jwt';

import { getRepositories } from '../db/index.js';
import type { User } from '../db/interface.js';
import { HttpError } from '../http/responses.js';
import { getAnonymousCookie, verifyAnonymousToken } from './anonymous.js';

export async function requireUser(request: Request): Promise<User> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is required.');

  // 1. Check for authenticated Google JWT token session
  let userId: string | null = null;
  try {
    const token = await getToken({
      req: request,
      secret,
      secureCookie:
        request.headers.get('x-forwarded-proto') === 'https' ||
        new URL(request.url).protocol === 'https:',
    });
    if (typeof token?.appUserId === 'string') {
      userId = token.appUserId;
    }
  } catch {
    // If not a valid JWT token, continue to anonymous check
  }

  // 2. Check for signed anonymous session cookie
  if (!userId) {
    const anonCookie = getAnonymousCookie(request);
    if (anonCookie) {
      const verified = verifyAnonymousToken(anonCookie, secret);
      if (verified) {
        userId = verified.userId;
      }
    }
  }

  if (!userId) {
    throw new HttpError(401, 'Sign in is required.', 'UNAUTHENTICATED');
  }

  const repositories = await getRepositories();
  let user = await repositories.users.getById(userId);
  if (!user && userId.startsWith('usr_anon_')) {
    user = await repositories.users.getOrCreateAnonymousUser(userId);
  }
  if (!user) {
    throw new HttpError(401, 'Your session is no longer valid.', 'INVALID_SESSION');
  }
  return user;
}
