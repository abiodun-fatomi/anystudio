'use client';
/** Money in vs money out, in USD: consumed credits valued at realized (else list) price, vendor spend, per-currency cash, subscriptions. SUPERADMIN only. */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Select, Skeleton, Table, tableCell } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

type Economics = Awaited<ReturnType<typeof api.admin.economics>>;

const money = (m: number | null | undefined) => (m == null ? '—' : (m / 100).toFixed(2));
const pct = (rev: number | null, spend: number) => (rev == null || rev <= 0 ? '—' : `${Math.round((1 - spend / rev) * 100)}%`);

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
    const value = d.toISOString().slice(0, 7);
    months.push({ value, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
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

  return (
    <div className="rise">
      <PageHeader
        title="Economics"
        lede="Consumed credits valued in USD against what the vendors actually billed. Cash is listed per currency; kobo are not cents."
      />
      <div className={styles.toolbar}>
        <Select label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} options={options} />
      </div>
      {error ? <p className={styles.danger}>{error}</p> : null}
      {data === null && !error ? (
        <Skeleton height={280} />
      ) : data ? (
        <>
          {data.creditValueBasis ? (
            <p className={styles.mono} style={{ color: 'var(--muted)' }}>
              1 credit ≈ ${money(data.creditValueUsdMinor)}{' '}
              {data.creditValueBasis === 'realized' ? '(what USD buyers actually paid this period)' : '(cheapest list price — no USD sales in this period yet)'}
            </p>
          ) : (
            <p className={styles.mono} style={{ color: 'var(--muted)' }}>
              No USD price found on any active pack or plan, so revenue is shown as — until the catalogue has one.
            </p>
          )}
          <Table>
            <thead>
              <tr>
                <th>Totals · {data.window}</th>
                <th className={tableCell.num}>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Est. revenue consumed (USD)</td>
                <td className={tableCell.num}>{money(data.totals.revenueUsdMinor)}</td>
              </tr>
              <tr>
                <td>Vendor spend (USD)</td>
                <td className={tableCell.num}>{money(data.totals.spendMinor)}</td>
              </tr>
              <tr>
                <td>Gross margin (USD)</td>
                <td className={tableCell.num}>
                  {money(data.totals.marginUsdMinor)} · {pct(data.totals.revenueUsdMinor, data.totals.spendMinor)}
                </td>
              </tr>
              <tr>
                <td>Credits consumed (succeeded)</td>
                <td className={tableCell.num}>{data.totals.creditsConsumed}</td>
              </tr>
              <tr>
                <td>Generations (succeeded, top-level)</td>
                <td className={tableCell.num}>{data.totals.generations}</td>
              </tr>
              {data.totals.cash.map((c) => (
                <tr key={c.currency}>
                  <td>
                    Cash collected ({c.currency}) · {c.payments} payment{c.payments === 1 ? '' : 's'}
                  </td>
                  <td className={tableCell.num}>{money(c.amountMinor)}</td>
                </tr>
              ))}
              {data.totals.cash.length === 0 ? (
                <tr>
                  <td>Cash collected</td>
                  <td className={tableCell.num}>0.00</td>
                </tr>
              ) : null}
              <tr>
                <td>Credits sold</td>
                <td className={tableCell.num}>{data.totals.creditsSold}</td>
              </tr>
              <tr>
                <td>Active subscriptions (now)</td>
                <td className={tableCell.num}>{data.totals.subscriptionsActive}</td>
              </tr>
              {data.totals.subscriptionsPastDue > 0 ? (
                <tr>
                  <td>Past-due subscriptions (now)</td>
                  <td className={tableCell.num}>{data.totals.subscriptionsPastDue}</td>
                </tr>
              ) : null}
              <tr>
                <td>Est. MRR (USD, now)</td>
                <td className={tableCell.num}>{money(data.totals.mrrUsdMinor)}</td>
              </tr>
            </tbody>
          </Table>
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
              {data.byCapability.map((c) => (
                <tr key={c.capability}>
                  <td>{c.capability}</td>
                  <td className={tableCell.num}>{c.generations}</td>
                  <td className={tableCell.num}>{c.credits}</td>
                  <td className={tableCell.num}>{money(revOf(c.credits))}</td>
                  <td className={tableCell.num}>{money(c.spendMinor)}</td>
                  <td className={tableCell.num}>{pct(revOf(c.credits), c.spendMinor)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Capability</th>
                <th className={tableCell.num}>Calls</th>
                <th className={tableCell.num}>Vendor spend</th>
              </tr>
            </thead>
            <tbody>
              {data.byProvider.map((r) => (
                <tr key={`${r.providerKey}-${r.capability}`}>
                  <td className={styles.mono}>{r.providerKey}</td>
                  <td>{r.capability}</td>
                  <td className={tableCell.num}>{r.calls}</td>
                  <td className={tableCell.num}>{money(r.spendMinor)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table>
            <thead>
              <tr>
                <th>Day</th>
                <th className={tableCell.num}>Credits consumed</th>
                <th className={tableCell.num}>Est. revenue</th>
                <th className={tableCell.num}>Vendor spend</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((d) => (
                <tr key={d.day}>
                  <td className={styles.mono}>{d.day}</td>
                  <td className={tableCell.num}>{d.credits}</td>
                  <td className={tableCell.num}>{money(revOf(d.credits))}</td>
                  <td className={tableCell.num}>{money(d.spendMinor)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : null}
    </div>
  );
}
