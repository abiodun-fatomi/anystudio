/**
 * Sign in with Google.
 *
 * A plain link, not a fetch: the handshake is a top-level navigation to
 * Google and back, so nothing here is a button that calls an API. `next`
 * survives the round trip in the encrypted state cookie the API sets.
 */
'use client';

import { useEffect, useState } from 'react';
import styles from '@/app/(auth)/auth.module.css';
import { isLocalHost, siblingOrigin } from '@/lib/hosts';

export function GoogleButton({ next, label }: { next?: string; label: string }) {
  const path = `/api/v1/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  // The handshake must start and end on the app host, where the session
  // cookie can be set. On the marketing host (where this form lives) the link
  // points across; decided after mount so server and client markup agree.
  const [href, setHref] = useState(path);
  useEffect(() => {
    const host = window.location.host;
    if (isLocalHost(host) || host.startsWith('app.') || host.startsWith('admin.') || host.startsWith('org.')) return;
    setHref(`${siblingOrigin(host, 'app')}${path}`);
  }, [path]);
  return (
    <a className={styles.google} href={href}>
      <svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z" />
        <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 010-3.44V4.95H.96a9 9 0 000 8.1l3.01-2.33z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.9 11.43 0 9 0A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
      </svg>
      {label}
    </a>
  );
}
