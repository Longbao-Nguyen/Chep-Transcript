import { useRef, useState } from 'react';
import { CloudUpload, Files } from 'lucide-react';

export function MultiFileUploadPanel({ onFiles }: { onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const acceptFiles = (list: FileList | null) => {
    if (!list?.length) return;
    onFiles(Array.from(list));
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Files className="h-5 w-5 text-emerald-700" />
        <h2 className="font-bold text-slate-900">Add your recordings</h2>
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
          onChange={(event) => acceptFiles(event.target.files)}
        />
        <div>
          <CloudUpload className="mx-auto h-9 w-9 text-emerald-700" />
          <p className="mt-3 font-semibold text-slate-800">Drop audio or video files here</p>
          <p className="mt-1 text-xs text-slate-500">Add multiple recordings to your queue.</p>
          <button type="button" onClick={() => inputRef.current?.click()} className="mt-4 rounded-lg bg-[#294f38] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#1c3e2a]">Choose files</button>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Files are stored privately in your account. Uploading does not start transcription.
      </p>
    </section>
  );
}
