import { useCallback, useEffect, useRef, useState } from 'react';

export interface KaggleStatus {
  connected: boolean;
  available: boolean;
  authMode: 'api_token' | 'oauth2' | null;
  username: string | null;
  oauthEnabled: boolean;
  gpuStatus?: 'unchecked' | 'checking' | 'ready' | 'error';
  gpuMessage?: string | null;
  gpuCheckedAt?: string | null;
  connectedAt: string | null;
  message: string;
}

export interface ConnectKaggleInput {
  apiToken: string;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message || fallback;
  } catch {
    return fallback;
  }
}

export function useKaggleStatus(enabled: boolean) {
  const [status, setStatus] = useState<KaggleStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollInFlightRef = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal, options?: { silent?: boolean }) => {
    if (!enabled) return;
    if (!options?.silent) setLoading(true);
    try {
      const response = await fetch('/api/kaggle/status', { credentials: 'same-origin', signal });
      if (!response.ok) throw new Error(await readApiError(response, 'Could not check Kaggle connection status.'));
      const payload = await response.json() as KaggleStatus;
      if (typeof payload.connected !== 'boolean' || typeof payload.message !== 'string') {
        throw new Error('Invalid Kaggle status response.');
      }
      if (!signal?.aborted) {
        setStatus(payload);
        setError(null);
      }
    } catch (cause) {
      if (!signal?.aborted && !options?.silent) {
        setStatus(null);
        setError(cause instanceof Error ? cause.message : 'Could not check Kaggle connection status.');
      }
    } finally {
      if (!signal?.aborted && !options?.silent) setLoading(false);
    }
  }, [enabled]);

  const connect = useCallback(async (input: ConnectKaggleInput) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/kaggle/connect', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Could not connect Kaggle account.'));
      }
      const payload = await response.json() as KaggleStatus;
      setStatus(payload);
      setError(null);
      return payload;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const checkGpu = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/kaggle/gpu-check', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Could not start Kaggle GPU check.'));
      }
      const payload = await response.json() as KaggleStatus;
      setStatus(payload);
      setError(null);
      return payload;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not start Kaggle GPU check.';
      setError(message);
      throw cause;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/kaggle/disconnect', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Could not disconnect Kaggle account.'));
      }
      const payload = await response.json() as KaggleStatus;
      setStatus(payload);
      setError(null);
      return payload;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not disconnect Kaggle account.';
      setError(message);
      throw cause;
    } finally {
      setSubmitting(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || status?.gpuStatus !== 'checking') return;
    const poll = async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        await refresh(undefined, { silent: true });
      } finally {
        pollInFlightRef.current = false;
      }
    };
    const intervalId = window.setInterval(() => {
      void poll();
    }, 5_000);
    return () => window.clearInterval(intervalId);
  }, [enabled, refresh, status?.gpuStatus]);

  return { status, loading, submitting, error, refresh, connect, checkGpu, disconnect };
}
