'use client';
/**
 * Confirm an email address, from the link in the welcome email.
 *
 * Runs on arrival with no button to press — the person already expressed
 * intent by clicking the link in their inbox, and asking them to confirm the
 * confirmation is a step that only exists to serve the implementation.
 *
 * The token is read once and scrubbed from the address bar so it does not sit
 * in browser history or leak as a Referer.
 */
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type State = 'working' | 'done' | 'invalid';

function Verify() {
  const params = useSearchParams();
  const [state, setState] = useState<State>('working');

  useEffect(() => {
    const token = params.get('token');
    if (!token) { setState('invalid'); return; }
    window.history.replaceState(null, '', '/verify');
    let live = true;
    api.auth.verify(token)
      .then((r) => { if (live) setState(r.status === 'verified' ? 'done' : 'invalid'); })
      .catch(() => { if (live) setState('invalid'); });
    return () => { live = false; };
  }, [params]);

  if (state === 'working') {
    return <p style={{ color: 'var(--muted)' }} aria-live="polite">Confirming your email…</p>;
  }

  if (state === 'done') {
    return (
      <div>
        <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>Email confirmed.</h1>
        <p style={{ color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>
          That&apos;s the recovery path sorted — if you ever lose your password, we can get you back in.
        </p>
        <Link href="/today" className="btn" style={{ marginTop: 22 }}>Open my studio</Link>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>That link has expired.</h1>
      <p style={{ color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>
        Confirmation links work once, and for 24 hours. Sign in and we&apos;ll send you a fresh one.
      </p>
      <Link href="/login" className="btn" style={{ marginTop: 22 }}>Sign in</Link>
    </div>
  );
}

export default function VerifyPage() {
  // useSearchParams needs a Suspense boundary under the App Router.
  return <Suspense fallback={null}><Verify /></Suspense>;
}
