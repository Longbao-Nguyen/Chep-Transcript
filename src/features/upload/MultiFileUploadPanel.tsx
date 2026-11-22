import { useId, useRef, useState } from 'react';
import { CloudUpload, Cpu, Files } from 'lucide-react';
import type { TranscriptionModelSummary } from '../../../shared/models';

export function MultiFileUploadPanel({
  onFiles,
  models,
  selectedLanguage,
  onSelectLanguage,
}: {
  onFiles: (files: File[]) => void;
  models: TranscriptionModelSummary[];
  selectedLanguage: string;
  onSelectLanguage: (language: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const selectId = useId();
  const selectHintId = useId();

  const activeModel = models.find((item) => item.language === selectedLanguage) ?? models[0];

  const acceptFiles = (list: FileList | null) => {
    if (!list?.length) return;
    onFiles(Array.from(list));
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Files className="h-5 w-5 text-emerald-700" />
            <h1 className="font-bold text-slate-900">Your recordings, ready to transcribe.</h1>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Files are stored privately in your session. Uploading does not start transcription.
          </p>
        </div>

        <div className="sm:w-72 shrink-0">
          <label htmlFor={selectId} className="block text-xs font-semibold text-slate-700">
            Language &amp; model
          </label>
          <p id={selectHintId} className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
            <Cpu className="h-3 w-3 text-emerald-700 shrink-0" />
            <span>{activeModel ? `${activeModel.displayName} · Kaggle T4 GPU` : 'Kaggle T4 GPU'}</span>
          </p>
          <select
            id={selectId}
            name="language"
            value={selectedLanguage}
            onChange={(event) => onSelectLanguage(event.target.value)}
            aria-describedby={selectHintId}
            className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm"
          >
            {models.map((item) => (
              <option key={item.language} value={item.language}>
                {item.label} — {item.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFiles(event.dataTransfer.files); }}
        className={`min-h-52 rounded-xl border-2 border-dashed grid place-items-center px-4 py-6 text-center transition-colors ${dragging ? 'border-emerald-600 bg-emerald-50' : 'border-[#cbd6bf] bg-[#f0f3e9]'}`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          accept="audio/*,video/*,.m4a,.mkv,.wma,.opus,.flac"
          onChange={(event) => acceptFiles(event.target.files)}
        />
        <div>
          <CloudUpload className="mx-auto h-9 w-9 text-emerald-700" />
          <p className="mt-3 font-semibold text-slate-800">Drop audio or video files here</p>
          <p className="mt-1 text-xs text-slate-500">Add multiple recordings to your queue.</p>
          <button type="button" onClick={() => inputRef.current?.click()} className="mt-4 rounded-lg bg-[#294f38] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#1c3e2a]">Choose files</button>
        </div>
      </div>
    </section>
  );
}
