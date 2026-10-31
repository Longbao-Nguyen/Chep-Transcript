import crypto from 'node:crypto';

export const ANONYMOUS_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ANONYMOUS_COOKIE_NAME = 'chep_anon_session';

export function signAnonymousToken(userId: string, secret: string): string {
  const timestamp = Date.now();
  const data = `${userId}.${timestamp}`;
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

export function verifyAnonymousToken(token: string, secret: string): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, timestampStr, hmac] = parts;
  if (!/^usr_anon_[a-f0-9]{20}$/.test(userId || '') || !/^\d{13}$/.test(timestampStr || '') || !hmac) return null;

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) return null;

  // Verify expiration within 7 days
  if (Date.now() - timestamp > ANONYMOUS_SESSION_TTL_MS || timestamp > Date.now() + 60000) {
    return null;
  }

  const data = `${userId}.${timestampStr}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (hmac.length !== expected.length) return null;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }

  return { userId };
}

export function getAnonymousCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${ANONYMOUS_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export function createAnonymousCookieHeader(token: string, secure: boolean): string {
  const secureFlag = secure ? '; Secure' : '';
  const maxAge = Math.floor(ANONYMOUS_SESSION_TTL_MS / 1000); // 7 days in seconds
  return `${ANONYMOUS_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureFlag}`;
}

export function createAnonymousUserId(): string {
  return `usr_anon_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
