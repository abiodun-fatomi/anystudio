'use client';
/**
 * Finish an email change, from the link in the NEW inbox. Public: the
 * person may well open it on a phone that is not signed in. Same shape as
 * /verify — runs on arrival, scrubs the token from the address bar.
 */
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type State = 'working' | 'done' | 'invalid';

function EmailChange() {
  const params = useSearchParams();
  const [state, setState] = useState<State>('working');
  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setState('invalid');
      return;
    }
    window.history.replaceState(null, '', '/email-change');
    let live = true;
    api.account
      .confirmEmailChange(token)
      .then((r) => {
        if (live) setState(r.status === 'changed' ? 'done' : 'invalid');
      })
      .catch(() => {
        if (live) setState('invalid');
      });
    return () => {
      live = false;
    };
  }, [params]);

  if (state === 'working')
    return (
      <p style={{ color: 'var(--muted)' }} aria-live="polite">
        Switching your email…
      </p>
    );
  if (state === 'done') {
    return (
      <div>
        <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>Email changed.</h1>
        <p style={{ color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>This address now signs you in and gets your receipts. We told the old one.</p>
        <Link href="/today" className="btn" style={{ marginTop: 22 }}>
          Open my studio
        </Link>
      </div>
    );
  }
  return (
    <div>
      <h1 style={{ fontSize: 'clamp(27px,3.6vw,34px)', fontWeight: 800 }}>That link has expired.</h1>
      <p style={{ color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>
        Email-change links work once, for 24 hours, and only if nobody has taken that address since. Start again from Settings.
      </p>
      <Link href="/settings/profile" className="btn" style={{ marginTop: 22 }}>
        Open Settings
      </Link>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <EmailChange />
    </Suspense>
  );
}
