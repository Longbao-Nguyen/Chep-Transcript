import { useId, useState } from 'react';
import { CheckCircle2, Cpu, ExternalLink, LogIn, ShieldCheck } from 'lucide-react';

import type { AppSession } from '../../types';
import { signInWithGoogle } from '../auth/authActions';

export function ColabConnection({
  user,
  onSwitchToKaggle,
}: {
  user: AppSession['user'];
  onSwitchToKaggle?: () => void;
}) {
  const headingId = useId();
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const isGoogleSignedIn = !user.id?.startsWith('usr_anon_');

  const handleGoogleSignIn = async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not start Google sign-in.');
      setSigningIn(false);
    }
  };

  return (
    <section className="mt-8 border-t border-white/15 pt-6" aria-labelledby={headingId}>
      <h2 id={headingId} className="flex items-center gap-2 text-xs font-semibold tracking-widest text-emerald-100/70 uppercase">
        <ShieldCheck size={16} className="text-emerald-300" /> Colab connection
      </h2>

      {isGoogleSignedIn ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-emerald-400/25 bg-[#233d33] p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-white">
              <CheckCircle2 size={16} className="shrink-0 text-emerald-300" />
              <span className="truncate">{user.email || user.name || 'Google account linked'}</span>
            </p>
            <p className="mt-1 text-xs leading-5 text-emerald-100/75">
              Signed in with Google.
            </p>
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-950/50 px-2.5 py-1.5 text-[11px] leading-4 text-amber-100">
              <Cpu size={13} className="mt-0.5 shrink-0" />
              <span>Remote Colab GPU execution from the web app is coming soon. Switch to Kaggle for active T4 transcription.</span>
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm font-semibold text-white">Connect with Google Colab</p>
          <p className="text-xs leading-5 text-emerald-100/70">
            Sign in with your Google account to link Google Colab when browser-based Colab orchestration rolls out.
          </p>

          {authError && (
            <p role="alert" className="rounded-lg border border-red-400/40 bg-red-950/50 px-3 py-2 text-xs text-red-100">
              {authError}
            </p>
          )}

          <button
            type="button"
            disabled={signingIn}
            onClick={() => void handleGoogleSignIn()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            <LogIn size={14} />
            {signingIn ? 'Opening Google…' : 'Sign in with Google'}
          </button>

          <p className="flex items-start gap-1.5 rounded-lg bg-amber-950/50 px-2.5 py-2 text-[11px] leading-4 text-amber-100">
            <Cpu size={13} className="mt-0.5 shrink-0" />
            <span>Colab web worker execution is not yet supported; use Kaggle for immediate T4 GPU transcription.</span>
          </p>
        </div>
      )}

      <div className="mt-3 space-y-2">
        <a
          href="https://colab.research.google.com/"
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center justify-between rounded-lg bg-[#2c4439] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#385648]"
        >
          <span>Open Google Colab</span>
          <ExternalLink size={13} className="text-emerald-300" />
        </a>
        {onSwitchToKaggle && (
          <button
            type="button"
            onClick={onSwitchToKaggle}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3.5 py-2 text-xs text-emerald-100 hover:bg-white/10"
          >
            Use Kaggle T4 GPU
          </button>
        )}
      </div>
    </section>
  );
}
