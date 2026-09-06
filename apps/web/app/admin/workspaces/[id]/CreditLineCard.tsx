'use client';
/**
 * The staff side of a credit line: open one for an organization, change its
 * terms, close it, lift a pause, or invoice the period early. Every write
 * asks for a reason and needs a recent second factor — it is a credit
 * decision, and the audit log should read like one.
 */
import { useEffect, useState } from 'react';
import { api, type AdminWorkspace } from '@/lib/api';
import { moneyMinor } from '@/lib/billing/money';
import { Badge, Button, Dialog, Input, Textarea, useToast } from '@/components/ui';
import { useAdmin } from '../../AdminShell';
import styles from '../../admin.module.css';

type Account = NonNullable<AdminWorkspace['billingAccount']>;
const TONE: Record<string, 'ok' | 'warn' | 'danger' | undefined> = { ACTIVE: 'ok', SUSPENDED: 'danger', CLOSED: undefined };

export function CreditLineCard({
  workspaceId,
  type,
  currency,
  account,
  onChanged,
}: {
  workspaceId: string;
  type: string;
  currency: string;
  account: Account | null;
  onChanged: () => void;
}) {
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [terms, setTerms] = useState(false);
  const [ask, setAsk] = useState<null | 'close' | 'reactivate' | 'period'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const live = account && account.status !== 'CLOSED';

  if (type !== 'ORGANIZATION') return null;

  const act = async () => {
    if (!ask) return;
    setBusy(true);
    try {
      if (ask === 'close') {
        const r = await api.admin.closeBillingAccount(workspaceId, reason.trim());
        toast({
          title: 'Credit line closed',
          body: r.finalInvoice ? `Final invoice ${r.finalInvoice.number} issued.` : 'Nothing left to invoice.',
          tone: 'ok',
        });
      } else if (ask === 'reactivate') {
        await api.admin.reactivateBillingAccount(workspaceId, reason.trim());
        toast({ title: 'Line reopened', tone: 'ok' });
      } else {
        const inv = await api.admin.closeBillingPeriod(workspaceId, reason.trim());
        toast({ title: `${inv.number} issued`, body: `${moneyMinor(inv.totalMinor, inv.currency)} for ${inv.credits.toLocaleString()} credits.`, tone: 'ok' });
      }
      setAsk(null);
      setReason('');
      onChanged();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Credit line</div>
        {account && <Badge tone={TONE[account.status]}>{account.status.toLowerCase()}</Badge>}
      </div>
      {live ? (
        <div style={{ fontSize: 'var(--t-2)', display: 'grid', gap: 2, marginTop: 4 }}>
          <div>
            <strong>{account.creditLimit.toLocaleString()}</strong> credits ·{' '}
            {account.per100Minor ? `${moneyMinor(account.per100Minor, currency)} / 100 (negotiated)` : 'list rate'}
          </div>
          <div style={{ color: 'var(--muted)' }}>
            net {account.netDays} · grace {account.graceDays}
            {account.minimumMinor > 0 ? ` · min ${moneyMinor(account.minimumMinor, currency)}` : ''}
            {account.billingEmail ? ` · ${account.billingEmail}` : ''}
          </div>
          {account.status === 'SUSPENDED' && <div style={{ color: 'var(--danger)' }}>{account.suspendedReason}</div>}
          {account.notes && (
            <div className={styles.mono} style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'pre-line' }}>
              {account.notes}
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--t-2)', color: 'var(--muted)', marginTop: 4 }}>
          Prepaid. Open a line to invoice this organization monthly for what it uses.
        </div>
      )}
      {atLeast('OPERATOR') && (
        <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', marginTop: 'var(--s-3)' }}>
          {atLeast('ADMIN') && (
            <Button size="sm" variant={live ? 'ghost' : 'primary'} onClick={() => setTerms(true)}>
              {live ? 'Change terms' : 'Open a credit line'}
            </Button>
          )}
          {live && (
            <Button size="sm" variant="ghost" onClick={() => setAsk('period')}>
              Invoice now
            </Button>
          )}
          {live && account.status === 'SUSPENDED' && atLeast('ADMIN') && (
            <Button size="sm" variant="ghost" onClick={() => setAsk('reactivate')}>
              Lift pause
            </Button>
          )}
          {live && atLeast('ADMIN') && (
            <Button size="sm" variant="ghost" onClick={() => setAsk('close')}>
              Close line
            </Button>
          )}
        </div>
      )}

      <TermsDialog
        open={terms}
        onClose={() => setTerms(false)}
        workspaceId={workspaceId}
        currency={currency}
        account={live ? account : null}
        onSaved={() => {
          setTerms(false);
          onChanged();
        }}
      />

      <Dialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={ask === 'close' ? 'Close the credit line?' : ask === 'reactivate' ? 'Lift the pause?' : 'Invoice the period now?'}
        description={
          ask === 'close'
            ? 'The organization goes back to prepaid. Everything used so far this period is invoiced now, and the wallet may no longer go below zero.'
            : ask === 'reactivate'
              ? 'The line reopens at its limit even though invoices are still overdue. Use it when a payment is confirmed on its way.'
              : 'Issues an invoice for everything used since the last one, and starts a new period from now.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void act()} loading={busy} disabled={reason.trim().length < 4}>
              Confirm
            </Button>
          </>
        }
      >
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} hint="Goes in the audit log." />
      </Dialog>
    </div>
  );
}

function TermsDialog({
  open,
  onClose,
  workspaceId,
  currency,
  account,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  currency: string;
  account: Account | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [limit, setLimit] = useState('');
  const [rate, setRate] = useState('');
  const [minimum, setMinimum] = useState('');
  const [net, setNet] = useState('14');
  const [grace, setGrace] = useState('7');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [listRate, setListRate] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setLimit(account ? String(account.creditLimit) : '');
    setRate(account?.per100Minor ? String(account.per100Minor / 100) : '');
    setMinimum(account ? String(account.minimumMinor / 100) : '');
    setNet(String(account?.netDays ?? 14));
    setGrace(String(account?.graceDays ?? 7));
    setEmail(account?.billingEmail ?? '');
    setNotes(account?.notes ?? '');
    setReason('');
    api.admin
      .billingRates()
      .then((rs) => setListRate(rs.find((r) => r.currency === currency.toUpperCase())?.per100Minor ?? null))
      .catch(() => setListRate(null));
  }, [open, account, currency]);

  const save = async () => {
    setBusy(true);
    try {
      await api.admin.setBillingTerms(workspaceId, {
        reason: reason.trim(),
        creditLimit: limit.trim() ? Number(limit) : undefined,
        per100Minor: rate.trim() ? Math.round(Number(rate) * 100) : null,
        minimumMinor: minimum.trim() ? Math.round(Number(minimum) * 100) : 0,
        netDays: Number(net),
        graceDays: Number(grace),
        billingEmail: email.trim() || null,
        notes: notes.trim() || null,
      });
      toast({ title: account ? 'Terms changed' : 'Credit line opened', tone: 'ok' });
      onSaved();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={account ? 'Credit line terms' : 'Open a credit line'}
      description={`Amounts in ${currency.toUpperCase()}. The wallet may go below zero as far as the limit; each calendar month is invoiced on the 1st.${
        listRate !== null ? ` List rate: ${moneyMinor(listRate, currency)} per 100 credits.` : ' No list rate in this currency — set a negotiated one.'
      }`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={reason.trim().length < 4 || (!account && !limit.trim())}>
            {account ? 'Save terms' : 'Open line'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
          <Input label="Credit limit (credits)" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} required />
          <Input
            label={`Rate / 100 credits (${currency})`}
            optional
            type="number"
            min={0}
            step="0.01"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            hint="Blank = list rate"
          />
        </div>
        <Input
          label={`Monthly minimum (${currency})`}
          optional
          type="number"
          min={0}
          step="0.01"
          value={minimum}
          onChange={(e) => setMinimum(e.target.value)}
          hint="Invoices below it are topped up to it"
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
          <Input label="Net days" type="number" min={0} max={90} value={net} onChange={(e) => setNet(e.target.value)} hint="Issue to due" />
          <Input label="Grace days" type="number" min={0} max={60} value={grace} onChange={(e) => setGrace(e.target.value)} hint="Past due, then paused" />
        </div>
        <Input label="Billing email" optional type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Textarea label="Notes (staff only)" optional value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} hint="Goes in the audit log." />
      </div>
    </Dialog>
  );
}
