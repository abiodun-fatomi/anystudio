'use client';
/** Money in vs money out: consumed credits against reconciled vendor cost, cash sold beside it. SUPERADMIN only; the API enforces it too. */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Select, Skeleton, Table, tableCell } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

type Economics = Awaited<ReturnType<typeof api.admin.economics>>;

const WINDOWS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];
const money = (m: number) => (m / 100).toFixed(2);

export default function EconomicsPage() {
  const { atLeast } = useAdmin();
  const allowed = atLeast('SUPERADMIN');
  const [span, setSpan] = useState('7d');
  const [data, setData] = useState<Economics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let gone = false;
    setData(null);
    setError(null);
    api.admin
      .economics(span)
      .then((d) => {
        if (!gone) setData(d);
      })
      .catch((e: unknown) => {
        if (!gone) setError(e instanceof Error ? e.message : 'Could not load it');
      });
    return () => {
      gone = true;
    };
  }, [allowed, span]);

  if (!allowed) return <PageHeader title="Economics" lede="This page is for the SUPERADMIN rank." />;

  return (
    <div className="rise">
      <PageHeader
        title="Economics"
        lede="Consumed credits against what the vendors actually billed. Cash is what customers paid; the two are different things."
      />
      <div className={styles.toolbar}>
        <Select label="Window" value={span} onChange={(e) => setSpan(e.target.value)} options={WINDOWS} />
      </div>
      {error ? <p className={styles.danger}>{error}</p> : null}
      {data === null && !error ? (
        <Skeleton height={280} />
      ) : data ? (
        <>
          <Table>
            <thead>
              <tr>
                <th>Totals · {data.window}</th>
                <th className={tableCell.num}>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Credits consumed (succeeded)</td>
                <td className={tableCell.num}>{data.totals.creditsConsumed}</td>
              </tr>
              <tr>
                <td>Generations (succeeded, top-level)</td>
                <td className={tableCell.num}>{data.totals.generations}</td>
              </tr>
              <tr>
                <td>Vendor spend (USD)</td>
                <td className={tableCell.num}>{money(data.totals.spendMinor)}</td>
              </tr>
              <tr>
                <td>Cash collected (USD)</td>
                <td className={tableCell.num}>{money(data.totals.cashMinor)}</td>
              </tr>
              <tr>
                <td>Credits sold</td>
                <td className={tableCell.num}>{data.totals.creditsSold}</td>
              </tr>
            </tbody>
          </Table>
          <Table>
            <thead>
              <tr>
                <th>Capability</th>
                <th className={tableCell.num}>Generations</th>
                <th className={tableCell.num}>Credits</th>
                <th className={tableCell.num}>Vendor spend</th>
              </tr>
            </thead>
            <tbody>
              {data.byCapability.map((c) => (
                <tr key={c.capability}>
                  <td>{c.capability}</td>
                  <td className={tableCell.num}>{c.generations}</td>
                  <td className={tableCell.num}>{c.credits}</td>
                  <td className={tableCell.num}>{money(c.spendMinor)}</td>
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
                <th className={tableCell.num}>Vendor spend</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((d) => (
                <tr key={d.day}>
                  <td className={styles.mono}>{d.day}</td>
                  <td className={tableCell.num}>{d.credits}</td>
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
