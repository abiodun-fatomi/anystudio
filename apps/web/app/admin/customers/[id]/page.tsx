'use client';
/** One person: who they are, their workspaces and balances, what they made, what they paid, what happened to their sign-in. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminCustomerDetail } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Skeleton, Table, Textarea, tableCell, useToast } from '@/components/ui';
import { useAdmin } from '../../AdminShell';
import styles from '../../admin.module.css';

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const { atLeast, me } = useAdmin();
  const { toast } = useToast();
  const [d, setD] = useState<AdminCustomerDetail | null>(null);
  const [reason, setReason] = useState('');
  const [ask, setAsk] = useState<'suspend' | 'unsuspend' | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.admin.customer(id).then(setD).catch(() => setD(null)); }, [id]);
  useEffect(() => { load(); }, [load]);
  const act = async () => {
    if (!ask) return; setBusy(true);
    try { await api.admin.suspend(id, reason.trim(), ask === 'suspend'); toast({ title: ask === 'suspend' ? 'Suspended — sessions ended' : 'Reinstated', tone: 'ok' }); setAsk(null); setReason(''); load(); }
    catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  if (!d) return <div className="rise"><PageHeader title="Customer" /><Skeleton height={300} /></div>;
  const u = d.user;
  return (
    <div className="rise">
      <PageHeader title={u.name ?? u.email ?? u.phone ?? 'Customer'} lede={`${u.email ?? ''}${u.email && u.phone ? ' · ' : ''}${u.phone ?? ''}${u.phoneIsWhatsApp ? ' (WhatsApp)' : ''}`}
        actions={atLeast('OPERATOR') && u.id !== me.user.id ? (u.status === 'SUSPENDED' ? <Button variant="ghost" onClick={() => setAsk('unsuspend')}>Reinstate</Button> : <Button variant="danger" onClick={() => setAsk('suspend')}>Suspend</Button>) : undefined} />
      <div className={styles.two}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Account</div>
          <dl className={styles.kv}>
            <dt>Status</dt><dd><span className={styles.pill} data-tone={u.status === 'ACTIVE' ? 'ok' : 'danger'}>{u.status}</span>{u.deleteRequestedAt ? <span className={styles.warn}> · deletion requested {new Date(u.deleteRequestedAt).toLocaleDateString()}</span> : null}</dd>
            <dt>Id</dt><dd className={styles.mono}>{u.id}</dd>
            <dt>Joined</dt><dd>{new Date(u.createdAt).toLocaleString()}</dd>
            <dt>Last sign-in</dt><dd>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</dd>
            <dt>Verified</dt><dd>{[u.emailVerifiedAt ? 'email' : null, u.phoneVerifiedAt ? 'phone' : null].filter(Boolean).join(', ') || 'nothing yet'}</dd>
            <dt>Sign-in methods</dt><dd>{u.identities.map((i) => i.provider.toLowerCase()).join(', ') || '—'}</dd>
            <dt>Two-step</dt><dd>{u.mfaFactors.filter((f) => f.confirmedAt).length ? `${u.mfaFactors.filter((f) => f.confirmedAt).length} factor(s)` : 'off'}</dd>
            {u.staffGrants.length > 0 && <><dt>Staff</dt><dd className={styles.warn}>{u.staffGrants.map((g) => g.role).join(', ')}</dd></>}
            <dt>Locale · timezone</dt><dd>{u.locale ?? '—'} · {u.timezone ?? '—'}</dd>
          </dl>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Workspaces</div>
          <Table>
            <thead><tr><th>Name</th><th>Type</th><th>Role</th><th className={tableCell.num}>Balance</th></tr></thead>
            <tbody>{d.workspaces.map((w) => (
              <tr key={w.id}><td><Link href={`/admin/workspaces/${w.id}`}>{w.name}</Link>{w.deletedAt && <span className={styles.danger}> (deleted)</span>}</td><td>{w.type.toLowerCase()}</td><td>{w.role.toLowerCase()}</td><td className={tableCell.num}>{w.balance.toLocaleString()} {w.currency}</td></tr>
            ))}</tbody>
          </Table>
        </div>
      </div>
      <div className={styles.two} style={{ marginTop: 'var(--s-4)' }}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Recent generations</div>
          {d.generations.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>None yet.</p> : (
            <Table><thead><tr><th>When</th><th>What</th><th>Status</th><th>Via</th><th className={tableCell.num}>Cr</th></tr></thead>
              <tbody>{d.generations.map((g) => <tr key={g.id}><td className={tableCell.shrink}>{new Date(g.createdAt).toLocaleString()}</td><td><Link href={`/admin/generations?q=${g.id}`}>{g.title ?? g.capability}</Link></td><td><span className={styles.pill} data-tone={g.status === 'SUCCEEDED' ? 'ok' : g.status === 'FAILED' ? 'danger' : 'warn'}>{g.status}</span></td><td>{g.channel.toLowerCase()}</td><td className={tableCell.num}>{g.credits}</td></tr>)}</tbody></Table>
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Payments</div>
          {d.payments.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>None yet.</p> : (
            <Table><thead><tr><th>When</th><th>Reference</th><th>Status</th><th className={tableCell.num}>Credits</th><th className={tableCell.num}>Amount</th></tr></thead>
              <tbody>{d.payments.map((p) => <tr key={p.id}><td className={tableCell.shrink}>{new Date(p.createdAt).toLocaleDateString()}</td><td className={styles.mono}>{p.reference}</td><td><span className={styles.pill} data-tone={p.status === 'SUCCEEDED' ? 'ok' : p.status === 'FAILED' ? 'danger' : 'warn'}>{p.status}</span></td><td className={tableCell.num}>{p.credits}</td><td className={tableCell.num}>{(p.amountMinor / 100).toLocaleString()} {p.currency}</td></tr>)}</tbody></Table>
          )}
        </div>
      </div>
      <div className={styles.card} style={{ marginTop: 'var(--s-4)' }}>
        <div className={styles.cardTitle}>Sign-in and account events</div>
        <Table><thead><tr><th>When</th><th>Event</th><th>Surface</th><th>IP</th><th>Detail</th></tr></thead>
          <tbody>{d.events.map((e) => <tr key={e.id}><td className={tableCell.shrink}>{new Date(e.createdAt).toLocaleString()}</td><td className={styles.mono}>{e.type}</td><td>{e.surface ?? '—'}</td><td className={styles.mono}>{e.ip ?? '—'}</td><td className={styles.mono} style={{ color: 'var(--muted)' }}>{e.detail ? JSON.stringify(e.detail).slice(0, 120) : ''}</td></tr>)}</tbody></Table>
      </div>
      <Dialog open={ask !== null} onClose={() => setAsk(null)} title={ask === 'suspend' ? 'Suspend this account?' : 'Reinstate this account?'} description={ask === 'suspend' ? 'They can still sign in and read, but cannot generate or buy. Every current session ends.' : 'They can generate and buy again.'} locked={busy}
        footer={<><Button variant="ghost" onClick={() => setAsk(null)} disabled={busy}>Cancel</Button><Button variant={ask === 'suspend' ? 'danger' : 'primary'} onClick={act} loading={busy} disabled={reason.trim().length < 4}>{ask === 'suspend' ? 'Suspend' : 'Reinstate'}</Button></>}>
        <Textarea label="Reason (on the record)" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} />
      </Dialog>
    </div>
  );
}
