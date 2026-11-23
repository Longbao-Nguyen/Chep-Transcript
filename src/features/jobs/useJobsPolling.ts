import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ACTIVE_JOB_STATUSES, type ClientJob, type JobStatus, type QueueState } from '../../types';

const activeStatuses = new Set<JobStatus>(ACTIVE_JOB_STATUSES);

export function isActiveJob(job: ClientJob): boolean {
  return activeStatuses.has(job.status);
}

export function getPollingDelay(jobs: ClientJob[]): number | null {
  const statuses = jobs.filter(isActiveJob).map((job) => job.status);
  if (statuses.length === 0) return null;
  if (statuses.includes('FINALIZING') || statuses.includes('CANCEL_REQUESTED')) return 3_000;
  if (statuses.includes('PROCESSING') || statuses.includes('PREPROCESSING') || statuses.includes('TRANSCRIBING')) return 4_000;
  if (statuses.includes('WORKER_STARTING')) return 5_000;
  return 10_000;
}

export function useJobsPolling(enabled: boolean) {
  const [jobs, setJobs] = useState<ClientJob[]>([]);
  const [queueState, setQueueState] = useState<QueueState>('IDLE');
  const [queuedCount, setQueuedCount] = useState(0);
  const [pauseAfterCurrent, setPauseAfterCurrent] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const pollInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch('/api/jobs', { credentials: 'same-origin' });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('application/json')) {
        let serverMessage: string | undefined;
        if (contentType.includes('application/json')) {
          try {
            const payload = (await response.json()) as { error?: { message?: string } };
            serverMessage = payload.error?.message;
          } catch {
            // Fall back to default message below when JSON error body cannot be parsed.
          }
        }
        throw new Error(
          response.status === 401
            ? 'Your session has expired.'
            : serverMessage || 'Could not load jobs.',
        );
      }
      const payload = (await response.json()) as {
        jobs: ClientJob[];
        queueState: QueueState;
        queuedCount: number;
        pauseAfterCurrent?: boolean;
      };
      setJobs(payload.jobs);
      setQueueState(payload.queueState);
      setQueuedCount(payload.queuedCount);
      setPauseAfterCurrent(Boolean(payload.pauseAfterCurrent));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load jobs.');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setJobs([]);
      setQueueState('IDLE');
      setQueuedCount(0);
      setPauseAfterCurrent(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    void refresh();
  }, [enabled, refresh]);

  const delay = useMemo(() => getPollingDelay(jobs), [jobs]);
  useEffect(() => {
    if (!enabled || delay == null) return;
    const poll = async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        await refresh();
      } finally {
        pollInFlightRef.current = false;
      }
    };
    const intervalId = window.setInterval(() => {
      void poll();
    }, delay);
    return () => window.clearInterval(intervalId);
  }, [delay, enabled, refresh]);

  return { jobs, queueState, queuedCount, pauseAfterCurrent, loading, error, refresh };
}
