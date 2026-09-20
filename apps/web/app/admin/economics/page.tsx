'use client';
/** The money page: unit economics up top, stat cards with deltas and sparklines, daily bars, provider donut, capability breakdown, exact figures last. SUPERADMIN only. */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Select, Skeleton, Table, tableCell } from '@/components/ui';
import { Breakdown, DailyBars, Delta, Donut, Hero, SERIES, Spark, StatCard, UnitSplit } from '@/components/charts/Charts';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

type Economics = Awaited<ReturnType<typeof api.admin.economics>>;

const money = (m: number | null | undefined) => (m == null ? '—' : (m / 100).toFixed(2));
const usd = (m: number) => Math.round(m) / 100;
const marginPct = (rev: number | null, spend: number) => (rev == null || rev <= 0 ? null : Math.round((1 - spend / rev) * 100));

function periods() {
  const fixed = [
    { value: '24h', label: 'Last 24 hours' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
    { value: '90d', label: 'Last 90 days' },
    { value: 'mtd', label: 'This month so far' },
    { value: 'all', label: 'All time' },
  ];
  const months: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ value: d.toISOString().slice(0, 7), label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
  }
  return [...fixed, ...months];
}

export default function EconomicsPage() {
  const { atLeast } = useAdmin();
  const allowed = atLeast('SUPERADMIN');
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState<Economics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(periods, []);

  useEffect(() => {
    if (!allowed) return;
    let gone = false;
    setData(null);
    setError(null);
    api.admin
      .economics(period)
      .then((d) => {
        if (!gone) setData(d);
      })
      .catch((e: unknown) => {
        if (!gone) setError(e instanceof Error ? e.message : 'Could not load it');
      });
    return () => {
      gone = true;
    };
  }, [allowed, period]);

  if (!allowed) return <PageHeader title="Economics" lede="This page is for the SUPERADMIN rank." />;

  const v = data?.creditValueUsdMinor ?? null;
  const revOf = (credits: number) => (v == null ? null : Math.round(credits * v));
  const margin = data?.totals.marginUsdMinor ?? null;
  const mPct = data ? marginPct(data.totals.revenueUsdMinor, data.totals.spendMinor) : null;
  const prevMargin = data?.previous && data.previous.revenueUsdMinor != null ? data.previous.revenueUsdMinor - data.previous.spendMinor : null;
  const usdCash = data?.totals.cash.find((c) => c.currency === 'USD');
  const otherCash = (data?.totals.cash ?? []).filter((c) => c.currency !== 'USD');
  const revenueSpark = data ? data.daily.map((d) => usd(revOf(d.credits) ?? 0)) : [];
  const spendSpark = data ? data.daily.map((d) => usd(d.spendMinor)) : [];

  return (
    <div className="rise">
      <PageHeader
        title="Economics"
        lede="Consumed credits valued in USD against what the vendors actually billed. Deltas compare the equal period before this one."
      />
      <div className={styles.toolbar}>
        <Select label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} options={options} />
      </div>
      {error ? <p className={styles.danger}>{error}</p> : null}
      {data === null && !error ? (
        <Skeleton height={360} />
      ) : data ? (
        <>
          {data.totals.revenueUsdMinor != null && data.totals.revenueUsdMinor > 0 ? (
            <UnitSplit revenueMinor={data.totals.revenueUsdMinor} spendMinor={data.totals.spendMinor} />
          ) : null}
          <div className={styles.heroes}>
            <StatCard
              label="Est. revenue consumed"
              value={data.totals.revenueUsdMinor == null ? '—' : `$${money(data.totals.revenueUsdMinor)}`}
              delta={<Delta now={data.totals.revenueUsdMinor} prev={data.previous?.revenueUsdMinor ?? null} />}
              spark={<Spark values={revenueSpark} color={SERIES[0]} />}
              sub={
                data.creditValueBasis == null
                  ? 'no USD price on any active pack or plan yet'
                  : `1 credit ≈ $${money(v)} · ${data.creditValueBasis === 'realized' ? 'what USD buyers paid' : 'cheapest list price'}`
              }
            />
            <StatCard
              label="Vendor spend"
              value={`$${money(data.totals.spendMinor)}`}
              delta={<Delta now={data.totals.spendMinor} prev={data.previous?.spendMinor ?? null} goodWhenDown />}
              spark={<Spark values={spendSpark} color={SERIES[1]} />}
              sub={`${data.totals.generations.toLocaleString()} succeeded generations`}
            />
            <StatCard
              label="Gross margin"
              value={margin == null ? '—' : `$${money(margin)}`}
              delta={<Delta now={margin} prev={prevMargin} />}
              tone={margin == null ? undefined : margin < 0 ? 'danger' : mPct != null && mPct >= 50 ? 'ok' : undefined}
              sub={mPct == null ? 'needs a credit price' : `${mPct}% of consumed revenue stays`}
            />
            <StatCard
              label="Cash collected"
              value={`$${money(usdCash?.amountMinor ?? 0)}`}
              delta={<Delta now={usdCash?.amountMinor ?? 0} prev={data.previous?.cashUsdMinor ?? null} />}
              sub={
                otherCash.length
                  ? otherCash.map((c) => `${c.currency} ${money(c.amountMinor)}`).join(' · ')
                  : `${data.totals.cash.reduce((n, c) => n + c.payments, 0)} payments · ${data.totals.creditsSold.toLocaleString()} credits sold`
              }
            />
          </div>
          <DailyBars
            title="Money by day"
            unit=" USD"
            series={v == null ? ['Vendor spend'] : ['Est. revenue', 'Vendor spend']}
            points={data.daily.map((d) => ({
              date: d.day,
              values: v == null ? [usd(d.spendMinor)] : [usd(revOf(d.credits) ?? 0), usd(d.spendMinor)],
            }))}
          />
          <div className={styles.split}>
            <Donut
              title="Vendor spend by provider"
              unit=" USD"
              centre={`$${money(data.totals.spendMinor)}`}
              centreSub="this period"
              slices={data.byProvider.slice(0, 4).map((r) => ({ label: r.providerKey, value: usd(r.spendMinor), sub: `${r.calls} calls · ${r.capability}` }))}
            />
            <Breakdown
              title={v == null ? 'Credits by capability' : 'Est. revenue by capability'}
              unit={v == null ? '' : ' USD'}
              color={SERIES[2]}
              rows={data.byCapability.map((c) => {
                const p = marginPct(revOf(c.credits), c.spendMinor);
                return {
                  label: c.capability,
                  value: v == null ? c.credits : usd(revOf(c.credits) ?? 0),
                  sub: `${c.generations} generations${p == null ? '' : ` · ${p}% margin`}`,
                };
              })}
            />
          </div>
          <div className={styles.heroes}>
            <Hero label="Credits consumed" value={data.totals.creditsConsumed.toLocaleString()} sub="succeeded, top-level only" />
            <Hero label="Credits sold" value={data.totals.creditsSold.toLocaleString()} sub="all currencies" />
            <Hero
              label="Active subscriptions"
              value={data.totals.subscriptionsActive.toLocaleString()}
              sub={data.totals.subscriptionsPastDue ? `${data.totals.subscriptionsPastDue} past due` : 'now, not windowed'}
              tone={data.totals.subscriptionsPastDue ? 'warn' : undefined}
            />
            <Hero label="Est. MRR" value={`$${money(data.totals.mrrUsdMinor)}`} sub="active subs at plan list price" />
          </div>
          <Table>
            <thead>
              <tr>
                <th>Capability</th>
                <th className={tableCell.num}>Generations</th>
                <th className={tableCell.num}>Credits</th>
                <th className={tableCell.num}>Est. revenue</th>
                <th className={tableCell.num}>Vendor spend</th>
                <th className={tableCell.num}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {data.byCapability.map((c) => {
                const p = marginPct(revOf(c.credits), c.spendMinor);
                return (
                  <tr key={c.capability}>
                    <td>{c.capability}</td>
                    <td className={tableCell.num}>{c.generations}</td>
                    <td className={tableCell.num}>{c.credits}</td>
                    <td className={tableCell.num}>{money(revOf(c.credits))}</td>
                    <td className={tableCell.num}>{money(c.spendMinor)}</td>
                    <td className={tableCell.num}>{p == null ? '—' : `${p}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      ) : null}
    </div>
  );
}
