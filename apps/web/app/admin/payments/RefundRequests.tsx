'use client';
/**
 * Refund requests waiting for a decision. Approve sends the money back at
 * the gateway and claws the credits back in one go; refuse needs a sentence
 * the customer reads. A request whose credits have since been spent cannot
 * be approved, and says so before anyone tries.
 */
import { useState } from 'react';
import Link from 'next/link';
import { api, type AdminRefundRequest } from '@/lib/api';
import { moneyMinor } from '@/lib/billing/money';
import { Badge, Button, Dialog, Pager, Select, Skeleton, Table, Textarea, tableCell, useCursorPages, useToast } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

const TONE: Record<string, 'accent' | 'ok' | 'danger' | undefined> = { REQUESTED: 'accent', APPROVED: 'ok', REFUSED: 'danger', CANCELLED: undefined };

export function RefundRequests() {
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [status, setStatus] = useState('REQUESTED');
  const [act, setAct] = useState<null | { kind: 'approve' | 'refuse'; r: AdminRefundRequest }>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pages = useCursorPages<AdminRefundRequest>((cursor, take) => api.admin.refunds({ status, cursor, take }), { size: 25, deps: [status] });

  const run = async () => {
    if (!act) return;
    setBusy(true);
    try {
      if (act.kind === 'approve') {
        await api.admin.approveRefund(act.r.id, note.trim() || undefined);
        toast({ title: 'Refunded', body: 'Money sent back at the gateway; credits clawed back; the customer has been told.', tone: 'ok' });
      } else {
        await api.admin.refuseRefund(act.r.id, note.trim());
        toast({ title: 'Refused', body: 'The customer has been told, with your sentence.', tone: 'ok' });
      }
      setAct(null);
      setNote('');
      void pages.reload();
    } catch (e) {
      toast({ title: 'Not done', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginBottom: 'var(--s-6)' }}>
      <div className={styles.toolbar} style={{ alignItems: 'end' }}>
        <div>
          <div className={styles.cardTitle}>Refund requests</div>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>
            Approve sends the money back at the gateway and removes the credits. Refuse with a sentence the customer reads.
          </div>
        </div>
        <Select
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={['REQUESTED', 'APPROVED', 'REFUSED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
        />
      </div>
      {pages.rows === null ? (
        <Skeleton height={80} />
      ) : pages.rows.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Nothing {status.toLowerCase()}.</p>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Workspace</th>
                <th>Purchase</th>
                <th>Reason</th>
                <th className={tableCell.num}>Credits</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pages.rows.map((r) => (
                <tr key={r.id}>
                  <td className={tableCell.shrink}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <Link href={`/admin/workspaces/${r.workspace.id}`}>{r.workspace.name}</Link>
                    <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>{r.requester?.email ?? r.requester?.name ?? ''}</div>
                  </td>
                  <td>
                    <div className={styles.mono}>{r.payment.reference}</div>
                    <div style={{ fontSize: 'var(--t-1)', color: 'var(--muted)' }}>
                      {r.payment.kind.toLowerCase()} · {r.payment.itemCode} · {moneyMinor(r.payment.amountMinor, r.payment.currency)} ·{' '}
                      {r.payment.provider.toLowerCase()}
                    </div>
                  </td>
                  <td style={{ fontSize: 'var(--t-2)', maxWidth: 320 }}>
                    {r.reason}
                    {r.status !== 'REQUESTED' && r.decisionNote && <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>→ {r.decisionNote}</div>}
                  </td>
                  <td className={tableCell.num}>
                    {r.payment.credits}
                    <div style={{ fontSize: 'var(--t-1)', color: r.stillRefundable ? 'var(--muted)' : 'var(--danger)' }}>balance {r.balanceNow}</div>
                  </td>
                  <td className={tableCell.shrink}>
                    <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
                  </td>
                  <td className={tableCell.shrink}>
                    {r.status === 'REQUESTED' && atLeast('OPERATOR') && (
                      <span style={{ display: 'inline-flex', gap: 'var(--s-1)' }}>
                        <Button
                          size="sm"
                          onClick={() => setAct({ kind: 'approve', r })}
                          disabled={!r.stillRefundable || !r.gatewayConfigured}
                          title={
                            !r.stillRefundable
                              ? 'Credits were spent since the request'
                              : !r.gatewayConfigured
                                ? `${r.payment.provider} is not configured here`
                                : undefined
                          }
                        >
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'refuse', r })}>
                          Refuse
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager
            page={pages.page}
            count={pages.rows.length}
            noun="requests"
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
        open={act !== null}
        onClose={() => setAct(null)}
        title={act?.kind === 'approve' ? 'Approve the refund?' : 'Refuse the refund'}
        description={
          act?.kind === 'approve'
            ? `${moneyMinor(act.r.payment.amountMinor, act.r.payment.currency)} goes back through ${act.r.payment.provider.toLowerCase()} now, and ${act.r.payment.credits} credits are removed from ${act.r.workspace.name}.`
            : 'The customer reads this sentence in an email. Say what would change the answer.'
        }
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAct(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void run()} loading={busy} disabled={act?.kind === 'refuse' && note.trim().length < 4}>
              {act?.kind === 'approve' ? 'Send the money back' : 'Refuse'}
            </Button>
          </>
        }
      >
        <Textarea
          label={act?.kind === 'approve' ? 'Note (optional, goes to the gateway)' : 'What the customer reads'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={300}
        />
      </Dialog>
    </section>
  );
}
