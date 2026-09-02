'use client';
/**
 * Sign in. Password first; if the API says a second factor is owed, the same
 * screen asks for it — no redirect, no lost state. On success the API says
 * where to go, because it knows whether this person has a workspace yet.
 */
import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Handles both steps; which one depends on whether a challenge is open. */
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = challenge ? await api.auth.mfa(challenge, code) : await api.auth.login(identifier, password);
      if (r.status === 'signed_in') return router.replace(next ?? r.next);
      if (r.status === 'mfa_required') return setChallenge(r.challengeId);
      setError(challenge ? 'That code did not match.' : 'Those details did not match an account.');
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.requestId ? ` (ref ${err.requestId.slice(0, 8)})` : ''}` : 'Could not reach AnyStudio.');
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>
        {challenge ? 'One more step.' : 'Welcome back.'}
      </h1>
      <p style={{ color: 'var(--muted)', marginTop: 10 }}>
        {challenge ? 'Enter the six-digit code from your authenticator app.' : 'Your library, brand kits and credits are where you left them.'}
      </p>

      {!challenge ? (
        <>
          <div className="field" style={{ marginTop: 26 }}>
            <label htmlFor="id">Email or phone</label>
            <input id="id" className="inp" autoComplete="username" inputMode="email"
              value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <input id="pw" className="inp" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
            <p style={{ marginTop: 9, textAlign: 'right', fontSize: 13.5 }}><Link href="/forgot">Forgot your password?</Link></p>
          </div>
        </>
      ) : (
        <div className="field" style={{ marginTop: 26 }}>
          <label htmlFor="code">Six-digit code</label>
          <input id="code" className="inp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
            value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
        </div>
      )}

      {error && <p className="err" role="alert">{error}</p>}

      <button className="btn" type="submit" disabled={busy} style={{ marginTop: 8 }}>
        {busy ? 'Checking…' : challenge ? 'Confirm' : 'Sign in'}
      </button>

      <p style={{ textAlign: 'center', marginTop: 18, color: 'var(--muted)', fontSize: 14.5 }}>
        New here? <Link href="/signup">Create an account</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary under the App Router.
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
