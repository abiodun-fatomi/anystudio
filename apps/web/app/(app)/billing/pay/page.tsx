'use client';
/**
 * The Paddle checkout page. Paddle transactions are created on our API and
 * opened here with Paddle.js — the overlay collects the card on Paddle's
 * side, and this page only knows a transaction id. When the overlay
 * reports completion, we go to /billing/return, which asks the API to
 * verify with Paddle before believing anything.
 *
 * NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is a public, client-side token (not the
 * API key); NEXT_PUBLIC_PADDLE_ENV is "sandbox" or "live".
 */
import { Suspense, useEffect, useState } from 'react';
import Script from 'next/script';
import { useSearchParams } from 'next/navigation';
import { Button, EmptyState } from '@/components/ui';

declare global {
  interface Window {
    Paddle?: {
      Environment: { set: (env: 'sandbox' | 'production') => void };
      Initialize: (o: { token: string; eventCallback?: (e: { name: string; data?: unknown }) => void }) => void;
      Checkout: { open: (o: { transactionId: string; settings?: Record<string, unknown> }) => void };
    };
  }
}

function Pay() {
  const params = useSearchParams();
  const txn = params.get('_ptxn');
  const ref = params.get('ref');
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  const env = process.env.NEXT_PUBLIC_PADDLE_ENV === 'live' ? 'production' : 'sandbox';
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !txn || !token || !window.Paddle) return;
    try {
      window.Paddle.Environment.set(env);
      window.Paddle.Initialize({
        token,
        eventCallback: (e) => {
          if (e.name === 'checkout.completed') window.location.replace(`/billing/return?ref=${encodeURIComponent(ref ?? '')}&_ptxn=${encodeURIComponent(txn)}&status=completed`);
          if (e.name === 'checkout.closed') window.location.replace(`/billing/return?ref=${encodeURIComponent(ref ?? '')}&_ptxn=${encodeURIComponent(txn)}&status=closed`);
          if (e.name === 'checkout.error') setProblem('The payment form reported an error. Nothing was charged.');
        },
      });
      window.Paddle.Checkout.open({ transactionId: txn, settings: { displayMode: 'overlay', theme: 'light', successUrl: `${window.location.origin}/billing/return?ref=${encodeURIComponent(ref ?? '')}&_ptxn=${encodeURIComponent(txn)}&status=completed` } });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not open the payment form.');
    }
  }, [ready, txn, token, env, ref]);

  if (!txn) return <EmptyState title="Nothing to pay" body="Start from Add credits." actions={<Button href="/billing/plans">Add credits</Button>} />;
  if (!token) return <EmptyState title="Card payments are not switched on here" body="NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set for this environment." actions={<Button variant="ghost" href="/billing/plans">Back</Button>} />;
  if (problem) return <EmptyState title="Could not open the payment form" body={problem} actions={<><Button href="/billing/plans">Try again</Button><Button variant="ghost" href="/billing">Credits</Button></>} />;
  return (
    <>
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="afterInteractive" onLoad={() => setReady(true)} onError={() => setProblem('The payment script did not load. Check your connection and try again.')} />
      <div style={{ display: 'grid', gap: 'var(--s-3)', maxWidth: 420, margin: '10vh auto', textAlign: 'center' }}>
        <strong style={{ fontSize: 'var(--t-5)', fontFamily: 'var(--f-display)' }}>Opening the payment form…</strong>
        <span style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Paddle handles the card and the receipt. If nothing appears, allow pop-ups for this site and reload.</span>
        <Button variant="ghost" href="/billing/plans">Cancel</Button>
      </div>
    </>
  );
}

export default function Page() { return <div className="rise"><Suspense fallback={null}><Pay /></Suspense></div>; }
