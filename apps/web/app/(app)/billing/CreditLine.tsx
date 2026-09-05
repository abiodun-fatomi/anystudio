'use client';
/**
 * The postpaid organization's view of money: the credit line and how much
 * of it this period has used, what the invoice will roughly be, and the
 * invoices themselves. Everything here is read from the ledger the same way
 * a prepaid balance is — the difference is only that the line may be drawn
 * on before it is paid for.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AccountOverview, type BillTo, type InvoiceView } from '@/lib/api';
import { INVOICE_STATUS, moneyMinor } from '@/lib/billing/money';
import { Section } from '@/components/shell/Page';
import { Badge, Button, Card, Dialog, Input, Pager, Progress, Skeleton, Stat, Table, tableCell, Textarea, useCursorPages, useToast } from '@/components/ui';
import styles from './credit-line.module.css';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function CreditLine({
  workspaceId,
  canBuy,
  overview,
  onChanged,
}: {
  workspaceId: string;
  canBuy: boolean;
  overview: AccountOverview;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const account = overview.account!;
  const period = overview.period!;
  const open = overview.open!;
  const used = period.creditLimit > 0 ? Math.min(100, Math.max(0, (-period.balance / period.creditLimit) * 100)) : 0;
  const [details, setDetails] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);

  const invoices = useCursorPages<InvoiceView>((cursor, take) => api.billing.invoices(workspaceId, cursor, take), { size: 25, deps: [workspaceId] });

  const pay = async (inv: InvoiceView) => {
    setPaying(inv.id);
    try {
      const out = await api.billing.payInvoice(workspaceId, inv.id);
      window.location.assign(out.url);
    } catch (e) {
      toast({ title: 'Could not open the payment page', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
      setPaying(null);
    }
  };

  return (
    <>
      {account.status === 'SUSPENDED' && (
        <div className={styles.paused} role="alert">
          <span className={styles.bang} aria-hidden="true">
            !
          </span>
          <div>
            <strong>New work is paused.</strong> {open.count === 1 ? 'An invoice is' : `${open.count} invoices are`} overdue (
            {moneyMinor(open.totalMinor, account.currency)}). Everything resumes the moment it is paid.
          </div>
        </div>
      )}

      <div className={styles.stats}>
        <Card>
          <Stat
            label="This period"
            value={period.credits.toLocaleString()}
            sub={`credits used since ${day(period.start)} · about ${moneyMinor(period.estimateMinor, account.currency)}`}
          />
        </Card>
        <Card>
          <Stat label="Credit line" value={period.available.toLocaleString()} sub={`of ${period.creditLimit.toLocaleString()} credits still available`} />
          <Progress value={used} className={styles.lineBar} label="Credit line used" detail={`${Math.round(used)}% used`} />
        </Card>
        <Card>
          <Stat
            label="Open invoices"
            value={open.count === 0 ? 'None' : moneyMinor(open.totalMinor, account.currency)}
            sub={
              open.count === 0
                ? 'nothing to pay right now'
                : `${open.count} invoice${open.count === 1 ? '' : 's'} · due within ${account.netDays} days of issue`
            }
          />
        </Card>
        <Card>
          <Stat
            label="Rate"
            value={moneyMinor(account.per1000Minor, account.currency)}
            sub={`per 1,000 credits${account.negotiated ? ' · your rate' : ''}${account.minimumMinor > 0 ? ` · ${moneyMinor(account.minimumMinor, account.currency)} monthly minimum` : ''}`}
          />
        </Card>
      </div>

      {period.lines.length > 0 && (
        <Section title="Used so far this period">
          <p className={styles.lede}>What the next invoice will carry, priced at your rate. Refunds for failed work come off the same line.</p>
          <Table>
            <thead>
              <tr>
                <th>What</th>
                <th className={tableCell.num}>Made</th>
                <th className={tableCell.num}>Credits</th>
                <th className={tableCell.num}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {period.lines.map((l) => (
                <tr key={l.costCode}>
                  <td>{l.label}</td>
                  <td className={tableCell.num}>{l.requests.toLocaleString()}</td>
                  <td className={tableCell.num}>{l.credits.toLocaleString()}</td>
                  <td className={tableCell.num}>{moneyMinor(l.amountMinor, account.currency)}</td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <td>So far</td>
                <td />
                <td className={tableCell.num}>{period.credits.toLocaleString()}</td>
                <td className={tableCell.num}>{moneyMinor(period.estimateMinor, account.currency)}</td>
              </tr>
            </tbody>
          </Table>
        </Section>
      )}

      <Section
        title="Invoices"
        aside={
          canBuy ? (
            <Button variant="ghost" size="sm" onClick={() => setDetails(true)} className={styles.aside}>
              Billing details
            </Button>
          ) : undefined
        }
      >
        <p className={styles.lede}>
          Issued on the first of each month for the month before.{' '}
          {account.billingEmail ? `Sent to ${account.billingEmail} and the owners.` : 'Sent to the owners.'}
        </p>
        {invoices.rows === null ? (
          <Skeleton height={44} />
        ) : invoices.rows.length === 0 ? (
          <p className={styles.quiet}>No invoices yet. The first one arrives on the 1st of next month, for everything used from {day(period.start)}.</p>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th className={tableCell.num}>Credits</th>
                  <th className={tableCell.num}>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invoices.rows.map((inv) => (
                  <tr key={inv.id}>
                    <td className={tableCell.shrink}>
                      <Link href={`/billing/invoices/${inv.id}`} className={styles.number}>
                        {inv.number}
                      </Link>
                    </td>
                    <td>{inv.period}</td>
                    <td className={tableCell.shrink}>
                      <Badge tone={INVOICE_STATUS[inv.status]?.tone}>{INVOICE_STATUS[inv.status]?.label ?? inv.status}</Badge>
                    </td>
                    <td className={tableCell.shrink}>
                      {inv.status === 'PAID' ? `paid ${inv.paidAt ? day(inv.paidAt) : ''}` : inv.status === 'VOID' ? '—' : day(inv.dueAt)}
                    </td>
                    <td className={tableCell.num}>{inv.credits.toLocaleString()}</td>
                    <td className={tableCell.num} style={{ fontWeight: 600 }}>
                      {moneyMinor(inv.totalMinor, inv.currency)}
                    </td>
                    <td className={tableCell.shrink}>
                      {inv.payable && canBuy ? (
                        <Button size="sm" loading={paying === inv.id} onClick={() => void pay(inv)}>
                          Pay
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" href={`/billing/invoices/${inv.id}`}>
                          Open
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              page={invoices.page}
              count={invoices.rows.length}
              noun="invoices"
              size={invoices.size}
              hasOlder={invoices.hasOlder}
              hasNewer={invoices.hasNewer}
              busy={invoices.busy}
              onOlder={() => void invoices.older()}
              onNewer={() => void invoices.newer()}
              onSize={(n) => void invoices.changeSize(n)}
            />
          </>
        )}
      </Section>

      <BillingDetailsDialog
        open={details}
        onClose={() => setDetails(false)}
        workspaceId={workspaceId}
        billingEmail={account.billingEmail}
        billTo={account.billTo}
        onSaved={() => {
          setDetails(false);
          onChanged();
        }}
      />
    </>
  );
}

/** Who the invoice is addressed to. The terms themselves are set by the studio. */
function BillingDetailsDialog({
  open,
  onClose,
  workspaceId,
  billingEmail,
  billTo,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  billingEmail: string | null;
  billTo: BillTo | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState(billingEmail ?? '');
  const [company, setCompany] = useState(billTo?.company ?? '');
  const [address, setAddress] = useState(billTo?.address ?? '');
  const [taxId, setTaxId] = useState(billTo?.taxId ?? '');
  const [contact, setContact] = useState(billTo?.contact ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setEmail(billingEmail ?? '');
    setCompany(billTo?.company ?? '');
    setAddress(billTo?.address ?? '');
    setTaxId(billTo?.taxId ?? '');
    setContact(billTo?.contact ?? '');
  }, [open, billingEmail, billTo]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await api.billing.patchAccount(workspaceId, { billingEmail: email.trim() || null, billTo: { company, address, taxId, contact } });
      toast({ title: 'Billing details saved', body: 'The next invoice is addressed this way.', tone: 'ok' });
      onSaved();
    } catch (e) {
      toast({ title: 'Could not save', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }, [workspaceId, email, company, address, taxId, contact, toast, onSaved]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Billing details"
      description="Printed on every invoice. Your credit limit, rate and payment terms are agreed with the studio — get in touch to change them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Input label="Company name" value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} placeholder="Acme Commerce Ltd" />
        <Textarea label="Address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={400} rows={3} placeholder="12 Broad Street, Lagos" />
        <div className={styles.two}>
          <Input label="Tax ID" optional value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={60} placeholder="TIN / VAT" />
          <Input label="Attention of" optional value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} placeholder="Accounts payable" />
        </div>
        <Input
          label="Billing email"
          optional
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={254}
          hint="Invoices go here as well as to the owners."
          placeholder="ap@acme.example"
        />
      </div>
    </Dialog>
  );
}
