'use client';
/**
 * Insights — what this workspace made, what it cost, and how long the
 * credits will last. Every number is computed on the server from the
 * generation rows and the ledger; nothing is estimated here.
 *
 * Engagement per published post appears once publishing lands; the API
 * already returns the slot for it.
 */
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/app-context';
import { api, type Insights } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, EmptyState, SegmentedControl, Skeleton } from '@/components/ui';
import { Breakdown, DailyBars, Hero } from '@/components/charts/Charts';
import { Icon } from '@/components/shell/icons';
import styles from './insights.module.css';

const TYPE_WORDS: Record<string, string> = { image: 'Photos', video: 'Videos', copy: 'Copy', audio: 'Audio' };
const CAP_WORDS: Record<string, string> = {
  IMAGE_GENERATE: 'Scenes',
  IMAGE_EDIT: 'Product photos',
  BACKGROUND_REMOVE: 'Cut-outs',
  BACKGROUND_REPLACE: 'New backgrounds',
  RELIGHT: 'Relights',
  UPSCALE: 'Enhancements',
  IMAGE_TO_VIDEO: 'Reels and ads',
  VIDEO_STITCH: 'Stitched videos',
  TEXT_GENERATE: 'Descriptions and captions',
  VOICEOVER: 'Voiceovers',
  MUSIC: 'Music',
  DUB: 'Dubbing',
  LIPSYNC: 'Lip sync',
};
const RANGES = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
] as const;

function delta(now: number, before: number): { text: string; tone?: 'ok' | 'warn' } | null {
  if (before === 0 && now === 0) return null;
  if (before === 0) return { text: 'new this period', tone: 'ok' };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: 'same as the period before' };
  return { text: `${pct > 0 ? '+' : ''}${pct}% vs the period before`, tone: pct > 0 ? 'ok' : undefined };
}

export default function InsightsPage() {
  const { workspace } = useApp();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    api.insights
      .overview(workspace.id, Number(days))
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : 'Could not load insights.');
      });
    return () => {
      live = false;
    };
  }, [workspace.id, days]);

  if (error)
    return (
      <div className="rise">
        <PageHeader title="Insights" />
        <EmptyState
          title={error}
          actions={
            <Button variant="ghost" onClick={() => setDays((d) => d)}>
              Try again
            </Button>
          }
        />
      </div>
    );

  const madeDelta = data ? delta(data.totals.made, data.totals.previous.made) : null;
  const runway = data?.balance.runwayDays;
  const runwayTone = runway === null || runway === undefined ? undefined : runway < 7 ? 'danger' : runway < 21 ? 'warn' : undefined;
  const nothingYet = data && data.totals.made === 0 && data.totals.failed === 0 && data.library.total === 0;

  return (
    <div className="rise">
      <PageHeader
        title="Insights"
        lede="What you made, what it cost, and how long your credits will last at this pace."
        actions={<SegmentedControl label="Period" value={days} onChange={setDays} items={RANGES.map((r) => ({ id: r.id, label: r.label }))} />}
      />

      {nothingYet ? (
        <EmptyState
          icon={<Icon.insights />}
          title="Nothing to count yet"
          body="Make a few things in the studio and this page fills itself in: what you made per day, what each kind costs, and how long your credits will last."
          actions={<Button href="/studio">Open the studio</Button>}
        />
      ) : (
        <>
          <div className={styles.heroes}>
            {data ? (
              <Hero label="Made" value={data.totals.made.toLocaleString()} sub={madeDelta?.text ?? `in the last ${data.range.days} days`} />
            ) : (
              <Skeleton height={104} />
            )}
            {data ? (
              <Hero
                label="Credits spent"
                value={data.totals.credits.toLocaleString()}
                sub={data.totals.refunded ? `${data.totals.refunded.toLocaleString()} refunded from failures` : 'nothing refunded'}
              />
            ) : (
              <Skeleton height={104} />
            )}
            {data ? (
              <Hero
                label="Went through"
                value={data.totals.successRate === null ? '—' : `${data.totals.successRate}%`}
                sub={data.totals.failed ? `${data.totals.failed} failed, all refunded` : 'no failures'}
                tone={data.totals.successRate !== null && data.totals.successRate < 90 ? 'warn' : undefined}
              />
            ) : (
              <Skeleton height={104} />
            )}
            {data ? (
              <Hero
                label="Credits left"
                value={data.balance.credits.toLocaleString()}
                sub={
                  runway === null
                    ? 'nothing spent in two weeks'
                    : runway !== undefined && runway > 365
                      ? 'more than a year at this pace'
                      : `about ${runway} days at ${data.balance.dailySpend}/day`
                }
                tone={runwayTone}
              />
            ) : (
              <Skeleton height={104} />
            )}
          </div>

          {data ? (
            <DailyBars
              title="Made per day"
              points={data.series.map((d) => ({ date: d.date, values: data.totals.failed ? [d.made, d.failed] : [d.made] }))}
              series={data.totals.failed ? ['Made', 'Failed'] : ['Made']}
            />
          ) : (
            <Skeleton height={240} />
          )}

          <div className={styles.two}>
            {data ? (
              <DailyBars
                title="Credits spent per day"
                points={data.series.map((d) => ({ date: d.date, values: [d.credits] }))}
                series={['Credits']}
                height={150}
              />
            ) : (
              <Skeleton height={200} />
            )}
            {data ? (
              <Breakdown
                title="Credits by kind"
                rows={Object.entries(data.byType)
                  .sort((a, b) => b[1].credits - a[1].credits)
                  .map(([t, v]) => ({ label: TYPE_WORDS[t] ?? t, value: v.credits, sub: `${v.count} made${v.failed ? ` · ${v.failed} failed` : ''}` }))}
                unit=" cr"
              />
            ) : (
              <Skeleton height={200} />
            )}
          </div>

          <div className={styles.two}>
            {data ? (
              <Breakdown
                title="What you made"
                rows={data.byCapability
                  .filter((c) => c.count > 0)
                  .sort((a, b) => b.count - a.count)
                  .map((c) => ({
                    label: CAP_WORDS[c.capability] ?? c.capability,
                    value: c.count,
                    sub: (() => {
                      const t = data.timing.find((x) => x.capability === c.capability);
                      return t?.p50Sec ? `usually ${t.p50Sec < 60 ? `${t.p50Sec}s` : `${Math.round(t.p50Sec / 60)} min`}` : undefined;
                    })(),
                  }))}
                color="var(--chart-2)"
              />
            ) : (
              <Skeleton height={200} />
            )}
            {data ? (
              <Breakdown
                title="Busiest products"
                rows={data.topProducts.map((p) => ({ label: p.title ?? p.productKey, value: p.count, sub: `${p.credits} credits` }))}
                color="var(--chart-4)"
              />
            ) : (
              <Skeleton height={200} />
            )}
          </div>

          {data && (
            <section className={styles.library} aria-label="Library">
              <div>
                <strong>{data.library.total.toLocaleString()}</strong>
                <span>in your library</span>
              </div>
              <div>
                <strong>{data.library.added.toLocaleString()}</strong>
                <span>added this period</span>
              </div>
              <div>
                <strong>{data.library.images.toLocaleString()}</strong>
                <span>photos</span>
              </div>
              <div>
                <strong>{data.library.videos.toLocaleString()}</strong>
                <span>videos</span>
              </div>
              <div>
                <strong>{data.library.copy.toLocaleString()}</strong>
                <span>pieces of copy</span>
              </div>
              <div>
                <strong>{data.library.sources.toLocaleString()}</strong>
                <span>uploads</span>
              </div>
              <Button variant="ghost" size="sm" href="/library">
                Open the library
              </Button>
            </section>
          )}

          <p className={styles.fine}>
            Engagement per published post — which photos and reels people actually tapped — arrives with publishing. Until then, the credits-by-kind chart is
            the honest guide to where your money goes.
          </p>
        </>
      )}
    </div>
  );
}
