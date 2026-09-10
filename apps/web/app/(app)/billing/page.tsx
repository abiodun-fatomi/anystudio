'use client';
/**
 * Credits: the balance, and the ledger as a readable statement — every row
 * says what it was, when, how much, and the balance after. Plans and
 * top-ups arrive with payments; this screen is what makes them trustworthy.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/app-context';
import { api, type AccountOverview, type LedgerRow, type PaymentView, type SubscriptionView } from '@/lib/api';
import { CreditLine } from './CreditLine';
import { moneyMinor, PLAN_WORDS } from '@/lib/billing/money';
import { PageHeader, Section } from '@/components/shell/Page';
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, Pagination, Skeleton, Stat, Table, tableCell, Textarea, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

const KIND: Record<string, { label: string; tone?: 'ok' | 'warn' | 'danger' | 'accent' }> = {
  PURCHASE: { label: 'Top-up', tone: 'ok' },
  DEBIT: { label: 'Generation' },
  REFUND: { label: 'Refund', tone: 'ok' },
  PROMO: { label: 'Welcome credits', tone: 'accent' },
  EXPIRY: { label: 'Expired', tone: 'warn' },
  ADJUSTMENT: { label: 'Adjustment', tone: 'warn' },
};
const PAY_STATUS: Record<string, { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  SUCCEEDED: { label: 'Paid', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'danger' },
  NEEDS_REVIEW: { label: 'Needs review', tone: 'warn' },
  REFUNDED: { label: 'Refunded', tone: 'warn' },
  PENDING: { label: 'Pending' },
};
const PROVIDER: Record<string, string> = { FLUTTERWAVE: 'Flutterwave', PADDLE: 'Paddle', STUB: 'Test' };
const fmt = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function BillingPage() {
  const { workspace, balance, setBalance } = useApp();
  const { toast } = useToast();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [sub, setSub] = useState<SubscriptionView | null | undefined>(undefined);
  const [payments, setPayments] = useState<PaymentView[] | null>(null);
  const [payCursor, setPayCursor] = useState<string | null>(null);
  const [payMore, setPayMore] = useState(false);
  const olderPayments = async () => {
    if (!payCursor) return;
    setPayMore(true);
    try {
      const p = await api.billing.payments(workspace.id, payCursor);
      setPayments((cur) => [...(cur ?? []), ...p.rows]);
      setPayCursor(p.nextCursor);
    } catch {
      /* the button stays; try again */
    } finally {
      setPayMore(false);
    }
  };
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Refunds: a purchase can be asked back within the window if the credits are untouched.
  const [refundWindow, setRefundWindow] = useState(14);
  const [refunding, setRefunding] = useState<PaymentView | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const reloadPayments = useCallback(async () => {
    try {
      const p = await api.billing.payments(workspace.id);
      setPayments(p.rows);
      setPayCursor(p.nextCursor);
      if (p.refundWindowDays) setRefundWindow(p.refundWindowDays);
    } catch {
      setPayments((cur) => cur ?? []);
    }
  }, [workspace.id]);
  const requestRefund = async () => {
    if (!refunding) return;
    setRefundBusy(true);
    try {
      await api.billing.requestRefund(workspace.id, refunding.id, refundReason.trim());
      toast({ title: 'Refund requested', body: 'A person looks at it within two working days. The credits stay on hold until then.', tone: 'ok' });
      setRefunding(null);
      setRefundReason('');
      await reloadPayments();
    } catch (e) {
      toast({ title: 'Could not request that', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setRefundBusy(false);
    }
  };
  const withdrawRefund = async (p: PaymentView) => {
    try {
      await api.billing.cancelRefund(workspace.id, p.id);
      toast({ title: 'Request withdrawn', tone: 'ok' });
      await reloadPayments();
    } catch (e) {
      toast({ title: 'Could not withdraw it', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const canBuy = ['OWNER', 'ADMIN', 'BILLING'].includes(workspace.role);
  // Organizations may be invoiced monthly instead of buying credits. The
  // account read says which; a prepaid workspace gets `account: null`.
  const { postpaid: linePostpaid } = useApp();
  const [overview, setOverview] = useState<AccountOverview | null | undefined>(undefined);
  const [overviewError, setOverviewError] = useState(false);
  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api.billing.account(workspace.id));
      setOverviewError(false);
    } catch {
      setOverview(null);
      setOverviewError(true);
    }
  }, [workspace.id]);
  useEffect(() => {
    setOverview(undefined);
    void loadOverview();
  }, [loadOverview]);
  // The account read says which screen this is; if it failed, the top bar's
  // answer (from the wallet summary) keeps a postpaid organization from
  // being shown a pack shop it cannot use.
  const postpaid = overview ? Boolean(overview.account && overview.account.status !== 'CLOSED') : linePostpaid;
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      try {
        const [w, h] = await Promise.all([api.wallet.summary(workspace.id), api.wallet.history(workspace.id, after)]);
        setBalance(w.postpaid ? w.available : w.balance);
        setRows((r) => (after && r ? [...r, ...h.rows] : h.rows));
        setCursor(h.nextCursor);
        setError(null);
      } catch {
        setError('Could not load your statement just now.');
      } finally {
        setMore(false);
      }
    },
    [workspace.id, setBalance],
  );

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);
  useEffect(() => {
    let live = true;
    api.billing
      .subscription(workspace.id)
      .then((s) => {
        if (live) setSub(s);
      })
      .catch(() => {
        if (live) setSub(null);
      });
    void reloadPayments();
    return () => {
      live = false;
    };
  }, [workspace.id, reloadPayments]);

  const cancel = async () => {
    setCancelling(true);
    try {
      setSub(await api.billing.cancel(workspace.id));
      toast({ title: 'Plan will stop at the end of the period', body: 'Everything you paid for stays until then.', tone: 'ok' });
    } catch (e) {
      toast({ title: 'Could not cancel', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setCancelling(false);
      setCancelOpen(false);
    }
  };

  return (
    <div className="rise">
      <PageHeader
        title={postpaid ? 'Billing' : 'Credits'}
        lede={
          postpaid
            ? 'Invoiced monthly for what you use. The line below is how much can be drawn before the next invoice; the statement is every credit in and out.'
            : 'Every credit in and out, newest first. A failed generation always comes back as a refund row.'
        }
        actions={
          postpaid ? undefined : (
            <Button href="/billing/plans" leading={<Icon.plus />}>
              Add credits
            </Button>
          )
        }
      />
      {overview === undefined && <Skeleton height={96} />}
      {overviewError && (
        <EmptyState
          title="Could not load your billing details just now."
          actions={
            <Button variant="ghost" onClick={() => void loadOverview()}>
              Try again
            </Button>
          }
        />
      )}
      {overview?.account && postpaid && <CreditLine workspaceId={workspace.id} canBuy={canBuy} overview={overview} onChanged={() => void loadOverview()} />}
      {overview !== undefined && !overviewError && !postpaid && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 'var(--s-4)' }}>
          <Card>
            <Stat label="Balance" value={balance === null ? <Skeleton width={90} height={36} /> : balance.toLocaleString()} sub="credits available now" />
          </Card>
          <Card>
            <Stat label="Currency" value={workspace.currency} sub="fixed for this workspace" />
          </Card>
          <Card>
            {sub === undefined ? (
              <Skeleton height={56} />
            ) : sub ? (
              <Stat
                label="Plan"
                value={PLAN_WORDS[sub.planCode]?.name ?? sub.planCode}
                sub={
                  sub.cancelAtPeriodEnd
                    ? `${sub.cancellationPending ? 'cancellation saved · ' : ''}ends ${sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : 'at period end'}`
                    : sub.status === 'PAST_DUE'
                      ? 'payment overdue — update your card'
                      : `renews ${sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : 'monthly'} · ${sub.interval === 'year' ? 'yearly' : 'monthly'}`
                }
              />
            ) : (
              <Stat label="Plan" value="Free" sub="pay as you go with packs" />
            )}
            {sub && !sub.cancelAtPeriodEnd && canBuy && (
              <div style={{ marginTop: 'var(--s-2)' }}>
                <Button variant="link" size="sm" onClick={() => setCancelOpen(true)}>
                  Cancel plan
                </Button>
              </div>
            )}
            {!sub && canBuy && (
              <div style={{ marginTop: 'var(--s-2)' }}>
                <Button variant="link" size="sm" href="/billing/plans">
                  See plans
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      {overview?.canRequest && !postpaid && (
        <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)', maxWidth: '64ch' }}>
          Organizations that use the studio every day can be invoiced monthly on a credit line instead of buying credits up front. Write to{' '}
          <a href="mailto:hello@anystudio.ai?subject=Credit%20line">hello@anystudio.ai</a> and say roughly how many credits a month you expect.
        </p>
      )}

      <Section title="Payments">
        {payments === null ? (
          <Skeleton height={44} />
        ) : payments.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>
            No payments yet. Every purchase shows here with its reference and the amount actually charged.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Status</th>
                <th>Reference</th>
                <th className={tableCell.num}>Credits</th>
                <th className={tableCell.num}>Charged</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className={tableCell.shrink}>{when(p.createdAt)}</td>
                  <td>
                    {p.kind === 'PACK'
                      ? 'Credit pack'
                      : p.kind === 'INVOICE'
                        ? `Invoice ${p.itemCode}`
                        : p.kind === 'RENEWAL'
                          ? `${PLAN_WORDS[p.itemCode]?.name ?? p.itemCode} renewal`
                          : `${PLAN_WORDS[p.itemCode]?.name ?? p.itemCode} plan${p.interval === 'year' ? ', yearly' : ''}`}
                    <span style={{ color: 'var(--muted)' }}> · {PROVIDER[p.provider] ?? p.provider}</span>
                  </td>
                  <td className={tableCell.shrink}>
                    <Badge tone={PAY_STATUS[p.status]?.tone}>{PAY_STATUS[p.status]?.label ?? p.status}</Badge>
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', fontFamily: 'var(--f-mono)' }}>{p.reference}</td>
                  <td className={tableCell.num}>
                    {p.status === 'SUCCEEDED' ? `+${p.credits.toLocaleString()}` : p.status === 'REFUNDED' ? `−${p.credits.toLocaleString()}` : '—'}
                  </td>
                  <td className={tableCell.num}>{moneyMinor(p.amountMinor, p.currency)}</td>
                  <td className={tableCell.shrink}>
                    {p.refund?.status === 'REQUESTED' ? (
                      <span style={{ display: 'inline-flex', gap: 'var(--s-2)', alignItems: 'center' }}>
                        <Badge tone="accent">Refund requested</Badge>
                        {canBuy && (
                          <Button size="sm" variant="link" onClick={() => void withdrawRefund(p)}>
                            Withdraw
                          </Button>
                        )}
                      </span>
                    ) : p.refund?.status === 'REFUSED' ? (
                      <span title={p.refund.decisionNote ?? undefined} style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>
                        Refund refused{p.refund.decisionNote ? ` — ${p.refund.decisionNote}` : ''}
                      </span>
                    ) : p.canRequestRefund && canBuy ? (
                      <Button size="sm" variant="ghost" onClick={() => setRefunding(p)}>
                        Request refund
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {!postpaid && (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', marginTop: 'var(--s-2)' }}>
            Changed your mind? A purchase can be refunded within {refundWindow} days, as long as none of its credits have been used. The money goes back the way
            it came — the{' '}
            <a href="/refunds" target="_blank" rel="noopener">
              refund policy
            </a>{' '}
            has the details.
          </p>
        )}
        {payments && payments.length > 0 && (
          <Pagination>
            <span>
              {payments.length} payment{payments.length === 1 ? '' : 's'} shown{payCursor ? '' : ' · that is all of them'}
            </span>
            {payCursor && (
              <Button variant="ghost" size="sm" loading={payMore} onClick={() => void olderPayments()}>
                Show older
              </Button>
            )}
          </Pagination>
        )}
      </Section>

      <Dialog
        open={refunding !== null}
        onClose={() => setRefunding(null)}
        title="Request a refund"
        description={
          refunding
            ? `${moneyMinor(refunding.amountMinor, refunding.currency)} for ${refunding.credits.toLocaleString()} credits. The credits stay on hold while a person looks, and the money goes back the way it came.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRefunding(null)} disabled={refundBusy}>
              Keep it
            </Button>
            <Button onClick={() => void requestRefund()} loading={refundBusy} disabled={refundReason.trim().length < 4}>
              Request refund
            </Button>
          </>
        }
      >
        <Textarea
          label="Why?"
          value={refundReason}
          onChange={(e) => setRefundReason(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="Bought the wrong pack, changed my mind, …"
        />
      </Dialog>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => void cancel()}
        busy={cancelling}
        title="Cancel your plan?"
        description={`It runs until ${sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : 'the end of the paid period'} and then stops. Credits you already have stay. You can start a plan again any time.`}
        confirmLabel="Cancel plan"
        danger
      />

      <Section title="Statement">
        {error && (
          <EmptyState
            title={error}
            actions={
              <Button variant="ghost" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        )}
        {!error && rows === null && (
          <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={44} />
            ))}
          </div>
        )}
        {!error && rows && rows.length === 0 && (
          <EmptyState icon={<Icon.credits />} title="No movements yet" body="Your first generation will show here as a debit — and as a refund if it fails." />
        )}
        {!error && rows && rows.length > 0 && (
          <>
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Note</th>
                  <th className={tableCell.num}>Credits</th>
                  <th className={tableCell.num}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={tableCell.shrink}>{when(r.createdAt)}</td>
                    <td className={tableCell.shrink}>
                      <Badge tone={KIND[r.kind]?.tone}>{KIND[r.kind]?.label ?? r.kind}</Badge>
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{r.reason ?? '—'}</td>
                    <td className={tableCell.num} style={{ color: r.delta > 0 ? 'var(--ok)' : undefined, fontWeight: 600 }}>
                      {fmt(r.delta)}
                    </td>
                    <td className={tableCell.num}>{r.balanceAfter.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination>
              <span>
                {rows.length} row{rows.length === 1 ? '' : 's'} shown, newest first{cursor ? '' : ' · that is the whole statement'}
              </span>
              {cursor && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={more}
                  onClick={() => {
                    setMore(true);
                    void load(cursor);
                  }}
                >
                  Show older
                </Button>
              )}
            </Pagination>
          </>
        )}
      </Section>
    </div>
  );
}
