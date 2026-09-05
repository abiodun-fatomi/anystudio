'use client';
/**
 * Sign in. Password first; if the API says a second factor is owed, the same
 * screen asks for it — no redirect, no lost state. On success the API says
 * where to go, because it knows whether this person has a workspace yet.
 */
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { PasswordControl } from '@/components/ui/Password';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { followHandoff } from '@/lib/handoff';
import { api, ApiError } from '@/lib/api';
import { GoogleButton } from '@/components/GoogleButton';
import styles from '../auth.module.css';

/**
 * What went wrong on the way back from Google, in words a person can act on.
 * An unlisted code shows nothing: a stray query parameter should not put an
 * alarming message in front of someone who is simply signing in.
 */
const GOOGLE_ERRORS: Record<string, string> = {
  google_declined: 'You cancelled the Google sign-in. You can try again, or use your password.',
  google_expired: 'That took too long. Please try signing in with Google again.',
  google_state: 'We could not verify that sign-in came from us. Please try again.',
  google_rejected: 'Google could not confirm that account. Try again, or sign in with your password.',
  google_email_unverified: 'That Google account has an unconfirmed email address, so we cannot use it to sign in.',
  google_unavailable: 'Google sign-in is not set up yet. Please use your email and password.',
  mfa_required: 'Staff accounts sign in with a password and a second factor, not with Google.',
  handoff_expired: 'That sign-in took too long to finish. Please sign in again.',
};

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  // Which portal host sent them here (org. keeps its own session).
  const to = params.get('to');
  // The Google callback cannot render a page, so it returns here with a code.
  const returned = params.get('error');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(GOOGLE_ERRORS[returned ?? ''] ?? null);
  const [busy, setBusy] = useState(false);
  // The staff console has its own hostname and its own rules: the same
  // account and password as everywhere else, then an authenticator, always.
  // Decided after mount so server and client markup agree.
  const [console_, setConsole] = useState(false);
  useEffect(() => setConsole(window.location.host.startsWith('admin.')), []);

  /** Handles both steps; which one depends on whether a challenge is open. */
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = challenge ? await api.auth.mfa(challenge, code) : await api.auth.login(identifier, password);
      if (r.status === 'signed_in') return router.replace(next ?? r.next);
      if (r.status === 'handoff') return followHandoff(r.url, next, to);
      if (r.status === 'mfa_required') return setChallenge(r.challengeId);
      if (r.status === 'not_staff')
        return setError('That password is right, but this account is not on staff. A superadmin grants access from Staff in the console.');
      if (r.status === 'factor_required')
        return setError('That password is right, but the console needs an authenticator. Add one under Settings → Security on the app, then come back.');
      setError(challenge ? 'That code did not match.' : 'Those details did not match an account.');
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.requestId ? ` (ref ${err.requestId.slice(0, 8)})` : ''}` : 'Could not reach AnyStudio.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>{challenge ? 'One more step.' : console_ ? 'Staff sign-in.' : 'Welcome back.'}</h1>
      <p style={{ color: 'var(--muted)', marginTop: 10 }}>
        {challenge
          ? 'Enter the six-digit code from your authenticator app.'
          : console_
            ? 'The same account and password as the app, then your authenticator — always, on this host.'
            : 'Your library, brand kits and credits are where you left them.'}
      </p>

      {!challenge ? (
        <>
          {!console_ && (
            <>
              <div style={{ marginTop: 26 }}>
                <GoogleButton next={next ?? undefined} label="Continue with Google" />
              </div>
              <div className={styles.or}>or</div>
            </>
          )}

          <div className="field" style={console_ ? { marginTop: 26 } : undefined}>
            <label htmlFor="id">Email or phone</label>
            <input
              id="id"
              className="inp"
              autoComplete="username"
              inputMode="email"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <PasswordControl id="pw" className="inp" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <p style={{ marginTop: 9, textAlign: 'right', fontSize: 13.5 }}>
              <Link href="/forgot">Forgot your password?</Link>
            </p>
          </div>
        </>
      ) : (
        <div className="field" style={{ marginTop: 26 }}>
          <label htmlFor="code">Six-digit code</label>
          <input
            id="code"
            className="inp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            required
          />
        </div>
      )}

      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}

      <button className="btn" type="submit" disabled={busy} style={{ marginTop: 8 }}>
        {busy ? 'Checking…' : challenge ? 'Confirm' : 'Sign in'}
      </button>

      {!console_ && (
        <p style={{ textAlign: 'center', marginTop: 18, color: 'var(--muted)', fontSize: 14.5 }}>
          New here? <Link href="/signup">Create an account</Link>
        </p>
      )}
    </form>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary under the App Router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
