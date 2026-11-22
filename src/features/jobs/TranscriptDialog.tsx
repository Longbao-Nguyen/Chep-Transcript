import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Download, Loader2, X } from 'lucide-react';
import type { ClientJob } from '../../types';

interface PreviewPayload {
  jobId: string;
  filename: string;
  text: string;
  truncated?: boolean;
  hasSrt?: boolean;
}

export function TranscriptDialog({
  job,
  onClose,
  onDownload,
}: {
  job: ClientJob;
  onClose: () => void;
  onDownload: (job: ClientJob, format: 'txt' | 'srt') => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [text, setText] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/jobs/${encodeURIComponent(job.id)}/preview`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as (PreviewPayload & { error?: { message?: string } }) | null;
        if (!response.ok || !payload || typeof payload.text !== 'string') {
          throw new Error(payload?.error?.message || 'Could not load transcript preview.');
        }
        if (!controller.signal.aborted) {
          setText(payload.text);
          setTruncated(Boolean(payload.truncated));
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Could not load transcript preview.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [job.id]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard.');
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onCancel={onClose}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%-2rem)] max-w-3xl rounded-2xl border-0 bg-white p-0 shadow-2xl backdrop:bg-slate-950/50"
    >
      <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-base font-bold text-slate-900">
            {job.filename}
          </h2>
          <p className="text-xs text-slate-500">Transcript preview</p>
        </div>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          aria-label="Close preview"
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        >
          <X size={18} />
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript…
          </div>
        ) : error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        ) : (
          <>
            {truncated && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Preview is truncated at 5 MB. Download TXT or SRT for the full file.
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-4 font-mono text-xs leading-6 text-slate-800">
              {text || '(Empty transcript)'}
            </pre>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-6 py-4">
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={loading || Boolean(error) || !text}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy text'}
        </button>
        <button
          type="button"
          onClick={() => onDownload(job, 'txt')}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#294f38] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1c3e2a]"
        >
          <Download size={14} /> Download TXT
        </button>
        {job.hasSrt && (
          <button
            type="button"
            onClick={() => onDownload(job, 'srt')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-700 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-50"
          >
            <Download size={14} /> Download SRT
          </button>
        )}
      </div>
    </dialog>
  );
}
