'use client';
/**
 * Back from the payment page. Asks the API to verify (the API asks the
 * gateway, never us), then polls for a short while in case the webhook is
 * the one that lands first. The person sees one of three things: credits
 * added, still confirming, or it did not go through — and in every case
 * the reference to quote.
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/app-context';
import { api, type PaymentView } from '@/lib/api';
import { moneyMinor } from '@/lib/billing/money';
import { Button, EmptyState, Progress } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

const POLL_MS = [1500, 2500, 4000, 6000, 8000, 10000, 10000, 10000];

function Return() {
  const params = useSearchParams();
  const { workspace, refreshBalance } = useApp();
  const ref = params.get('ref');
  const providerRef = params.get('transaction_id') ?? params.get('_ptxn') ?? undefined;
  const gatewayStatus = params.get('status');
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    if (!ref) return;
    let live = true;
    let paymentId: string | null = null;
    try { paymentId = sessionStorage.getItem(`anystudio:pay:${ref}`); } catch { /* fine */ }
    const tick = async () => {
      if (!live) return;
      try {
        if (!paymentId) {
          const list = await api.billing.payments(workspace.id);
          // PENDING rows are not in the settled list; ask the verify endpoint by reference through the newest rows first.
          paymentId = list.rows.find((r) => r.reference === ref)?.id ?? null;
        }
        if (!paymentId) throw new Error('unknown reference');
        const p = await api.billing.verify(workspace.id, paymentId, providerRef);
        if (!live) return;
        setPayment(p);
        if (p.status !== 'PENDING') { void refreshBalance(); return; }
      } catch { /* try again below */ }
      const delay = POLL_MS[attempt.current++];
      if (delay === undefined) { setGaveUp(true); return; }
      setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => { live = false; };
  }, [ref, providerRef, workspace.id, refreshBalance]);

  if (!ref) return <EmptyState title="Nothing to confirm" body="This page is where the payment provider sends you back. Start from Add credits." actions={<Button href="/billing/plans">Add credits</Button>} />;

  if (payment?.status === 'SUCCEEDED') {
    return <EmptyState icon={<Icon.check />} title={`${payment.credits.toLocaleString()} credits added`} body={`${moneyMinor(payment.amountMinor, payment.currency)} · reference ${payment.reference}. The receipt is on your Credits page.`} actions={<><Button href="/studio">Back to the studio</Button><Button variant="ghost" href="/billing">See statement</Button></>} />;
  }
  if (payment?.status === 'FAILED' || (gaveUp && gatewayStatus && gatewayStatus !== 'successful' && gatewayStatus !== 'completed')) {
    return <EmptyState icon={<Icon.credits />} title="That payment did not go through" body={`Nothing was charged${payment?.failureReason ? ` (${payment.failureReason})` : ''}. Reference ${ref}. You can try again, or a different way to pay.`} actions={<><Button href="/billing/plans">Try again</Button><Button variant="ghost" href="/billing">Credits</Button></>} />;
  }
  if (gaveUp) {
    return <EmptyState icon={<Icon.credits />} title="Still confirming" body={`The payment provider has not confirmed it yet. Credits arrive automatically once it does — usually within minutes. If they have not by tomorrow, quote reference ${ref} to support.`} actions={<><Button href="/billing">See statement</Button><Button variant="ghost" onClick={() => window.location.reload()}>Check again</Button></>} />;
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--s-3)', maxWidth: 420, margin: '10vh auto', textAlign: 'center' }}>
      <strong style={{ fontSize: 'var(--t-5)', fontFamily: 'var(--f-display)' }}>Confirming your payment…</strong>
      <Progress value={null} label="Confirming" />
      <span style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>We check with the payment provider directly, so this can take a few seconds. Reference {ref}.</span>
    </div>
  );
}

export default function Page() { return <div className="rise"><Suspense fallback={null}><Return /></Suspense></div>; }
