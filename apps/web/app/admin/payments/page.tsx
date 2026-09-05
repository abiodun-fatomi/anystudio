'use client';
/** Every payment; refund marks it after the money went back at the gateway and claws the credits back. */
import { useState } from 'react';
import { api, type AdminPayment } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Pager, useCursorPages, Select, Skeleton, Table, Textarea, tableCell, useToast } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

export default function PaymentsPage() {
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [refund, setRefund] = useState<AdminPayment | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const pages = useCursorPages<AdminPayment>(
    async (cursor, take) => {
      const r = await api.admin.payments({ q: q.trim() || undefined, status: status || undefined, cursor: cursor ?? undefined, take: String(take) });
      return { rows: r.payments, nextCursor: r.nextCursor };
    },
    { deps: [status] },
  );
  const { rows } = pages;
  const search = () => pages.reset();
  const doRefund = async () => {
    if (!refund) return;
    setBusy(true);
    try {
      await api.admin.refundPayment(refund.id, reason.trim());
      toast({ title: 'Marked refunded; credits clawed back', tone: 'ok' });
      setRefund(null);
      setReason('');
      void search();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rise">
      <PageHeader
        title="Payments"
        lede="What was charged, by which gateway, and whether the credits landed. Refund the money at the gateway first, then mark it here."
      />
      <form
        className={styles.toolbar}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="reference · gateway ref · workspace id" />
        <Select
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={['', 'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'].map((s) => ({ value: s, label: s || 'Any status' }))}
        />
        <Button type="submit">Search</Button>
      </form>
      {rows === null ? (
        <Skeleton height={240} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Reference</th>
                <th>Gateway</th>
                <th>Item</th>
                <th>Status</th>
                <th className={tableCell.num}>Credits</th>
                <th className={tableCell.num}>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className={tableCell.shrink}>{new Date(p.createdAt).toLocaleString()}</td>
                  <td className={styles.mono}>
                    {p.reference}
                    <div style={{ color: 'var(--muted)' }}>{p.providerRef ?? ''}</div>
                  </td>
                  <td>{p.provider.toLowerCase()}</td>
                  <td>
                    {p.kind.toLowerCase()} · {p.itemCode}
                  </td>
                  <td>
                    <span className={styles.pill} data-tone={p.status === 'SUCCEEDED' ? 'ok' : p.status === 'FAILED' ? 'danger' : 'warn'}>
                      {p.status}
                    </span>
                    {p.failureReason && <div style={{ fontSize: 'var(--t-1)', color: 'var(--muted)' }}>{p.failureReason.slice(0, 80)}</div>}
                  </td>
                  <td className={tableCell.num}>{p.credits}</td>
                  <td className={tableCell.num}>
                    {(p.amountMinor / 100).toLocaleString()} {p.currency}
                  </td>
                  <td>
                    {atLeast('OPERATOR') && p.status === 'SUCCEEDED' && (
                      <Button variant="ghost" size="sm" onClick={() => setRefund(p)}>
                        Refund
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager
            page={pages.page}
            count={rows.length}
            noun="payments"
            size={pages.size}
            hasOlder={pages.hasOlder}
            hasNewer={pages.hasNewer}
            busy={pages.busy}
            onOlder={() => void pages.older()}
            onNewer={() => void pages.newer()}
            onSize={(n) => void pages.changeSize(n)}
          />
        </>
      )}
      <Dialog
        open={refund !== null}
        onClose={() => setRefund(null)}
        title="Mark this payment refunded"
        description={
          refund
            ? `${refund.credits} credits are clawed back from the workspace (into the negative if already spent). Refund the money at ${refund.provider.toLowerCase()} first — this does not move money.`
            : ''
        }
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRefund(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doRefund} loading={busy} disabled={reason.trim().length < 4}>
              Mark refunded
            </Button>
          </>
        }
      >
        <Textarea label="Reason (on the record)" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} />
      </Dialog>
    </div>
  );
}
