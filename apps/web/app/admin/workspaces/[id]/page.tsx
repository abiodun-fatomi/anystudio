'use client';
/** One workspace: members, plan, the ledger — and the credit adjustment, with a reason, on the record. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminWorkspace } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Skeleton, Table, Textarea, tableCell, useToast } from '@/components/ui';
import { useAdmin } from '../../AdminShell';
import styles from '../../admin.module.css';

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [d, setD] = useState<AdminWorkspace | null>(null);
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.admin.workspace(id).then(setD).catch(() => setD(null)); }, [id]);
  useEffect(() => { load(); }, [load]);
  const adjust = async () => {
    setBusy(true);
    try { const r = await api.admin.credits(id, Number(delta), reason.trim()); toast({ title: `Done — balance is now ${r.balance.toLocaleString()}`, tone: 'ok' }); setOpen(false); setDelta(''); setReason(''); load(); }
    catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  if (!d) return <div className="rise"><PageHeader title="Workspace" /><Skeleton height={300} /></div>;
  const w = d.workspace;
  return (
    <div className="rise">
      <PageHeader title={w.name} lede={`${w.type.toLowerCase()} · ${w.currency} · ${w.region} · created ${new Date(w.createdAt).toLocaleDateString()}${w.deletedAt ? ' · DELETED' : ''}`}
        actions={atLeast('OPERATOR') ? <Button onClick={() => setOpen(true)}>Adjust credits</Button> : undefined} />
      <div className={styles.heroes}>
        <div className={styles.card}><div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Balance</div><div style={{ fontSize: 'var(--t-6)', fontWeight: 800 }}>{d.balance.toLocaleString()}</div></div>
        <div className={styles.card}><div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Plan</div><div style={{ fontSize: 'var(--t-4)', fontWeight: 700 }}>{d.subscriptions[0] ? `${d.subscriptions[0].planCode} · ${d.subscriptions[0].status.toLowerCase()}` : 'none'}</div>{d.subscriptions[0]?.currentPeriodEnd && <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>until {new Date(d.subscriptions[0].currentPeriodEnd).toLocaleDateString()}{d.subscriptions[0].cancelAtPeriodEnd ? ', then stops' : ''}</div>}</div>
        <div className={styles.card}><div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Members</div><div style={{ fontSize: 'var(--t-2)' }}>{d.members.map((m) => <div key={m.id}><Link href={`/admin/customers/${m.id}`}>{m.name ?? m.email}</Link> <span style={{ color: 'var(--muted)' }}>{m.role.toLowerCase()}</span></div>)}</div></div>
        <div className={styles.card}><div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Profile</div><div className={styles.mono} style={{ fontSize: '11px', color: 'var(--muted)' }}>{w.profile ? JSON.stringify(w.profile).slice(0, 200) : '—'}</div></div>
      </div>
      <div className={styles.two}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Ledger (latest 50)</div>
          <Table><thead><tr><th>When</th><th>Kind</th><th>Reason</th><th className={tableCell.num}>Δ</th><th className={tableCell.num}>After</th></tr></thead>
            <tbody>{d.ledger.map((l) => <tr key={l.id}><td className={tableCell.shrink}>{new Date(l.createdAt).toLocaleString()}</td><td className={styles.mono}>{l.kind}</td><td style={{ fontSize: 'var(--t-1)' }}>{l.reason ?? '—'}</td><td className={tableCell.num} style={{ color: l.delta > 0 ? 'var(--ok)' : undefined }}>{l.delta > 0 ? `+${l.delta}` : l.delta}</td><td className={tableCell.num}>{l.balanceAfter}</td></tr>)}</tbody></Table>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Recent generations</div>
          <Table><thead><tr><th>When</th><th>What</th><th>Status</th><th>Via</th><th className={tableCell.num}>Cr</th></tr></thead>
            <tbody>{d.generations.map((g) => <tr key={g.id}><td className={tableCell.shrink}>{new Date(g.createdAt).toLocaleString()}</td><td><Link href={`/admin/generations?q=${g.id}`}>{g.title ?? g.capability}</Link></td><td><span className={styles.pill} data-tone={g.status === 'SUCCEEDED' ? 'ok' : g.status === 'FAILED' ? 'danger' : 'warn'}>{g.status}</span></td><td>{g.channel.toLowerCase()}</td><td className={tableCell.num}>{g.credits}</td></tr>)}</tbody></Table>
        </div>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Adjust credits" description="Positive adds, negative removes. The reason is written on the ledger row and the owner is told." locked={busy}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button onClick={adjust} loading={busy} disabled={!Number(delta) || reason.trim().length < 4}>Apply</Button></>}>
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Input label="Credits (signed)" type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="150 or -40" />
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} placeholder="Goodwill after the provider outage on 4 Sept" />
        </div>
      </Dialog>
    </div>
  );
}
