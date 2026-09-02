'use client';
/**
 * Today — the first screen after sign-in.
 *
 * Three numbers the owner actually checks (credits, what a sheet costs, how
 * many they can still make), one button that does the thing the product is
 * for, and the last few ledger rows so "where did my credits go" is answered
 * before it is asked.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMe } from '@/lib/useMe';
import { api, type LedgerRow, type WalletSummary } from '@/lib/api';
import styles from './today.module.css';

/** Launch prices, mirrored from the CreditCost seed. Shown, never charged from here. */
const SHEET_COST = 150;

const KIND_LABEL: Record<string, string> = {
  PURCHASE: 'Top-up', DEBIT: 'Generation', REFUND: 'Refund', PROMO: 'Welcome credits',
  EXPIRY: 'Expired', ADJUSTMENT: 'Adjustment',
};

/** Format a ledger delta with its sign, in tabular figures. */
const fmtDelta = (n: number): string => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());

export default function TodayPage() {
  const { me } = useMe();
  const ws = me?.workspaces[0];
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Load balance and the latest ledger rows once the workspace is known. */
  useEffect(() => {
    if (!ws) return;
    let live = true;
    Promise.all([api.wallet.summary(ws.id), api.wallet.history(ws.id)])
      .then(([w, h]) => { if (live) { setWallet(w); setRows(h.rows.slice(0, 8)); } })
      .catch(() => { if (live) setError('Could not load your credits just now.'); });
    return () => { live = false; };
  }, [ws]);

  if (!me) return null;
  const first = me.user.name?.split(' ')[0];
  const sheetsLeft = wallet ? Math.floor(wallet.balance / SHEET_COST) : null;

  return (
    <div>
      <header className={styles.head}>
        <div>
          <h1>{first ? `Good to see you, ${first}.` : 'Today'}</h1>
          <p>{ws?.name ?? 'Your studio'}</p>
        </div>
        <Link href="/billing" className="mono">Credits &amp; billing →</Link>
      </header>

      <div className={styles.grid}>
        <div className={styles.card} data-tour="credits">
          <div className={styles.k}>Credits</div>
          <div className={styles.v}>{wallet ? wallet.balance.toLocaleString() : '—'}</div>
          <div className={styles.s}>{error ?? 'A failed generation always refunds itself.'}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.k}>One product sheet</div>
          <div className={styles.v}>{SHEET_COST}</div>
          <div className={styles.s}>Branded images, description, captions. The reel is extra and priced before you tap.</div>
        </div>
        <div className={styles.card}>
          <div className={styles.k}>Sheets you can make</div>
          <div className={styles.v}>{sheetsLeft ?? '—'}</div>
          <div className={styles.s}>{sheetsLeft === 0 ? 'Top up to keep going.' : 'At today’s prices.'}</div>
        </div>
      </div>

      <section className={styles.cta}>
        <div>
          <h2>Make your first product sheet.</h2>
          <p>One photo, a name and a price. About a minute. It comes back here and on WhatsApp.</p>
        </div>
        <Link href="/create" className="btn" data-tour="create-cta">Create a sheet</Link>
      </section>

      <section className={styles.section}>
        <h2>Recent credit activity <Link href="/billing">Full statement</Link></h2>
        {rows === null && !error && <div className={styles.empty}>Loading…</div>}
        {rows && rows.length === 0 && <div className={styles.empty}>Nothing yet. Your first sheet will show here.</div>}
        {rows && rows.length > 0 && (
          <table className={styles.table}>
            <thead><tr><th>When</th><th>What</th><th style={{ textAlign: 'right' }}>Credits</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td>
                  <td>{r.reason ?? KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className={`${styles.n} ${r.delta > 0 ? styles.pos : styles.neg}`}>{fmtDelta(r.delta)}</td>
                  <td className={styles.n}>{r.balanceAfter.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
