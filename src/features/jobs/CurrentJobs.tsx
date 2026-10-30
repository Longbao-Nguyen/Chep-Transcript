import { Clock3, Loader2, Play, X } from 'lucide-react';

import type { ClientJob, LocalUpload, QueueState } from '../../types';
import { StatusBadge } from './StatusBadge';
import { isActiveJob } from './useJobsPolling';
import { queueStartControl } from './queueControls';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressText(job: ClientJob): string | null {
  if (job.progress == null || job.status === 'QUEUED' || job.status === 'WORKER_STARTING' || job.status === 'CANCEL_REQUESTED') return null;
  return `${Math.round(job.progress * 100)}%`;
}

export function CurrentJobs({
  jobs,
  uploads,
  loading,
  queueState,
  queuedCount,
  cancellingJobId,
  starting,
  workerReady,
  onCancel,
  onStart,
  onDismissUpload,
}: {
  jobs: ClientJob[];
  uploads: LocalUpload[];
  loading: boolean;
  queueState: QueueState;
  queuedCount: number;
  cancellingJobId: string | null;
  starting: boolean;
  workerReady: boolean;
  onCancel: (job: ClientJob) => void;
  onStart: () => void;
  onDismissUpload: (localId: string) => void;
}) {
  const localJobIds = new Set(uploads.flatMap((item) => item.jobId ? [item.jobId] : []));
  const activeJobs = jobs.filter((job) => isActiveJob(job) && !localJobIds.has(job.id));
  const empty = uploads.length === 0 && activeJobs.length === 0;
  const start = queueStartControl(queueState, queuedCount, starting, workerReady);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock3 className="h-5 w-5 text-emerald-700" />
          <h2 className="font-bold text-slate-900">Queue <span className="ml-2 text-xs font-normal text-slate-500">{activeJobs.length + uploads.length}</span></h2>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        <button type="button" disabled={loading || start.disabled} onClick={onStart} aria-describedby="queue-start-help" className="inline-flex items-center gap-2 rounded-lg bg-[#294f38] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1c3e2a] disabled:cursor-not-allowed disabled:opacity-50"><Play size={14} />{start.label}</button>
      </div>
      <p id="queue-start-help" className="mb-5 text-xs leading-5 text-slate-500">{start.reason}</p>

      {(queueState === 'PAUSING' || queueState === 'PAUSED') && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{queueState === 'PAUSING' ? 'Stopping current worker...' : 'Queue paused'}</p>
          <p>{queuedCount} {queuedCount === 1 ? 'file is' : 'files are'} still waiting.</p>
        </div>
      )}

      {empty ? (
        <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No files in the queue. Add a recording to get started.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {uploads.map((upload) => (
            <div key={upload.localId} className="py-4 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-800">{upload.file.name}</p>
                  <p className="mt-1 text-xs text-slate-400">{formatBytes(upload.file.size)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${upload.state === 'FAILED' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
                    {upload.state === 'UPLOADING' ? `Uploading ${Math.round(upload.progress * 100)}%` : upload.state.toLowerCase()}
                  </span>
                  {upload.state === 'FAILED' && (
                    <button type="button" onClick={() => onDismissUpload(upload.localId)} className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer" title="Dismiss" aria-label={`Dismiss failed upload ${upload.file.name}`}>
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              {upload.state === 'UPLOADING' && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
                </div>
              )}
              {upload.error && <p className="mt-2 text-xs text-red-600">{upload.error}</p>}
            </div>
          ))}

          {activeJobs.map((job) => (
            <div key={job.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">{job.filename}</p>
                <p className="mt-1 text-xs text-slate-400">{formatBytes(job.fileSizeBytes)}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={job.status} />
                {progressText(job) && <span className="w-10 text-right text-xs font-semibold text-slate-500">{progressText(job)}</span>}
                {(job.status === 'QUEUED' || ['PROCESSING', 'WORKER_STARTING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING'].includes(job.status)) && (
                  <button type="button" disabled={cancellingJobId !== null} onClick={() => onCancel(job)} aria-label={`${job.status === 'QUEUED' ? 'Remove' : 'Cancel processing'} ${job.filename}`} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
                    {cancellingJobId === job.id ? 'Cancelling...' : job.status === 'QUEUED' ? 'Remove' : 'Cancel processing'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
