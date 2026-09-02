'use client';
/**
 * Forgot password. One field. The confirmation is worded the same whether the
 * address exists or not, because the API tells us the same thing either way.
 */
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Ask for the link; on any 2xx show the same "check your inbox" state. */
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try { await api.auth.forgot(email); setSent(true); }
    catch { setError('We could not send that just now. Try again in a minute.'); }
    finally { setBusy(false); }
  }

  if (sent) {
    return (
      <div>
        <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>Check your inbox.</h1>
        <p style={{ color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>
          If <strong>{email}</strong> has an account, a reset link is on its way. It works for 30 minutes.
          No email? Check spam, then <button type="button" onClick={() => setSent(false)} style={{ font: 'inherit', color: 'var(--accent)', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>try again</button>.
        </p>
        <p style={{ marginTop: 22, fontSize: 14 }}><Link href="/login">Back to sign in</Link></p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>Reset your password.</h1>
      <p style={{ color: 'var(--muted)', marginTop: 10 }}>Enter the email on your account and we&apos;ll send a link.</p>
      <div className="field" style={{ marginTop: 26 }}>
        <label htmlFor="email">Email</label>
        <input id="email" className="inp" type="email" autoComplete="email" autoFocus value={email}
          onChange={(e) => setEmail(e.target.value)} required />
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" type="submit" disabled={busy || !email}>{busy ? 'Sending…' : 'Send reset link'}</button>
      <p style={{ marginTop: 22, fontSize: 14, textAlign: 'center' }}><Link href="/login">Back to sign in</Link></p>
    </form>
  );
}
