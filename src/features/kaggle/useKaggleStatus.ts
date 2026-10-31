import { useCallback, useEffect, useState } from 'react';

export interface KaggleAvailability {
  available: boolean;
  message: string;
}

export function useKaggleStatus(enabled: boolean) {
  const [status, setStatus] = useState<KaggleAvailability | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    setLoading(true);
    try {
      const response = await fetch('/api/kaggle/status', { credentials: 'same-origin', signal });
      if (!response.ok) throw new Error('Could not check online GPU availability.');
      const payload = await response.json() as KaggleAvailability;
      if (typeof payload.available !== 'boolean' || typeof payload.message !== 'string') {
        throw new Error('Invalid GPU status response.');
      }
      if (!signal?.aborted) {
        setStatus(payload);
        setError(null);
      }
    } catch (cause) {
      if (!signal?.aborted) {
        setStatus(null);
        setError(cause instanceof Error ? cause.message : 'Could not check online GPU availability.');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [enabled, refresh]);

  return { status, loading, error, refresh };
}
