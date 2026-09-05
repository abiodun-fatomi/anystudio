'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { isLocalHost, siblingOrigin } from '@/lib/hosts';

/** Where a failed hand-off goes: the sign-in page on the marketing host. */
function signInUrl(next: string | null): string {
  const host = window.location.host;
  const base = isLocalHost(host) ? '' : siblingOrigin(host, '');
  const q = new URLSearchParams({ error: 'handoff_expired' });
  if (next) q.set('next', next);
  return `${base}/login?${q.toString()}`;
}

export function HandoffClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // React strict mode mounts twice in development; the token is single-use.
    if (started.current) return;
    started.current = true;
    const token = params.get('token');
    const next = params.get('next');
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
    if (!token) {
      window.location.replace(signInUrl(safeNext));
      return;
    }
    api.auth
      .handoff(token)
      .then((r) => {
        if (r.status === 'signed_in') router.replace(safeNext ?? r.next);
        else {
          setFailed(true);
          window.location.replace(signInUrl(safeNext));
        }
      })
      .catch(() => {
        setFailed(true);
        window.location.replace(signInUrl(safeNext));
      });
  }, [params, router]);

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', color: 'var(--fg-2, #9a9aa6)', fontSize: 14 }} aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '2px solid currentColor',
            borderRightColor: 'transparent',
            animation: 'as-spin .8s linear infinite',
            display: 'inline-block',
          }}
        />
        {failed ? 'Taking you back to sign in…' : 'Signing you in…'}
      </div>
      <style>{'@keyframes as-spin{to{transform:rotate(360deg)}}'}</style>
    </main>
  );
}
