import { Download, Eye, FileCheck2, RotateCw, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

import type { TranscriptionModelSummary } from '../../../shared/models';
import type { ClientJob } from '../../types';
import { formatJobModelLabel } from '../models/useModels';
import { StatusBadge } from './StatusBadge';
import { isActiveJob } from './useJobsPolling';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

const RETRYABLE_STATUSES = new Set([
  'FAILED_UPLOAD',
  'FAILED_WORKER_START',
  'FAILED_MEDIA',
  'FAILED_INFERENCE',
  'FAILED_OUTPUT',
  'CANCELLED',
]);

export function CompletedJobs({
  jobs,
  models = [],
  onPreview,
  onRetry,
  onDelete,
  busyJobId = null,
}: {
  jobs: ClientJob[];
  models?: TranscriptionModelSummary[];
  onPreview?: (job: ClientJob) => void;
  onRetry?: (job: ClientJob) => void;
  onDelete?: (job: ClientJob) => void;
  busyJobId?: string | null;
}) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const downloadLock = useRef(false);
  const recent = jobs.filter((job) => !isActiveJob(job));

  const download = async (job: ClientJob, format: 'txt' | 'srt' = 'txt') => {
    if (downloadLock.current) return;
    downloadLock.current = true;
    setDownloadingKey(`${job.id}:${format}`);
    setDownloadError(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/download?format=${format}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setDownloadError(payload?.error?.message || 'Could not prepare this download.');
        return;
      }
      const transcript = await response.blob();
      const downloadUrl = URL.createObjectURL(transcript);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${job.filename.replace(/\.[^.]+$/, '') || 'transcript'}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    } catch {
      setDownloadError('The download was interrupted. Please try again.');
    } finally {
      downloadLock.current = false;
      setDownloadingKey(null);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <FileCheck2 className="h-5 w-5 text-emerald-600" />
        <h1 className="font-bold text-slate-900">History</h1>
      </div>
      <p className="mb-5 text-xs text-slate-500">Completed transcripts, cancelled files and recent errors. Downloads are available until their expiry date.</p>
      {downloadError && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{downloadError}</p>}
      {recent.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No recent jobs.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {recent.map((job) => {
            const expired = job.status === 'EXPIRED' || Boolean(job.expiresAt && new Date(job.expiresAt).getTime() <= Date.now());
            const canRetry = RETRYABLE_STATUSES.has(job.status);
            const busy = busyJobId === job.id;
            return (
              <div key={job.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-800">{job.filename}</p>
                    {job.dualMode && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                        Dual T4
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    {job.completedAt ? `Completed ${formatDate(job.completedAt)}` : formatDate(job.createdAt)}
                    {' · '}
                    {formatJobModelLabel(job, models)}
                    {job.expiresAt && !expired ? ` · expires ${formatDate(job.expiresAt)}` : ''}
                  </p>
                  {job.errorMessage && <p className="mt-1 text-xs text-red-600">{job.errorMessage}</p>}
                </div>
                <div className="flex flex-wrap shrink-0 items-center gap-2">
                  <StatusBadge status={expired ? 'EXPIRED' : job.status} />
                  {job.status === 'COMPLETED' && !expired && (
                    <>
                      {onPreview && (
                        <button
                          type="button"
                          onClick={() => onPreview(job)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Eye className="h-3.5 w-3.5" /> Preview
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void download(job, 'txt')}
                        disabled={downloadingKey !== null}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#294f38] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1c3e2a] disabled:opacity-50"
                      >
                        <Download className="h-3.5 w-3.5" /> {downloadingKey === `${job.id}:txt` ? 'Downloading…' : 'Download TXT'}
                      </button>
                      {job.hasSrt && (
                        <button
                          type="button"
                          onClick={() => void download(job, 'srt')}
                          disabled={downloadingKey !== null}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-700 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                        >
                          <Download className="h-3.5 w-3.5" /> {downloadingKey === `${job.id}:srt` ? 'Downloading…' : 'Download SRT'}
                        </button>
                      )}
                    </>
                  )}
                  {canRetry && onRetry && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRetry(job)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <RotateCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> Retry
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDelete(job)}
                      aria-label={`Delete ${job.filename} from history`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
