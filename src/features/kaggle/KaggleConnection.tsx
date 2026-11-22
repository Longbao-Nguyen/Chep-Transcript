import { useId, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, Cpu, ExternalLink, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import type { ConnectKaggleInput, KaggleStatus } from './useKaggleStatus';

export function KaggleConnection({
  status,
  loading,
  submitting,
  error,
  onRefresh,
  onConnect,
  onCheckGpu,
  onDisconnect,
}: {
  status: KaggleStatus | null;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  onRefresh: () => void;
  onConnect: (input: ConnectKaggleInput) => Promise<unknown>;
  onCheckGpu?: () => Promise<unknown>;
  onDisconnect: () => Promise<unknown>;
}) {
  const headingId = useId();
  const tokenId = useId();
  const tokenHintId = useId();
  const formErrorId = useId();

  const [apiToken, setApiToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [invalidToken, setInvalidToken] = useState(false);

  const tokenRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedToken = apiToken.trim();

    if (!trimmedToken) {
      setInvalidToken(true);
      setFormError('Enter your Kaggle API token (KGAT_...).');
      tokenRef.current?.focus();
      return;
    }

    if (!trimmedToken.startsWith('KGAT_') && !trimmedToken.startsWith('{')) {
      setInvalidToken(true);
      setFormError('Enter your Kaggle API token starting with KGAT_.');
      tokenRef.current?.focus();
      return;
    }

    setFormError(null);
    setInvalidToken(false);
    try {
      await onConnect({ apiToken: trimmedToken });
      setApiToken('');
    } catch (cause) {
      setInvalidToken(true);
      setFormError(cause instanceof Error ? cause.message : 'Could not verify Kaggle credentials.');
      tokenRef.current?.focus();
    }
  };

  const activeError = formError || error;
  const isConnected = Boolean(status?.connected);

  return (
    <section className="mt-8 border-t border-white/15 pt-6" aria-labelledby={headingId}>
      <h2 id={headingId} className="flex items-center gap-2 text-xs font-semibold tracking-widest text-emerald-100/70 uppercase">
        <ShieldCheck size={16} className="text-emerald-300" /> Kaggle connection
      </h2>

      {isConnected ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-emerald-400/25 bg-[#233d33] p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-white">
              <CheckCircle2 size={16} className="shrink-0 text-emerald-300" />
              <span>{status?.username ? `Connected as ${status.username}` : 'Kaggle connected'}</span>
            </p>
            <p className="mt-1 text-xs leading-5 text-emerald-100/75">
              Auth mode: {status?.authMode === 'oauth2' ? 'OAuth 2.0' : 'Personal API Token'}
            </p>
            {status?.gpuStatus && status.gpuStatus !== 'unchecked' && (
              <p className={`mt-2 rounded-lg px-2.5 py-1.5 text-[11px] leading-4 ${
                status.gpuStatus === 'ready'
                  ? 'bg-emerald-950/60 text-emerald-200'
                  : status.gpuStatus === 'error'
                    ? 'bg-red-950/60 text-red-100'
                    : 'bg-amber-950/50 text-amber-100'
              }`}>
                {status.gpuMessage || (status.gpuStatus === 'ready' ? 'Kaggle T4 GPU confirmed.' : 'Checking GPU…')}
              </p>
            )}
          </div>

          {activeError && (
            <p role="alert" className="rounded-lg border border-red-400/40 bg-red-950/50 px-3 py-2 text-xs text-red-100">
              {activeError}
            </p>
          )}

          <div className="space-y-2">
            {onCheckGpu && (
              <button
                type="button"
                onClick={() => void onCheckGpu()}
                disabled={submitting || status?.gpuStatus === 'checking'}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#2c4439] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#385648] disabled:opacity-60"
              >
                <Cpu size={13} className={status?.gpuStatus === 'checking' ? 'animate-pulse' : ''} />
                {status?.gpuStatus === 'checking' ? 'Checking GPU…' : 'Check GPU condition'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void onDisconnect()}
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-300/30 bg-red-950/30 px-3.5 py-2 text-xs font-medium text-red-100 hover:bg-red-950/50 disabled:opacity-60"
            >
              <Unplug size={13} /> {submitting ? 'Disconnecting…' : 'Disconnect Kaggle'}
            </button>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading || submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3.5 py-2 text-xs text-emerald-100 hover:bg-white/10 disabled:opacity-60"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh status
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm font-semibold text-white">Connect with Kaggle API Token</p>
          <p className="mt-1 text-xs leading-5 text-emerald-100/70">
            {status?.message || (loading ? 'Checking connection…' : 'Create a personal API token (KGAT_...) in Kaggle Settings to unlock T4 GPU transcription.')}
          </p>

          <form method="POST" onSubmit={(event) => void handleSubmit(event)} aria-labelledby={headingId} className="mt-4 space-y-3" noValidate>
            <div>
              <label htmlFor={tokenId} className="block text-xs font-medium text-emerald-100">
                Kaggle API Token <span aria-hidden="true">*</span>
              </label>
              <p id={tokenHintId} className="mt-0.5 text-[11px] leading-4 text-emerald-100/60">
                Paste your <code className="text-emerald-200">KGAT_...</code> token from Kaggle Settings. Stored encrypted with AES-256-GCM.
              </p>
              <div className="relative mt-1.5">
                <input
                  ref={tokenRef}
                  id={tokenId}
                  name="kaggleApiToken"
                  type={showToken ? 'text' : 'password'}
                  value={apiToken}
                  onChange={(event) => {
                    setApiToken(event.target.value);
                    if (invalidToken) {
                      setInvalidToken(false);
                      setFormError(null);
                    }
                  }}
                  required
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  aria-describedby={activeError ? `${tokenHintId} ${formErrorId}` : tokenHintId}
                  aria-invalid={invalidToken ? 'true' : undefined}
                  placeholder="KGAT_..."
                  className="w-full rounded-lg border border-white/20 bg-[#10221d] py-2 pl-3 pr-10 text-base sm:text-xs text-white placeholder:text-emerald-100/35"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((prev) => !prev)}
                  aria-pressed={showToken}
                  aria-label={showToken ? 'Hide API token' : 'Show API token'}
                  className="absolute inset-y-0 right-1 flex items-center justify-center rounded px-2 text-emerald-100/70 hover:text-white"
                >
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {activeError && (
              <p id={formErrorId} role="alert" className="rounded-lg border border-red-400/40 bg-red-950/50 px-3 py-2 text-xs text-red-100">
                {activeError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
            >
              <KeyRound size={14} />
              {submitting ? 'Verifying token…' : 'Connect Kaggle'}
            </button>
          </form>

          {status?.oauthEnabled && (
            <button
              type="button"
              disabled
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3.5 py-2 text-xs text-emerald-100/70"
            >
              Connect with Kaggle OAuth (coming soon)
            </button>
          )}

          <div className="mt-3 space-y-2">
            <a
              href="https://www.kaggle.com/settings"
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-between rounded-lg bg-[#2c4439] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#385648]"
            >
              <span>Get token in Kaggle settings</span>
              <ExternalLink size={13} className="text-emerald-300" />
            </a>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading || submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3.5 py-2 text-xs text-emerald-100 hover:bg-white/10 disabled:opacity-60"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh status
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
