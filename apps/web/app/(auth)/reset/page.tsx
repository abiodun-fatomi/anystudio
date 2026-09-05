'use client';
/**
 * Reset password, reached from the emailed link (?token=…).
 *
 * The token never leaves this page except in the POST body. It is read from
 * the URL once and the URL is then replaced, so it does not sit in the
 * browser history or get sent as a Referer to anything we link to.
 */
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { PasswordControl } from '@/components/ui/Password';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'form' | 'done' | 'invalid'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Capture the token, then scrub it from the address bar. */
  useEffect(() => {
    const t = params.get('token');
    if (!t) { setState('invalid'); return; }
    setToken(t);
    window.history.replaceState(null, '', '/reset');
  }, [params]);

  /** Submit the new password; a bad or stale token shows the "ask again" state. */
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    if (password !== confirm) { setError('Those two passwords do not match.'); return; }
    setError(null); setBusy(true);
    try {
      const r = await api.auth.reset(token, password);
      setState(r.status === 'reset' ? 'done' : 'invalid');
    } catch { setError('Something went wrong. Try the link again.'); }
    finally { setBusy(false); }
  }

  if (state === 'invalid') {
    return (
      <div>
        <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>That link has expired.</h1>
        <p style={{ color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>
          Reset links work once and for 30 minutes. Ask for a new one and use it straight away.
        </p>
        <Link href="/forgot" className="btn" style={{ marginTop: 22 }}>Send a new link</Link>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div>
        <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>Password changed.</h1>
        <p style={{ color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>
          You&apos;ve been signed out everywhere, including WhatsApp web sessions, so anyone who had your old password is out too.
        </p>
        <button className="btn" style={{ marginTop: 22 }} onClick={() => router.replace('/login')}>Sign in</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>Choose a new password.</h1>
      <p style={{ color: 'var(--muted)', marginTop: 10 }}>At least 8 characters. A short sentence you&apos;ll remember beats a word with numbers.</p>
      <div className="field" style={{ marginTop: 26 }}>
        <label htmlFor="pw">New password</label>
        <PasswordControl id="pw" className="inp" autoComplete="new-password" minLength={8} autoFocus
          value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="pw2">Type it again</label>
        <PasswordControl id="pw2" className="inp" autoComplete="new-password" minLength={8}
          value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" type="submit" disabled={busy || password.length < 8}>{busy ? 'Saving…' : 'Save new password'}</button>
    </form>
  );
}

export default function ResetPage() {
  // useSearchParams needs a Suspense boundary under the App Router.
  return <Suspense fallback={null}><ResetForm /></Suspense>;
}
