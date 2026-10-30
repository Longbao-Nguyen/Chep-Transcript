import { Download, FileCheck2 } from 'lucide-react';
import { useRef, useState } from 'react';

import type { ClientJob } from '../../types';
import { StatusBadge } from './StatusBadge';
import { isActiveJob } from './useJobsPolling';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function CompletedJobs({ jobs }: { jobs: ClientJob[] }) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const downloadLock = useRef(false);
  const recent = jobs.filter((job) => !isActiveJob(job));

  const download = async (job: ClientJob) => {
    if (downloadLock.current) return;
    downloadLock.current = true;
    setDownloadingId(job.id);
    setDownloadError(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/download`, { credentials: 'same-origin' });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setDownloadError(payload?.error?.message || 'Could not prepare this download.');
        return;
      }
      const transcript = await response.blob();
      const downloadUrl = URL.createObjectURL(transcript);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${job.filename.replace(/\.[^.]+$/, '') || 'transcript'}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    } catch {
      setDownloadError('The download was interrupted. Please try again.');
    } finally {
      downloadLock.current = false;
      setDownloadingId(null);
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
            return (
              <div key={job.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-800">{job.filename}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {job.completedAt ? `Completed ${formatDate(job.completedAt)}` : formatDate(job.createdAt)}
                    {job.expiresAt && !expired ? ` · expires ${formatDate(job.expiresAt)}` : ''}
                  </p>
                  {job.errorMessage && <p className="mt-1 text-xs text-red-600">{job.errorMessage}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={expired ? 'EXPIRED' : job.status} />
                  {job.status === 'COMPLETED' && !expired && (
                    <button
                      type="button"
                      onClick={() => void download(job)}
                      disabled={downloadingId !== null}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#294f38] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1c3e2a] disabled:opacity-50"
                    >
                      <Download className="h-3.5 w-3.5" /> {downloadingId === job.id ? 'Downloading…' : 'Download TXT'}
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
