import { useCallback, useRef, useState } from 'react';
import { AudioLines, History, ShieldCheck } from 'lucide-react';

import { AppHeader } from './features/auth/AppHeader';
import { SignInCard } from './features/auth/SignInCard';
import { useSession } from './features/auth/useSession';
import { CompletedJobs } from './features/jobs/CompletedJobs';
import { CurrentJobs } from './features/jobs/CurrentJobs';
import { isActiveJob, useJobsPolling } from './features/jobs/useJobsPolling';
import { MultiFileUploadPanel } from './features/upload/MultiFileUploadPanel';
import { uploadFileDirectly } from './features/upload/uploadFile';
import { KaggleConnection } from './features/kaggle/KaggleConnection';
import { useKaggleStatus } from './features/kaggle/useKaggleStatus';
import { UserGuide } from './features/guide/UserGuide';
import { CancelJobDialog } from './features/jobs/CancelJobDialog';
import type { ClientJob, LocalUpload } from './types';

function createLocalUpload(file: File): LocalUpload {
  return {
    localId: crypto.randomUUID(),
    file,
    progress: 0,
    state: 'WAITING',
    jobId: null,
    error: null,
  };
}

export default function App() {
  const { session, loading: sessionLoading, error: sessionError } = useSession();
  const { jobs, queueState, queuedCount, loading: jobsLoading, error: jobsError, refresh } = useJobsPolling(Boolean(session));
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [confirmJob, setConfirmJob] = useState<ClientJob | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<'transcribe' | 'history'>('transcribe');
  const [selectedModel, setSelectedModel] = useState<string>('fr');
  const [guideOpen, setGuideOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const startLock = useRef(false);
  const kaggle = useKaggleStatus(Boolean(session));

  const cancelJob = useCallback(async (job: ClientJob) => {
    setConfirmJob(null);
    setCancellingJobId(job.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', credentials: 'same-origin' });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || 'Could not cancel job.');
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not cancel job.');
    } finally {
      setCancellingJobId(null);
    }
  }, [refresh]);

  const startQueue = useCallback(async () => {
    if (startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setActionError(null);
    try {
      const response = await fetch('/api/queue/start', { method: 'POST', credentials: 'same-origin' });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || 'Could not start transcription.');
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not start transcription.');
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }, [refresh]);

  const updateUpload = useCallback((localId: string, patch: Partial<LocalUpload>) => {
    setUploads((current) => current.map((item) => item.localId === localId ? { ...item, ...patch } : item));
  }, []);

  const processUpload = useCallback(async (item: LocalUpload) => {
    try {
      await uploadFileDirectly(item.file, {
        onInitialized(jobId) {
          updateUpload(item.localId, { jobId, state: 'UPLOADING' });
        },
        onProgress(progress) {
          updateUpload(item.localId, { progress, state: 'UPLOADING' });
        },
        onFinalizing() {
          updateUpload(item.localId, { progress: 1, state: 'FINALIZING' });
        },
      });
      updateUpload(item.localId, { progress: 1, state: 'QUEUED' });
      await refresh();
      setUploads((current) => current.filter((upload) => upload.localId !== item.localId));
    } catch (error) {
      updateUpload(item.localId, {
        state: 'FAILED',
        error: error instanceof Error ? error.message : 'Upload failed.',
      });
      await refresh();
    }
  }, [refresh, updateUpload]);

  const handleFiles = useCallback((files: File[]) => {
    const pending = files.map(createLocalUpload);
    setUploads((current) => [...current, ...pending]);
    pending.forEach((item) => void processUpload(item));
  }, [processUpload]);

  const dismissUpload = useCallback((localId: string) => {
    setUploads((current) => current.filter((item) => item.localId !== localId));
  }, []);

  if (sessionLoading) return <div className="grid min-h-screen place-items-center text-sm text-slate-600">Opening your workspace…</div>;
  if (!session) return <SignInCard error={sessionError} />;

  return (
    <div className="min-h-screen bg-[#f7f8f5] text-slate-800 font-sans antialiased lg:flex">
      <aside className="bg-[#172e28] p-6 text-white lg:sticky lg:top-0 lg:h-screen lg:w-72 lg:shrink-0 lg:overflow-y-auto">
        {/* Brand section matching French-Transcript-Local */}
        <div className="flex items-center gap-3">
          <span className="grid h-[49px] w-[44px] place-items-center rounded-xl border border-[#4c675b] text-[#d4e7c9]">
            <AudioLines size={25} />
          </span>
          <span className="text-[23px] font-bold tracking-tight text-[#eff7ed]">Chep</span>
          <span className="ml-auto text-[11px] font-normal text-[#a1b3a7]">web version</span>
        </div>

        {/* Navigation tabs */}
        <nav aria-label="Main navigation" className="mt-8 flex gap-2 lg:grid">
          <button
            type="button"
            aria-current={tab === 'transcribe' ? 'page' : undefined}
            onClick={() => setTab('transcribe')}
            className={`flex flex-1 items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors ${
              tab === 'transcribe'
                ? 'bg-[#2c4439] text-[#eff7ed]'
                : 'text-[#aabdb3] hover:bg-[#253e34]'
            }`}
          >
            <AudioLines size={19} />
            <span>Transcribe</span>
            <span className="ml-auto text-xs text-[#afc4b5]">{queuedCount}</span>
          </button>
          <button
            type="button"
            aria-current={tab === 'history' ? 'page' : undefined}
            onClick={() => setTab('history')}
            className={`flex flex-1 items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors ${
              tab === 'history'
                ? 'bg-[#2c4439] text-[#eff7ed]'
                : 'text-[#aabdb3] hover:bg-[#253e34]'
            }`}
          >
            <History size={19} />
            <span>History</span>
            <span className="ml-auto text-xs text-[#afc4b5]">
              {jobs.filter((job) => !isActiveJob(job)).length}
            </span>
          </button>
        </nav>

        {/* Mobile toggle for Kaggle connection */}
        <button
          type="button"
          aria-expanded={connectionOpen}
          aria-controls="kaggle-panel"
          onClick={() => setConnectionOpen((open) => !open)}
          className="mt-4 flex w-full items-center justify-between rounded-lg border border-white/15 px-3 py-2 text-xs text-emerald-100 lg:hidden"
        >
          <span>Kaggle connection</span>
          <span>{connectionOpen ? 'Hide details' : 'Show setup'}</span>
        </button>

        {/* Kaggle Connection Panel */}
        <div id="kaggle-panel" className={`${connectionOpen ? 'block' : 'hidden'} lg:block`}>
          <KaggleConnection
            status={kaggle.status}
            loading={kaggle.loading}
            error={kaggle.error}
            onRefresh={() => void kaggle.refresh()}
          />
        </div>

        <p className="mt-8 hidden items-center gap-2 border-t border-white/15 pt-5 text-xs text-emerald-100/70 lg:flex">
          <ShieldCheck size={14} /> Private session · 7-day storage
        </p>
      </aside>

      <div className="min-w-0 flex-1">
        <AppHeader
          user={session.user}
          page={tab === 'transcribe' ? 'Transcribe' : 'History'}
          onGuide={() => setGuideOpen(true)}
          selectedModel={selectedModel}
          onSelectModel={setSelectedModel}
        />

        <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-8">
          {(jobsError || sessionError || actionError) && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {jobsError || sessionError || actionError}
            </div>
          )}

          {tab === 'transcribe' ? (
            <div className="space-y-6">
              <MultiFileUploadPanel onFiles={handleFiles} />
              <CurrentJobs
                jobs={jobs}
                uploads={uploads}
                loading={jobsLoading}
                queueState={queueState}
                queuedCount={queuedCount}
                cancellingJobId={cancellingJobId}
                starting={starting}
                workerReady={Boolean(kaggle.status?.available)}
                onCancel={(job) => job.status === 'QUEUED' ? void cancelJob(job) : setConfirmJob(job)}
                onStart={() => void startQueue()}
                onDismissUpload={dismissUpload}
              />
              {jobs.some((job) => job.status === 'COMPLETED') && (
                <button
                  type="button"
                  onClick={() => setTab('history')}
                  className="flex w-full items-center justify-between rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-900 transition hover:bg-emerald-100/70"
                >
                  <span>Completed transcripts are in History</span>
                  <History size={18} />
                </button>
              )}
            </div>
          ) : (
            <CompletedJobs jobs={jobs} />
          )}
        </main>
      </div>

      {confirmJob && (
        <CancelJobDialog
          job={confirmJob}
          onClose={() => setConfirmJob(null)}
          onConfirm={() => void cancelJob(confirmJob)}
        />
      )}
      {guideOpen && <UserGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
