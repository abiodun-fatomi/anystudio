'use client';
/**
 * Sign up. Posts to /auth/register, then lands on /welcome for the three
 * skippable questions.
 *
 * Two consent questions are deliberately separate: "is this number on
 * WhatsApp" is functional and unticked-by-default is not required; "may we
 * message you offers" is marketing and MUST start unticked — Meta rejects
 * pre-ticked consent, and so does the NDPA.
 */
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

/** The exact sentence stored with the consent row. Change it here and the record changes with it. */
const MARKETING_WORDING = 'Send me tips and offers from AnyStudio on WhatsApp. About twice a month. Reply STOP to end it.';

export default function SignupPage() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', whatsapp: true, marketing: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  /** Post the form; on success the API has already set the session cookie. */
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.auth.register({
        name: form.name, email: form.email, phone: form.phone, password: form.password,
        phoneIsWhatsApp: form.whatsapp,
        marketing: { granted: form.marketing, wording: MARKETING_WORDING },
        sourceUrl: typeof window !== 'undefined' ? window.location.href : undefined,
      });
      if (r.status === 'signed_in') router.replace(r.next);
      else if (r.status === 'conflict') setError(r.message);
      else setError('Sign-up is not available on this site.');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.fields?.[0]?.message ?? err.message + (err.requestId ? ` (ref ${err.requestId.slice(0, 8)})` : ''));
      } else setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>Start with three free generations.</h1>
      <p style={{ color: 'var(--muted)', marginTop: 10 }}>No card. Your phone number is your account.</p>

      <div className="field" style={{ marginTop: 26 }}>
        <label htmlFor="name">Your name</label>
        <input id="name" className="inp" autoComplete="name" value={form.name} onChange={set('name')} required />
      </div>
      <div className="field">
        <label htmlFor="phone">Phone number</label>
        <input id="phone" className="inp" type="tel" autoComplete="tel" inputMode="tel" placeholder="+234 801 234 5678"
          value={form.phone} onChange={set('phone')} required />
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 10, fontSize: 14, fontWeight: 500 }}>
          <input type="checkbox" checked={form.whatsapp} onChange={set('whatsapp')} style={{ marginTop: 3 }} />
          <span>This number is on WhatsApp <span style={{ color: 'var(--muted)', fontWeight: 400 }}>— that's where your sheets come back</span></span>
        </label>
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" className="inp" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
      </div>
      <div className="field">
        <label htmlFor="pw">Password</label>
        <input id="pw" className="inp" type="password" autoComplete="new-password" minLength={8}
          value={form.password} onChange={set('password')} required />
      </div>

      {/* Marketing consent: unticked, specific, with a way out. Stored verbatim. */}
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '13px 14px', border: '1px solid var(--line-soft)',
        borderRadius: 'var(--r)', background: 'var(--surface-2)', fontSize: 14, marginBottom: 18 }}>
        <input type="checkbox" checked={form.marketing} onChange={set('marketing')} style={{ marginTop: 3 }} />
        <span>{MARKETING_WORDING}</span>
      </label>

      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" type="submit" style={{ marginTop: 8 }} disabled={busy}>{busy ? "Creating your studio…" : "Create account"}</button>
      <p style={{ textAlign: 'center', marginTop: 18, color: 'var(--muted)', fontSize: 14.5 }}>
        Already have one? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
