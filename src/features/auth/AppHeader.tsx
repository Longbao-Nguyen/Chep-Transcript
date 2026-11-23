import { useEffect, useRef, useState } from 'react';
import { AudioLines, Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';

import type { TranscriptionModelSummary } from '../../../shared/models';
import type { AppSession } from '../../types';
import { resetSession, signInWithGoogle, signOut } from './authActions';

export function AppHeader({
  user,
  page,
  onGuide,
  models,
  selectedLanguage = 'fr',
  onSelectLanguage,
}: {
  user: AppSession['user'];
  page: string;
  onGuide: () => void;
  models: TranscriptionModelSummary[];
  selectedLanguage?: string;
  onSelectLanguage?: (language: string) => void;
}) {
  const [modelDropdownOpen, setModelDropdownOpen] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('model_open') === '1',
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeModel =
    models.find((item) => item.language === selectedLanguage) || models[0];

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
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2.5 sm:gap-4">
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

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={modelDropdownOpen}
              onClick={() => setModelDropdownOpen((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 hover:border-slate-300"
              title={activeModel ? `Selected model: ${activeModel.label}` : 'Select model'}
            >
              <AudioLines size={14} className="text-emerald-700 shrink-0" />
              <span className="hidden sm:inline text-slate-400">Model:</span>
              <span className="font-semibold text-slate-800">{activeModel?.label ?? 'French'}</span>
              <ChevronDown size={13} className={`text-slate-400 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {modelDropdownOpen && (
              <div
                role="listbox"
                aria-label="Transcription models"
                className="absolute right-0 mt-1.5 w-72 origin-top-right rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg ring-1 ring-black/5 z-50"
              >
                <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  Select Transcription Model
                </div>
                <div className="mt-1 space-y-0.5">
                  {models.map((item) => {
                    const isSelected = item.language === activeModel?.language;
                    return (
                      <button
                        key={item.language}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          onSelectLanguage?.(item.language);
                          setModelDropdownOpen(false);
                        }}
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
                            {item.displayName}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onGuide}
            aria-haspopup="dialog"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 hover:border-slate-300"
          >
            User Guide
          </button>

          {user.id?.startsWith('usr_anon_') ? (
            <button type="button" onClick={() => void signInWithGoogle().catch((error: unknown) => setAuthError(error instanceof Error ? error.message : 'Could not sign in.'))} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              Sign in with Google
            </button>
          ) : (
            <button type="button" onClick={() => void signOut().catch((error: unknown) => setAuthError(error instanceof Error ? error.message : 'Could not sign out.'))} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50">
              Sign out
            </button>
          )}

          {user.id?.startsWith('usr_anon_') && <button
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
