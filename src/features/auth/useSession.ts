import { useEffect, useState } from 'react';

import type { AppSession } from '../../types';

interface SessionState {
  session: AppSession | null;
  loading: boolean;
  error: string | null;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ session: null, loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.includes('application/json')) {
          const payload = (await response.json()) as Partial<AppSession> | null;
          if (payload?.user?.id && payload?.user?.email) {
            setState({
              session: {
                user: {
                  id: payload.user.id,
                  name: payload.user.name || 'Guest',
                  email: payload.user.email,
                },
                expires: payload.expires || new Date(Date.now() + 7 * 86400000).toISOString(),
              },
              loading: false,
              error: null,
            });
            return;
          }
        }

        throw new Error('Could not create a secure session. Please try again.');
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          session: null,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not create a secure session.',
        });
      });
    return () => controller.abort();
  }, []);

  return state;
}
