import { useEffect, useRef, useState } from 'react';
import { AudioLines, Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';

import type { AppSession } from '../../types';
import { resetSession, signInWithGoogle, signOut } from './authActions';

export interface ModelOption {
  id: string;
  label: string;
  model: string;
  description: string;
}

export const TRANSCRIPTION_MODELS: ModelOption[] = [
  {
    id: 'fr',
    label: 'French',
    model: 'bofenghuang/whisper-large-v3-french-distil-dec16',
    description: 'Whisper large-v3 French, distilled',
  },
  {
    id: 'en',
    label: 'English',
    model: 'distil-whisper/distil-large-v3.5-ct2',
    description: 'Distil-Whisper large-v3.5',
  },
  {
    id: 'es',
    label: 'Spanish',
    model: 'adriszmar/whisper-large-v3-turbo-es',
    description: 'Whisper large-v3 turbo Spanish',
  },
  {
    id: 'de',
    label: 'German',
    model: 'primeline/whisper-large-v3-turbo-german',
    description: 'Whisper large-v3 turbo German',
  },
  {
    id: 'vi',
    label: 'Vietnamese',
    model: 'vinai/PhoWhisper-medium',
    description: 'PhoWhisper medium Vietnamese',
  },
];

export function AppHeader({
  user,
  page,
  onGuide,
  selectedModel = 'fr',
  onSelectModel,
}: {
  user: AppSession['user'];
  page: string;
  onGuide: () => void;
  selectedModel?: string;
  onSelectModel?: (modelId: string) => void;
}) {
  const [modelDropdownOpen, setModelDropdownOpen] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('model_open') === '1',
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeModel =
    TRANSCRIPTION_MODELS.find((m) => m.id === selectedModel) || TRANSCRIPTION_MODELS[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setModelDropdownOpen(false);
      }
    }
    if (modelDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [modelDropdownOpen]);

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur-md sm:px-6">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        {/* Workspace + session indicator line */}
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="font-normal text-slate-500">Workspace</span>
          {user.name && user.name !== 'Guest' && user.name !== 'Anonymous Guest' ? (
            <span className="truncate text-xs font-normal text-slate-400 max-w-[140px] sm:max-w-[200px]">
              ({user.name})
            </span>
          ) : (
            <span className="truncate text-xs font-normal text-slate-400">
              (7-day session)
            </span>
          )}
          <ChevronRight size={14} className="shrink-0 text-slate-400" />
          <strong className="font-semibold text-slate-900">{page}</strong>
        </div>

        {/* Right actions: Model Dropdown + User Guide + Reset Session */}
        <div className="flex items-center gap-2.5">
          {/* Transcription Model Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={modelDropdownOpen}
              onClick={() => setModelDropdownOpen((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 hover:border-slate-300"
              title={`Selected model: ${activeModel.label}`}
            >
              <AudioLines size={14} className="text-emerald-700 shrink-0" />
              <span className="hidden sm:inline text-slate-400">Model:</span>
              <span className="font-semibold text-slate-800">{activeModel.label}</span>
              <ChevronDown size={13} className={`text-slate-400 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {modelDropdownOpen && (
              <div
                role="listbox"
                className="absolute right-0 mt-1.5 w-64 origin-top-right rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg ring-1 ring-black/5 z-50 animate-in fade-in zoom-in-95 duration-100"
              >
                <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  Select Transcription Model
                </div>
                <div className="mt-1 space-y-0.5">
                  {TRANSCRIPTION_MODELS.map((item) => {
                    const isSelected = item.id === activeModel.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          if (item.id === 'fr') onSelectModel?.(item.id);
                          setModelDropdownOpen(false);
                        }}
                        disabled={item.id !== 'fr'}
                        className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                          isSelected
                            ? 'bg-emerald-50 text-emerald-900 font-medium'
                            : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-800">{item.label}</span>
                            {isSelected && <Check size={14} className="text-emerald-700 shrink-0" />}
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-500 leading-tight">
                            {item.description}{item.id !== 'fr' ? ' · Planned' : ''}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* User Guide */}
          <button
            type="button"
            onClick={onGuide}
            aria-haspopup="dialog"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 hover:border-slate-300"
          >
            User Guide
          </button>

          {user.id.startsWith('usr_anon_') ? (
            <button type="button" onClick={() => void signInWithGoogle().catch((error: unknown) => setAuthError(error instanceof Error ? error.message : 'Could not sign in.'))} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              Sign in with Google
            </button>
          ) : (
            <button type="button" onClick={() => void signOut().catch((error: unknown) => setAuthError(error instanceof Error ? error.message : 'Could not sign out.'))} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              Sign out
            </button>
          )}

          {/* Reset / New Session */}
          {user.id.startsWith('usr_anon_') && <button
            type="button"
            onClick={() => void resetSession().catch((error: unknown) => setAuthError(error instanceof Error ? error.message : 'Could not reset session.'))}
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-800 cursor-pointer"
            title="Start a new guest session"
            aria-label="Reset session"
          >
            <RotateCcw className="h-4 w-4" />
          </button>}
        </div>
      </div>
      {authError && <p role="alert" className="mx-auto max-w-6xl pt-2 text-xs text-red-700">{authError}</p>}
    </header>
  );
}
