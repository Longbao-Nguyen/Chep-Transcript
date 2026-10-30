import { useEffect, useRef } from 'react';
import type { ClientJob } from '../../types';

export function CancelJobDialog({ job, onClose, onConfirm }: { job: ClientJob; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="cancel-title" aria-describedby="cancel-description" className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border-0 bg-white p-6 shadow-xl backdrop:bg-slate-950/50">
      <h2 id="cancel-title" className="text-lg font-bold text-slate-900">Cancel current transcription?</h2>
      <p className="mt-2 break-words text-sm font-medium text-slate-800">{job.filename}</p>
      <p id="cancel-description" className="mt-3 text-sm leading-6 text-slate-600">This stops processing this file and pauses the queue. Other queued files will be kept.</p>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button type="button" autoFocus onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Keep processing</button>
        <button type="button" onClick={onConfirm} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Cancel and pause queue</button>
      </div>
    </dialog>
  );
}
