'use client';
/** Is the platform healthy right now, and what broke in the last day. */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type AdminOverview } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Skeleton, Table, tableCell } from '@/components/ui';
import { Hero } from '@/components/charts/Charts';
import styles from './admin.module.css';

export default function AdminOverviewPage() {
  const [o, setO] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.admin.overview().then(setO).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load')); }, []);
  if (err) return <div className="rise"><PageHeader title="Overview" /><p className={styles.danger}>{err}</p></div>;
  if (!o) return <div className="rise"><PageHeader title="Overview" /><div className={styles.heroes}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={96} />)}</div></div>;
  const failRate = o.generations.today ? o.generations.failedToday / o.generations.today : 0;
  return (
    <div className="rise">
      <PageHeader title="Overview" lede="The last 24 hours, and anything that needs a hand." />
      <div className={styles.heroes}>
        <Hero label="Generations today" value={o.generations.today.toLocaleString()} sub={`${o.generations.whatsappToday} WhatsApp · ${o.generations.apiToday} API`} />
        <Hero label="Failed today" value={o.generations.failedToday.toLocaleString()} sub={`${Math.round(failRate * 100)}% of today`} tone={failRate > 0.1 ? 'danger' : failRate > 0.03 ? 'warn' : undefined} />
        <Hero label="Running now" value={o.generations.runningNow.toLocaleString()} sub={o.generations.queuedStale ? `${o.generations.queuedStale} queued for 10+ min` : 'queue is moving'} tone={o.generations.queuedStale ? 'warn' : undefined} />
        <Hero label="Credits sold, 30 days" value={o.credits.soldLast30d.toLocaleString()} sub={`${o.credits.paymentsLast30d} payments`} />
      </div>
      <div className={styles.heroes}>
        <Hero label="Customers" value={o.users.total.toLocaleString()} sub={`${o.users.newThisWeek} new this week`} />
        <Hero label="Workspaces" value={Object.values(o.workspaces).reduce((a, b) => a + b, 0).toLocaleString()} sub={Object.entries(o.workspaces).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(' · ')} />
        <Hero label="Provider rows on" value={String(o.providers.enabled)} sub={o.providers.noAdapter.length ? `${o.providers.noAdapter.length} with no key in this process` : 'every enabled row has an adapter'} tone={o.providers.noAdapter.length ? 'warn' : undefined} />
        <Hero label="Breakers open" value={String(o.providers.breakersOpen.length)} sub={o.providers.breakersOpen.join(', ') || 'none'} tone={o.providers.breakersOpen.length ? 'danger' : 'ok'} />
      </div>
      {o.providers.noAdapter.length > 0 && <div className={styles.card} style={{ marginBottom: 'var(--s-4)' }}><div className={styles.cardTitle}>Enabled rows with no adapter here</div><div className={styles.mono}>{o.providers.noAdapter.join(' · ')}</div><div style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>The row is on but the API key is not set in this environment, so the router skips it. Set the key or turn the row off in Providers.</div></div>}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Recent failures</div>
        {o.recentFailures.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Nothing failed in the last day.</p> : (
          <Table>
            <thead><tr><th>When</th><th>Capability</th><th>Kind</th><th>Provider</th><th>Reason</th></tr></thead>
            <tbody>{o.recentFailures.map((f) => (
              <tr key={f.id}><td className={tableCell.shrink}>{new Date(f.createdAt).toLocaleTimeString()}</td><td><Link href={`/admin/generations?q=${f.id}`}>{f.capability}</Link></td><td><span className={styles.pill} data-tone={f.failureKind === 'CONTENT_REJECTED' || f.failureKind === 'INVALID_INPUT' ? 'warn' : 'danger'}>{f.failureKind ?? '—'}</span></td><td className={styles.mono}>{f.providerKey ?? '—'}</td><td style={{ fontSize: 'var(--t-1)', color: 'var(--muted)' }}>{f.failureReason?.slice(0, 160) ?? '—'}</td></tr>
            ))}</tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
