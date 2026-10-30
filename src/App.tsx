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

  if (sessionLoading) {
    return <div className="min-h-screen bg-slate-50 grid place-items-center text-sm text-slate-500">Loading session…</div>;
  }

  if (!session) {
    return <SignInCard error={sessionError} />;
  }

  return (
    <div className="min-h-screen bg-[#f7f8f5] text-slate-800 font-sans antialiased lg:flex">
      <aside className="bg-[#172e28] p-6 text-white lg:sticky lg:top-0 lg:h-screen lg:w-72 lg:shrink-0 lg:overflow-y-auto">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl border border-white/20 text-emerald-100"><AudioLines size={24} /></span><div><p className="text-lg font-semibold">French Transcript</p><p className="text-xs text-emerald-100/60">Web workspace</p></div></div>
        <nav aria-label="Workspace navigation" className="mt-8 flex gap-2 lg:grid">
          <button type="button" aria-current={tab === 'transcribe' ? 'page' : undefined} onClick={() => setTab('transcribe')} className={`flex flex-1 items-center gap-3 rounded-lg px-3 py-3 text-sm ${tab === 'transcribe' ? 'bg-[#2c4439] text-white' : 'text-emerald-100/70 hover:bg-white/5'}`}><AudioLines size={18} /> Transcribe <span className="ml-auto text-xs">{queuedCount}</span></button>
          <button type="button" aria-current={tab === 'history' ? 'page' : undefined} onClick={() => setTab('history')} className={`flex flex-1 items-center gap-3 rounded-lg px-3 py-3 text-sm ${tab === 'history' ? 'bg-[#2c4439] text-white' : 'text-emerald-100/70 hover:bg-white/5'}`}><History size={18} /> History <span className="ml-auto text-xs">{jobs.filter((job) => !isActiveJob(job)).length}</span></button>
        </nav>
        <button type="button" aria-expanded={connectionOpen} aria-controls="kaggle-panel" onClick={() => setConnectionOpen((open) => !open)} className="mt-4 flex w-full items-center justify-between rounded-lg border border-white/15 px-3 py-2 text-xs text-emerald-100 lg:hidden"><span>Kaggle connection</span><span>{connectionOpen ? 'Hide details' : 'Show setup'}</span></button>
        <div id="kaggle-panel" className={`${connectionOpen ? 'block' : 'hidden'} lg:block`}><KaggleConnection status={kaggle.status} loading={kaggle.loading} error={kaggle.error} onRefresh={() => void kaggle.refresh()} /></div>
        <p className="mt-8 hidden items-center gap-2 border-t border-white/15 pt-5 text-xs text-emerald-100/70 lg:flex"><ShieldCheck size={14} /> Private files · Google sign-in</p>
      </aside>
      <div className="min-w-0 flex-1">
      <AppHeader user={session.user} page={tab === 'transcribe' ? 'Transcribe' : 'History'} onGuide={() => setGuideOpen(true)} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
        {(jobsError || sessionError || actionError) && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {jobsError || sessionError || actionError}
          </div>
        )}
        {tab === 'transcribe' ? <>
        <div><h1 className="text-2xl font-semibold text-[#233c34]">Your recordings, ready to transcribe.</h1><p className="mt-2 text-sm text-slate-500">Add files to your private queue and keep track of every transcript.</p></div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-6">
        <MultiFileUploadPanel onFiles={handleFiles} />
        <CurrentJobs
          jobs={jobs}
          uploads={uploads}
          loading={jobsLoading}
          queueState={queueState}
          queuedCount={queuedCount}
          cancellingJobId={cancellingJobId}
          starting={starting}
          workerReady={false}
          onCancel={(job) => job.status === 'QUEUED' ? void cancelJob(job) : setConfirmJob(job)}
          onStart={() => void startQueue()}
          onDismissUpload={dismissUpload}
        />
        {jobs.some((job) => job.status === 'COMPLETED') && <button type="button" onClick={() => setTab('history')} className="flex w-full items-center justify-between rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-900"><span>Completed transcripts are in History</span><History size={18} /></button>}
        </div>
        <aside className="space-y-5">
          <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="text-xs font-semibold tracking-wider text-slate-500">PROCESSING DEVICE</h2><p className="mt-4 font-semibold text-[#233c34]">Online GPU · Kaggle</p><p className="mt-2 text-sm leading-6 text-slate-500">Processing will use your own Kaggle account. GPU access has not been checked.</p><p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">Online processing is being prepared. Upload and queue management are available now.</p></section>
          <section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="text-xs font-semibold tracking-wider text-slate-500">TRANSCRIPTION MODEL</h2><p className="mt-4 font-semibold text-[#233c34]">French</p><p className="mt-2 text-sm leading-6 text-slate-500">Whisper large-v3 French, distilled. French is the planned language for this web release.</p><p className="mt-4 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">Once available, long recordings will be split across two notebooks and combined into one transcript.</p></section>
        </aside>
        </div>
        </> : <CompletedJobs jobs={jobs} />}
      </main>
      </div>
      {confirmJob && <CancelJobDialog job={confirmJob} onClose={() => setConfirmJob(null)} onConfirm={() => void cancelJob(confirmJob)} />}
      {guideOpen && <UserGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
