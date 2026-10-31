import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export function UserGuide({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="guide-title" className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-lg border-0 bg-[#fafbf8] p-0 text-slate-800 shadow-xl backdrop:bg-slate-950/40">
      <div className="flex items-center justify-between border-b border-slate-200 p-6">
        <h2 id="guide-title" className="text-xl font-semibold">Chep — User Guide</h2>
        <button type="button" autoFocus onClick={onClose} aria-label="Close user guide" className="rounded-lg p-2 hover:bg-slate-100"><X size={20} /></button>
      </div>
      <div className="space-y-7 p-6 text-sm leading-7">
        <section><h3 className="font-semibold">1. Add your recordings</h3><p>Choose audio or video files, or drop them into Transcribe. Uploads are saved privately to your 7-day session. You can return to your queue and history after refreshing the page.</p></section>
        <section><h3 className="font-semibold">2. Online GPU status</h3><p>The Kaggle panel reports availability from this app's server. Account linking and GPU processing are still in development. Opening Kaggle settings does not connect your account to this app.</p></section>
        <section><h3 className="font-semibold">3. Manage your queue</h3><p>Remove a waiting file to cancel its job and release stored media. Start and Resume remain unavailable until the GPU worker is implemented.</p></section>
        <section><h3 className="font-semibold">4. Find your transcripts</h3><p>History shows completed, cancelled, and failed jobs. Download TXT is available for completed transcripts while the server retains them.</p></section>
        <section><h3 className="font-semibold">Planned online processing</h3><p>Files are processed sequentially using Whisper models on Kaggle. Recordings of at least 21 minutes will split across two parallel notebooks when capacity allows, combining outputs into a single transcript.</p></section>
      </div>
    </dialog>
  );
}
