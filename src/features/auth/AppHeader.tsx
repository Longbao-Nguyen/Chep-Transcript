import { ChevronRight, LogOut } from 'lucide-react';

import type { AppSession } from '../../types';
import { signOut } from './authActions';

export function AppHeader({ user, page, onGuide }: { user: AppSession['user']; page: string; onGuide: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur-md sm:px-6">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><span className="hidden font-normal text-slate-400 sm:inline">Workspace</span><ChevronRight size={14} className="hidden sm:block" />{page}</p>
            <p className="truncate text-xs text-slate-500">{user.name || user.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onGuide} aria-haspopup="dialog" className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium hover:bg-slate-50">User Guide</button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800 cursor-pointer"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
