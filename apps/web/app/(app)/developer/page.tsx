'use client';
/**
 * Overview — is the API being used, by whom, and what did it cost. The
 * first screen an integrator sees, so an empty workspace gets the three
 * steps to a first call instead of empty charts.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type DevProject, type DevUsage } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Button, EmptyState, SegmentedControl, Skeleton } from '@/components/ui';
import { Breakdown, DailyBars, Hero } from '@/components/charts/Charts';
import { Icon } from '@/components/shell/icons';
import styles from './developer.module.css';

const CAP_WORDS: Record<string, string> = { IMAGE_EDIT: 'Product photos', IMAGE_GENERATE: 'Scenes', BACKGROUND_REMOVE: 'Cut-outs', BACKGROUND_REPLACE: 'Backgrounds', UPSCALE: 'Enhancements', RELIGHT: 'Relights', IMAGE_TO_VIDEO: 'Videos', TEXT_GENERATE: 'Copy', VOICEOVER: 'Voiceovers', MUSIC: 'Songs', DUB: 'Dubs', LIPSYNC: 'Lip-syncs' };

export default function DeveloperOverview() {
  const { workspace } = useApp();
  const [days, setDays] = useState('30');
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<DevProject[] | null>(null);
  const [usage, setUsage] = useState<DevUsage | null>(null);

  useEffect(() => { api.developer.projects(workspace.id).then(setProjects).catch(() => setProjects([])); }, [workspace.id]);
  useEffect(() => {
    let live = true;
    setUsage(null);
    api.developer.usage(workspace.id, Number(days), projectId).then((u) => { if (live) setUsage(u); }).catch(() => { if (live) setUsage(null); });
    return () => { live = false; };
  }, [workspace.id, days, projectId]);

  const series = useMemo(() => {
    if (!usage) return [];
    const byDate = new Map<string, { requests: number; failed: number; credits: number }>();
    const start = new Date(usage.since); start.setUTCHours(0, 0, 0, 0);
    for (let i = 0; i < usage.days; i++) byDate.set(new Date(start.getTime() + i * 86400_000).toISOString().slice(0, 10), { requests: 0, failed: 0, credits: 0 });
    for (const r of usage.byDay) { const d = byDate.get(r.day) ?? { requests: 0, failed: 0, credits: 0 }; d.requests += r.requests; d.failed += r.failed; d.credits += r.credits; byDate.set(r.day, d); }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  }, [usage]);
  const byCapability = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of usage?.byDay ?? []) m.set(r.capability, (m.get(r.capability) ?? 0) + r.succeeded);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([capability, value]) => ({ label: CAP_WORDS[capability] ?? capability, value }));
  }, [usage]);

  const noProjects = projects !== null && projects.length === 0;

  return (
    <>
      {noProjects && (
        <EmptyState icon={<Icon.code />} title="Nothing has called the API yet" body="Three steps: create a project, mint a key in it, make one request. The quick start has the request ready to paste."
          actions={<><Button href="/developer/projects">Create a project</Button><Button variant="ghost" href="/developer/docs">Read the quick start</Button></>} />
      )}

      <div className={styles.groupHead}>
        <SegmentedControl label="Period" value={days} onChange={setDays} items={[{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }]} />
        {projects && projects.length > 1 && (
          <div className={styles.chips} role="group" aria-label="Project">
            <button type="button" className={styles.chip} aria-pressed={!projectId} onClick={() => setProjectId(undefined)}>All projects</button>
            {projects.map((p) => <button key={p.id} type="button" className={styles.chip} aria-pressed={projectId === p.id} onClick={() => setProjectId(p.id)}>{p.name}</button>)}
          </div>
        )}
      </div>

      <div className={styles.heroes}>
        {usage ? (
          <>
            <Hero label="Requests" value={usage.totals.requests.toLocaleString()} sub={usage.totals.failed ? `${usage.totals.failed} failed` : 'none failed'} tone={usage.totals.failed && usage.totals.failed / Math.max(1, usage.totals.requests) > 0.1 ? 'warn' : undefined} />
            <Hero label="Credits spent" value={usage.totals.credits.toLocaleString()} sub={`${usage.balance.toLocaleString()} left`} tone={usage.balance < 100 ? 'warn' : undefined} />
            <Hero label="Merchants served" value={usage.totals.merchants.toLocaleString()} sub="by your merchantRef" />
            <Hero label="Typical wait" value={usage.totals.p50Sec ? (usage.totals.p50Sec < 60 ? `${Math.round(usage.totals.p50Sec)}s` : `${Math.round(usage.totals.p50Sec / 60)} min`) : '—'} sub="request to result, median" />
          </>
        ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} height={96} />)}
      </div>

      {usage ? <DailyBars title="Requests per day" points={series.map((d) => ({ date: d.date, values: usage.totals.failed ? [d.requests - d.failed, d.failed] : [d.requests] }))} series={usage.totals.failed ? ['Succeeded', 'Failed'] : ['Requests']} /> : <Skeleton height={240} />}

      <div className={styles.two}>
        {usage ? <DailyBars title="Credits per day" points={series.map((d) => ({ date: d.date, values: [d.credits] }))} series={['Credits']} height={150} /> : <Skeleton height={200} />}
        {usage ? <Breakdown title="What was made" rows={byCapability} color="var(--chart-2)" /> : <Skeleton height={200} />}
      </div>

      <div className={styles.two}>
        {usage ? <Breakdown title="By project" rows={usage.byProject.map((p) => ({ label: p.name, value: p.requests, sub: `${p.credits} credits · ${p.merchants} merchants` }))} color="var(--chart-3)" /> : <Skeleton height={200} />}
        {usage ? <Breakdown title="By key" rows={usage.byKey.map((k) => ({ label: `${k.name} · ${k.prefix}…`, value: k.requests, sub: k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used' }))} color="var(--chart-4)" /> : <Skeleton height={200} />}
      </div>

      {usage && usage.byMerchant.length > 0 && <Breakdown title="Busiest merchants" rows={usage.byMerchant.map((m) => ({ label: m.merchantRef, value: m.requests, sub: `${m.credits} credits` }))} unit="" />}
    </>
  );
}
