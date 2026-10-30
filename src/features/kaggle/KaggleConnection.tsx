import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import type { KaggleAvailability } from './useKaggleStatus';

export function KaggleConnection({ status, loading, error, onRefresh }: {
  status: KaggleAvailability | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <section className="mt-8 border-t border-white/15 pt-6" aria-labelledby="kaggle-heading">
      <h2 id="kaggle-heading" className="flex items-center gap-2 text-xs font-semibold tracking-widest text-emerald-100/70"><ShieldCheck size={16} /> KAGGLE CONNECTION</h2>
      <p className="mt-4 text-lg font-semibold">{loading ? 'Checking availability…' : error ? 'Status unavailable' : 'Not connected'}</p>
      <p id="kaggle-availability" className="mt-2 text-sm leading-6 text-emerald-50/70" role="status">{error || status?.message || 'Checking whether online GPU setup is available.'}</p>
      <div className="mt-4 grid gap-2">
        <button type="button" disabled aria-describedby="kaggle-availability" className="rounded-lg bg-white/10 px-3 py-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50">Connect Kaggle GPU</button>
        <button type="button" disabled aria-describedby="kaggle-availability" className="rounded-lg border border-white/15 px-3 py-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50">Check GPU condition</button>
        <button type="button" disabled={loading} onClick={onRefresh} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-emerald-100 hover:bg-white/10 disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh status</button>
      </div>
      <a href="https://www.kaggle.com/account/login" target="_blank" rel="noreferrer" className="mt-4 flex items-center gap-2 text-xs text-emerald-100 underline underline-offset-4">Create / sign in to Kaggle <ExternalLink size={12} /></a>
      <p className="mt-2 text-xs leading-5 text-emerald-50/60">On Kaggle, open View Active Events to inspect your sessions. Signing in there does not connect this app.</p>
    </section>
  );
}
