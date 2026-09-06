'use client';
/**
 * Invoicing: every credit line and every invoice, with the two things
 * staff do to an invoice — record a bank transfer, or void it. Terms live
 * on the workspace page, next to the ledger they change.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AdminBillingAccount, type InvoiceView } from '@/lib/api';
import { INVOICE_STATUS, moneyMinor } from '@/lib/billing/money';
import { PageHeader, Section } from '@/components/shell/Page';
import { Badge, Button, Dialog, Input, Pager, Select, Skeleton, Table, Textarea, tableCell, useCursorPages, useToast } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

type Row = InvoiceView & { workspace: { id: string; name: string } };
const ACCOUNT_TONE: Record<string, 'ok' | 'danger' | undefined> = { ACTIVE: 'ok', SUSPENDED: 'danger' };
const day = (iso: string) => new Date(iso).toLocaleDateString();

export default function InvoicingPage() {
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<AdminBillingAccount[] | null>(null);
  const [status, setStatus] = useState('');
  const [act, setAct] = useState<null | { kind: 'paid' | 'void'; inv: Row }>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadAccounts = useCallback(() => {
    api.admin
      .billingAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);
  useEffect(loadAccounts, [loadAccounts]);

  const pages = useCursorPages<Row>((cursor, take) => api.admin.billingInvoices({ status: status || undefined, cursor, take }), { deps: [status] });

  const run = async () => {
    if (!act) return;
    setBusy(true);
    try {
      if (act.kind === 'paid') {
        await api.admin.markInvoicePaid(act.inv.id, reference.trim(), reason.trim());
        toast({ title: `${act.inv.number} marked paid`, body: 'Credits returned to the line; the receipt has gone out.', tone: 'ok' });
      } else {
        await api.admin.voidInvoice(act.inv.id, reason.trim());
        toast({ title: `${act.inv.number} voided`, tone: 'ok' });
      }
      setAct(null);
      setReference('');
      setReason('');
      void pages.reload();
      loadAccounts();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const overdueTotal = accounts?.reduce((n, a) => n + a.open.totalMinor, 0) ?? 0;

  return (
    <div className="rise">
      <PageHeader
        title="Invoicing"
        lede="Organizations on a credit line, and the invoices the first of each month writes for them. Bank transfers are recorded here; terms are set on the workspace."
      />

      <Section title="Credit lines">
        {accounts === null ? (
          <Skeleton height={80} />
        ) : accounts.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>No credit lines yet. Open one from an organization&apos;s workspace page.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Status</th>
                <th>Terms</th>
                <th className={tableCell.num}>Balance</th>
                <th className={tableCell.num}>Limit</th>
                <th className={tableCell.num}>Open</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/admin/workspaces/${a.workspace.id}`}>{a.workspace.name}</Link>
                    {a.billingEmail && <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>{a.billingEmail}</div>}
                  </td>
                  <td className={tableCell.shrink}>
                    <Badge tone={ACCOUNT_TONE[a.status]}>{a.status.toLowerCase()}</Badge>
                  </td>
                  <td style={{ fontSize: 'var(--t-1)', color: 'var(--muted)' }}>
                    {moneyMinor(a.per100Minor, a.currency)}/100{a.negotiated ? ' (negotiated)' : ''} · net {a.netDays} · grace {a.graceDays}
                    {a.minimumMinor > 0 ? ` · min ${moneyMinor(a.minimumMinor, a.currency)}` : ''}
                  </td>
                  <td className={tableCell.num} style={{ color: a.balance < 0 ? 'var(--danger)' : undefined }}>
                    {a.balance.toLocaleString()}
                  </td>
                  <td className={tableCell.num}>{a.creditLimit.toLocaleString()}</td>
                  <td className={tableCell.num}>{a.open.count ? `${a.open.count} · ${moneyMinor(a.open.totalMinor, a.currency)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {accounts && accounts.length > 0 && overdueTotal > 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', marginTop: 'var(--s-2)' }}>Open across all lines, in each currency as listed.</p>
        )}
      </Section>

      <Section title="Invoices">
        <div className={styles.toolbar}>
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={['', 'OPEN', 'OVERDUE', 'PAID', 'VOID'].map((s) => ({ value: s, label: s || 'Any status' }))}
          />
        </div>
        {pages.rows === null ? (
          <Skeleton height={120} />
        ) : pages.rows.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>No invoices{status ? ` with status ${status}` : ' yet'}.</p>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Organization</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th className={tableCell.num}>Credits</th>
                  <th className={tableCell.num}>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pages.rows.map((inv) => (
                  <tr key={inv.id}>
                    <td className={styles.mono}>{inv.number}</td>
                    <td>
                      <Link href={`/admin/workspaces/${inv.workspace.id}`}>{inv.workspace.name}</Link>
                    </td>
                    <td className={tableCell.shrink}>{inv.period}</td>
                    <td className={tableCell.shrink}>
                      <Badge tone={INVOICE_STATUS[inv.status]?.tone}>{inv.status.toLowerCase()}</Badge>
                    </td>
                    <td className={tableCell.shrink}>
                      {inv.status === 'PAID'
                        ? `paid ${inv.paidAt ? day(inv.paidAt) : ''} · ${inv.paidVia?.toLowerCase() ?? ''}`
                        : inv.status === 'VOID'
                          ? '—'
                          : day(inv.dueAt)}
                    </td>
                    <td className={tableCell.num}>{inv.credits.toLocaleString()}</td>
                    <td className={tableCell.num} style={{ fontWeight: 600 }}>
                      {moneyMinor(inv.totalMinor, inv.currency)}
                    </td>
                    <td className={tableCell.shrink}>
                      {inv.payable && atLeast('OPERATOR') && (
                        <span style={{ display: 'inline-flex', gap: 'var(--s-1)' }}>
                          <Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'paid', inv })}>
                            Mark paid
                          </Button>
                          {atLeast('ADMIN') && (
                            <Button size="sm" variant="ghost" onClick={() => setAct({ kind: 'void', inv })}>
                              Void
                            </Button>
                          )}
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
              noun="invoices"
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
      </Section>

      <Dialog
        open={act !== null}
        onClose={() => setAct(null)}
        title={act?.kind === 'paid' ? `Mark ${act.inv.number} as paid` : `Void ${act?.inv.number}`}
        description={
          act?.kind === 'paid'
            ? `${moneyMinor(act.inv.totalMinor, act.inv.currency)} received outside a gateway. The invoiced credits go back to the line and the receipt is emailed.`
            : 'The invoice is cancelled and its credits go back to the line. Issue a corrected one with "Invoice now" on the workspace.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setAct(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void run()} loading={busy} disabled={reason.trim().length < 4 || (act?.kind === 'paid' && reference.trim().length < 2)}>
              {act?.kind === 'paid' ? 'Mark paid' : 'Void invoice'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          {act?.kind === 'paid' && (
            <Input
              label="Payment reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Bank reference / transfer id"
              maxLength={120}
            />
          )}
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} hint="Goes in the audit log." />
        </div>
      </Dialog>
    </div>
  );
}
