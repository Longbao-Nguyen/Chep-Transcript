import { handleAuthRequest } from '../../server/auth/config.js';
import {
  createAnonymousCookieHeader,
  createAnonymousUserId,
  getAnonymousCookie,
  signAnonymousToken,
  verifyAnonymousToken,
} from '../../server/auth/anonymous.js';

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/guest/reset')) {
    return new Response(null, {
      status: 303,
      headers: {
        location: '/',
        'set-cookie': 'chep_anon_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        'cache-control': 'no-store',
      },
    });
  }
  if (url.pathname.endsWith('/session')) {
    const authResponse = await handleAuthRequest(request);
    const contentType = authResponse.headers.get('content-type') || '';
    if (authResponse.ok && contentType.includes('application/json')) {
      try {
        const payload = (await authResponse.clone().json()) as { user?: { email?: string } } | null;
        if (payload?.user?.email) {
          return authResponse;
        }
      } catch {
        // Fall back to anonymous session
      }
    }

    const secret = process.env.AUTH_SECRET;
    if (!secret) return new Response(JSON.stringify({ error: 'Session configuration is missing.' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    const existingCookie = getAnonymousCookie(request);
    let userId: string | null = null;
    if (existingCookie) {
      const verified = verifyAnonymousToken(existingCookie, secret);
      if (verified) userId = verified.userId;
    }
    if (!userId) {
      userId = createAnonymousUserId();
    }

    const token = signAnonymousToken(userId, secret);
    const isHttps =
      request.headers.get('x-forwarded-proto') === 'https' || url.protocol === 'https:';
    const cookieHeader = createAnonymousCookieHeader(token, isHttps);

    const sessionPayload = {
      user: {
        id: userId,
        name: 'Anonymous Guest',
        email: `${userId}@anonymous.chep.local`,
      },
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    return new Response(JSON.stringify(sessionPayload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': cookieHeader,
        'cache-control': 'no-store',
      },
    });
  }

  return handleAuthRequest(request);
};

export const POST = handleAuthRequest;
