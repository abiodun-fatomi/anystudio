'use client';
/** Every payment, plus the audited refund-request workflow. */
import { useState } from 'react';
import { api, type AdminPayment } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Input, Pager, useCursorPages, Select, Skeleton, Table, tableCell } from '@/components/ui';
import styles from '../admin.module.css';
import { RefundRequests } from './RefundRequests';

export default function PaymentsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const pages = useCursorPages<AdminPayment>(
    async (cursor, take) => {
      const r = await api.admin.payments({ q: q.trim() || undefined, status: status || undefined, cursor: cursor ?? undefined, take: String(take) });
      return { rows: r.payments, nextCursor: r.nextCursor };
    },
    { deps: [status] },
  );
  const { rows } = pages;
  const search = () => pages.reset();
  return (
    <div className="rise">
      <PageHeader
        title="Payments"
        lede="What was charged, by which gateway, and whether the credits landed. Refunds use the audited request workflow and are finalized only after provider confirmation."
      />
      <RefundRequests />
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
          options={['', 'PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'REFUNDED'].map((s) => ({ value: s, label: s || 'Any status' }))}
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
    </div>
  );
}
