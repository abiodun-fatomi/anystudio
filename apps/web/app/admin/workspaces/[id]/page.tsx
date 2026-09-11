'use client';
/** One workspace: members, plan, the ledger — and the credit adjustment, with a reason, on the record. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, type AdminWorkspace } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Skeleton, Table, Textarea, tableCell, useToast } from '@/components/ui';
import { useAdmin } from '../../AdminShell';
import styles from '../../admin.module.css';
import { CreditLineCard } from './CreditLineCard';

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [d, setD] = useState<AdminWorkspace | null>(null);
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.admin
      .workspace(id)
      .then(setD)
      .catch(() => setD(null));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  const adjust = async () => {
    setBusy(true);
    try {
      const r = await api.admin.credits(id, Number(delta), reason.trim());
      toast({ title: `Done — balance is now ${r.balance.toLocaleString()}`, tone: 'ok' });
      setOpen(false);
      setDelta('');
      setReason('');
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  if (!d)
    return (
      <div className="rise">
        <PageHeader title="Workspace" />
        <Skeleton height={300} />
      </div>
    );
  const w = d.workspace;
  return (
    <div className="rise">
      <PageHeader
        title={w.name}
        lede={`${w.type.toLowerCase()} · ${w.currency} · ${w.region} · created ${new Date(w.createdAt).toLocaleDateString()}${w.deletedAt ? ' · DELETED' : ''}`}
        actions={atLeast('OPERATOR') ? <Button onClick={() => setOpen(true)}>Adjust credits</Button> : undefined}
      />
      <div className={styles.heroes}>
        <div className={styles.card}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Balance</div>
          <div style={{ fontSize: 'var(--t-6)', fontWeight: 800 }}>{d.balance.toLocaleString()}</div>
        </div>
        <div className={styles.card}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Plan</div>
          <div style={{ fontSize: 'var(--t-4)', fontWeight: 700 }}>
            {d.subscriptions[0] ? `${d.subscriptions[0].planCode} · ${d.subscriptions[0].status.toLowerCase()}` : 'none'}
          </div>
          {d.subscriptions[0]?.currentPeriodEnd && (
            <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>
              until {new Date(d.subscriptions[0].currentPeriodEnd).toLocaleDateString()}
              {d.subscriptions[0].cancelAtPeriodEnd ? ', then stops' : ''}
            </div>
          )}
        </div>
        <div className={styles.card}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Members</div>
          <div style={{ fontSize: 'var(--t-2)' }}>
            {d.members.map((m) => (
              <div key={m.id}>
                <Link href={`/admin/customers/${m.id}`}>{m.name ?? m.email}</Link> <span style={{ color: 'var(--muted)' }}>{m.role.toLowerCase()}</span>
              </div>
            ))}
          </div>
        </div>
        <CreditLineCard workspaceId={w.id} type={w.type} currency={w.currency} account={d.billingAccount} onChanged={load} />
        <div className={styles.card}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Profile</div>
          <ProfileFacts profile={w.profile} />
        </div>
      </div>
      <div className={styles.two}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Ledger (latest 50)</div>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Reason</th>
                <th className={tableCell.num}>Δ</th>
                <th className={tableCell.num}>After</th>
              </tr>
            </thead>
            <tbody>
              {d.ledger.map((l) => (
                <tr key={l.id}>
                  <td className={tableCell.shrink}>{new Date(l.createdAt).toLocaleString()}</td>
                  <td className={styles.mono}>{l.kind}</td>
                  <td style={{ fontSize: 'var(--t-1)' }}>{l.reason ?? '—'}</td>
                  <td className={tableCell.num} style={{ color: l.delta > 0 ? 'var(--ok)' : undefined }}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </td>
                  <td className={tableCell.num}>{l.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Recent generations</div>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Status</th>
                <th>Via</th>
                <th className={tableCell.num}>Cr</th>
              </tr>
            </thead>
            <tbody>
              {d.generations.map((g) => (
                <tr key={g.id}>
                  <td className={tableCell.shrink}>{new Date(g.createdAt).toLocaleString()}</td>
                  <td>
                    <Link href={`/admin/generations?q=${g.id}`}>{g.title ?? g.capability}</Link>
                  </td>
                  <td>
                    <span className={styles.pill} data-tone={g.status === 'SUCCEEDED' ? 'ok' : g.status === 'FAILED' ? 'danger' : 'warn'}>
                      {g.status}
                    </span>
                  </td>
                  <td>{g.channel.toLowerCase()}</td>
                  <td className={tableCell.num}>{g.credits}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Adjust credits"
        description="Positive adds, negative removes. The reason is written on the ledger row and the owner is told."
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={adjust} loading={busy} disabled={!Number(delta) || reason.trim().length < 4}>
              Apply
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Input label="Credits (signed)" type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="150 or -40" />
          <Textarea
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={300}
            placeholder="Goodwill after the provider outage on 4 Sept"
          />
        </div>
      </Dialog>
    </div>
  );
}

/**
 * What the seller told us about their shop, as lines a person can read.
 *
 * This was `JSON.stringify(profile).slice(0, 200)`: raw JSON, cut mid-token,
 * and with no break opportunity anywhere in a run like
 * `["whatsapp","instagram","tiktok","shop","market"]` it walked straight out
 * of the card. The truncation was the giveaway — a field that has to be
 * chopped at 200 characters to fit was never meant to be read as one string.
 *
 * `.kv` already wraps and already has a min-width of zero, so laying it out as
 * key and value fixes the overflow as a side effect of making it legible.
 */
function ProfileFacts({ profile }: { profile: unknown }) {
  const source = profile !== null && typeof profile === 'object' && !Array.isArray(profile) ? (profile as Record<string, unknown>) : null;
  const rows = Object.entries(source ?? {})
    .map(([key, value]) => [key, profileValue(value)] as const)
    .filter(([, value]) => value !== null);

  if (rows.length === 0) return <div className={styles.prose}>—</div>;
  return (
    <dl className={styles.kv}>
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <dt>{profileLabel(key)}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** `billingCountry` reads as "billing country"; the console is not the database. */
function profileLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toLowerCase() + spaced.slice(1);
}

/** Null for anything with nothing to say, so empty answers do not take a line. */
function profileValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
