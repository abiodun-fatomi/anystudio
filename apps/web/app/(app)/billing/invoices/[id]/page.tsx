'use client';
/**
 * One invoice, laid out to be printed: who it is from, who it is to, the
 * period, the lines, the total, and how to pay. The same page serves as
 * the receipt once paid. `Print` uses the browser; a PDF is one step away.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useApp } from '@/lib/app-context';
import { api, type InvoiceView } from '@/lib/api';
import { INVOICE_STATUS, moneyMinor } from '@/lib/billing/money';
import { Badge, Button, EmptyState, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './invoice.module.css';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const VIA: Record<string, string> = {
  FLUTTERWAVE: 'card or bank transfer (Flutterwave)',
  PADDLE: 'card (Paddle)',
  STUB: 'test gateway',
  MANUAL: 'bank transfer',
  ZERO: 'nothing was due',
};

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { workspace } = useApp();
  const { toast } = useToast();
  const [inv, setInv] = useState<InvoiceView | null | undefined>(undefined);
  const [paying, setPaying] = useState(false);
  const canBuy = ['OWNER', 'ADMIN', 'BILLING'].includes(workspace.role);

  const load = useCallback(async () => {
    try {
      setInv(await api.billing.invoice(workspace.id, id));
    } catch {
      setInv(null);
    }
  }, [workspace.id, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const pay = async () => {
    if (!inv) return;
    setPaying(true);
    try {
      const out = await api.billing.payInvoice(workspace.id, inv.id);
      window.location.assign(out.url);
    } catch (e) {
      toast({ title: 'Could not open the payment page', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
      setPaying(false);
    }
  };

  if (inv === undefined) return <Skeleton height={400} />;
  if (inv === null)
    return (
      <EmptyState
        title="That invoice is not here"
        body="It may belong to another workspace, or the link is old."
        actions={
          <Button href="/billing" variant="ghost">
            Back to billing
          </Button>
        }
      />
    );

  const status = INVOICE_STATUS[inv.status] ?? { label: inv.status };
  return (
    <div className={`rise ${styles.page}`}>
      <div className={styles.toolbar}>
        <Link href="/billing" className={styles.back}>
          ← Billing
        </Link>
        <div className={styles.tools}>
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            Print
          </Button>
          {inv.payable && canBuy && (
            <Button size="sm" loading={paying} onClick={() => void pay()}>
              Pay {moneyMinor(inv.totalMinor, inv.currency)}
            </Button>
          )}
        </div>
      </div>

      <article className={styles.sheet} aria-label={`Invoice ${inv.number}`}>
        <header className={styles.head}>
          <div className={styles.from}>
            <div className={styles.brand}>
              <span className={styles.mark} aria-hidden="true">
                <Icon.studio width={18} height={18} />
              </span>
              AnyStudio
            </div>
            <div className={styles.fromLines}>
              Usage invoice
              <br />
              billing@anystudio.ai
            </div>
          </div>
          <div className={styles.meta}>
            <div className={styles.number}>{inv.number}</div>
            <Badge tone={status.tone}>{status.label}</Badge>
            <dl>
              <dt>Issued</dt>
              <dd>{day(inv.issuedAt)}</dd>
              <dt>Period</dt>
              <dd>{inv.period}</dd>
              {inv.status === 'PAID' ? (
                <>
                  <dt>Paid</dt>
                  <dd>{inv.paidAt ? day(inv.paidAt) : '—'}</dd>
                </>
              ) : inv.status !== 'VOID' ? (
                <>
                  <dt>Due</dt>
                  <dd>{day(inv.dueAt)}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </header>

        <section className={styles.to}>
          <div className={styles.label}>Billed to</div>
          <div className={styles.toName}>{inv.billTo?.company || workspace.name}</div>
          {inv.billTo?.contact && <div>{inv.billTo.contact}</div>}
          {inv.billTo?.address && <div className={styles.address}>{inv.billTo.address}</div>}
          {inv.billTo?.taxId && <div className={styles.quiet}>Tax ID {inv.billTo.taxId}</div>}
        </section>

        <table className={styles.lines}>
          <thead>
            <tr>
              <th>Description</th>
              <th className={styles.num}>Made</th>
              <th className={styles.num}>Credits</th>
              <th className={styles.num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.costCode}>
                <td>
                  {l.label}
                  <span className={styles.code}>{l.costCode}</span>
                </td>
                <td className={styles.num}>{l.requests.toLocaleString()}</td>
                <td className={styles.num}>{l.credits.toLocaleString()}</td>
                <td className={styles.num}>{moneyMinor(l.amountMinor, inv.currency)}</td>
              </tr>
            ))}
            {inv.lines.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.quiet}>
                  Nothing was used in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                Usage · {inv.credits.toLocaleString()} credits at {moneyMinor(inv.per100Minor, inv.currency)} per 100
              </td>
              <td className={styles.num}>{moneyMinor(inv.usageMinor, inv.currency)}</td>
            </tr>
            {inv.minimumMinor > 0 && (
              <tr>
                <td colSpan={3}>Monthly minimum</td>
                <td className={styles.num}>{moneyMinor(inv.minimumMinor, inv.currency)}</td>
              </tr>
            )}
            <tr className={styles.total}>
              <td colSpan={3}>Total due</td>
              <td className={styles.num}>{moneyMinor(inv.totalMinor, inv.currency)}</td>
            </tr>
          </tfoot>
        </table>

        <footer className={styles.foot}>
          {inv.status === 'PAID' ? (
            <p>
              Paid by {VIA[inv.paidVia ?? ''] ?? inv.paidVia ?? '—'}
              {inv.paidReference ? ` · reference ${inv.paidReference}` : ''}. Thank you.
            </p>
          ) : inv.status === 'VOID' ? (
            <p>Voided{inv.voidReason ? ` — ${inv.voidReason}` : ''}. Nothing is owed on this invoice.</p>
          ) : (
            <>
              <p>
                {inv.payable && canBuy ? 'Pay online with the button above, or by bank transfer' : 'Pay by bank transfer'} quoting <strong>{inv.number}</strong>
                {inv.bankDetails ? ':' : '.'}
                {!canBuy && ' An owner, admin or the billing contact can pay it online from the Billing page.'}
              </p>
              {inv.bankDetails && <pre className={styles.bank}>{inv.bankDetails}</pre>}
              <p className={styles.quiet}>
                Credits used in the period are itemised above; a failed generation is refunded on the same line. Questions: reply to the invoice email.
              </p>
            </>
          )}
        </footer>
      </article>
    </div>
  );
}
