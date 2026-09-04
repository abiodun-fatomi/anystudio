'use client';
/**
 * Credits: the balance, and the ledger as a readable statement — every row
 * says what it was, when, how much, and the balance after. Plans and
 * top-ups arrive with payments; this screen is what makes them trustworthy.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/app-context';
import { api, type LedgerRow } from '@/lib/api';
import { PageHeader, Section } from '@/components/shell/Page';
import { Badge, Button, Card, EmptyState, Pagination, Skeleton, Stat, Table, tableCell } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

const KIND: Record<string, { label: string; tone?: 'ok' | 'warn' | 'danger' | 'accent' }> = {
  PURCHASE: { label: 'Top-up', tone: 'ok' }, DEBIT: { label: 'Generation' }, REFUND: { label: 'Refund', tone: 'ok' },
  PROMO: { label: 'Welcome credits', tone: 'accent' }, EXPIRY: { label: 'Expired', tone: 'warn' }, ADJUSTMENT: { label: 'Adjustment', tone: 'warn' },
};
const fmt = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function BillingPage() {
  const { workspace, balance, setBalance } = useApp();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (after?: string) => {
    try {
      const [w, h] = await Promise.all([api.wallet.summary(workspace.id), api.wallet.history(workspace.id, after)]);
      setBalance(w.balance);
      setRows((r) => (after && r ? [...r, ...h.rows] : h.rows));
      setCursor(h.nextCursor);
      setError(null);
    } catch {
      setError('Could not load your statement just now.');
    } finally {
      setMore(false);
    }
  }, [workspace.id, setBalance]);

  useEffect(() => { setRows(null); void load(); }, [load]);

  return (
    <div className="rise">
      <PageHeader title="Credits" lede="Every credit in and out, newest first. A failed generation always comes back as a refund row." actions={<Button href="/billing/plans" leading={<Icon.plus />}>Add credits</Button>} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 'var(--s-4)' }}>
        <Card><Stat label="Balance" value={balance === null ? <Skeleton width={90} height={36} /> : balance.toLocaleString()} sub="credits available now" /></Card>
        <Card><Stat label="Currency" value={workspace.currency} sub="fixed for this workspace" /></Card>
      </div>

      <Section title="Statement">
        {error && <EmptyState title={error} actions={<Button variant="ghost" onClick={() => void load()}>Try again</Button>} />}
        {!error && rows === null && (
          <div style={{ display: 'grid', gap: 'var(--s-2)' }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={44} />)}</div>
        )}
        {!error && rows && rows.length === 0 && <EmptyState icon={<Icon.credits />} title="No movements yet" body="Your first generation will show here as a debit — and as a refund if it fails." />}
        {!error && rows && rows.length > 0 && (
          <>
            <Table>
              <thead><tr><th>When</th><th>What</th><th>Note</th><th className={tableCell.num}>Credits</th><th className={tableCell.num}>Balance</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={tableCell.shrink}>{when(r.createdAt)}</td>
                    <td className={tableCell.shrink}><Badge tone={KIND[r.kind]?.tone}>{KIND[r.kind]?.label ?? r.kind}</Badge></td>
                    <td style={{ color: 'var(--muted)' }}>{r.reason ?? '—'}</td>
                    <td className={tableCell.num} style={{ color: r.delta > 0 ? 'var(--ok)' : undefined, fontWeight: 600 }}>{fmt(r.delta)}</td>
                    <td className={tableCell.num}>{r.balanceAfter.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination>
              <span>{rows.length} row{rows.length === 1 ? '' : 's'}</span>
              {cursor && <Button variant="ghost" size="sm" loading={more} onClick={() => { setMore(true); void load(cursor); }}>Show older</Button>}
            </Pagination>
          </>
        )}
      </Section>
    </div>
  );
}
