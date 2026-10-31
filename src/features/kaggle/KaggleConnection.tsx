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
      <h2 id="kaggle-heading" className="flex items-center gap-2 text-xs font-semibold tracking-widest text-emerald-100/70 uppercase">
        <ShieldCheck size={16} className="text-emerald-300" /> Kaggle connection
      </h2>
      <p className="mt-3 text-base font-semibold text-white">
        {status?.available ? 'Online GPU available' : 'Online GPU unavailable'}
      </p>
      <p className="mt-1 text-xs leading-5 text-emerald-100/70">
        {error || status?.message || (loading ? 'Checking server status…' : 'Kaggle connection has not been configured.')}
      </p>
      <div className="mt-4 space-y-2">
        <a href="https://www.kaggle.com/settings" target="_blank" rel="noreferrer" className="flex w-full items-center justify-between rounded-lg bg-[#2c4439] px-3.5 py-2.5 text-xs font-medium text-white hover:bg-[#385648]">
          <span>Open Kaggle settings</span><ExternalLink size={13} className="text-emerald-300" />
        </a>
        <button type="button" onClick={onRefresh} disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3.5 py-2 text-xs text-emerald-100 hover:bg-white/10 disabled:opacity-60">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh status
        </button>
      </div>
      <p className="mt-4 text-[11px] leading-5 text-emerald-50/50">
        Signing in on Kaggle does not connect this app to your Kaggle account. Account linking and GPU processing are still in development.
      </p>
    </section>
  );
}
