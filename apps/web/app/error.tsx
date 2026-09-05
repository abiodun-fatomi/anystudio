'use client';
/** A crash outside the app shell (the sign-in pages, the landing). Plain, and it offers the way back. */
import { useEffect } from 'react';

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('page crashed', error);
  }, [error]);
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        fontFamily: 'var(--f-body)',
        color: 'var(--ink)',
        background: 'var(--paper)',
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ fontFamily: 'var(--f-display)', fontSize: 28, fontWeight: 800, margin: '0 0 10px' }}>This page hit a snag</h1>
        <p style={{ color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 22px' }}>
          Something did not load the way it should. Try again — and if it keeps happening, write to hello@anystudio.ai
          {error.digest ? ` with the reference ${error.digest}` : ''}.
        </p>
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
