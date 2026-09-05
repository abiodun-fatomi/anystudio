'use client';
/** Find a person by email, phone, name or id. */
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, type AdminCustomer } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Input, Pagination, Skeleton, Table, tableCell } from '@/components/ui';
import styles from '../admin.module.css';

export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <Customers />
    </Suspense>
  );
}

function Customers() {
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [rows, setRows] = useState<AdminCustomer[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const search = async (after?: string) => {
    if (!after) setRows(null);
    try {
      const r = await api.admin.customers(q.trim(), after);
      setRows((cur) => (after && cur ? [...cur, ...r.customers] : r.customers));
      setCursor(r.nextCursor);
    } catch {
      setRows([]);
    }
  };
  useEffect(() => {
    void search();
  }, []);
  return (
    <div className="rise">
      <PageHeader title="Customers" lede="Search by email, phone, name or id. Open one for their workspaces, balances, generations and payments." />
      <form
        className={styles.toolbar}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ada@example.com · +234… · Ada" autoFocus />
        <Button type="submit">Search</Button>
      </form>
      {rows === null ? (
        <Skeleton height={200} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Workspaces</th>
                <th>Joined</th>
                <th>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={styles.clickRow} onClick={() => router.push(`/admin/customers/${u.id}`)}>
                  <td>
                    <strong>{u.name ?? '—'}</strong>
                    <div className={styles.mono} style={{ color: 'var(--muted)' }}>
                      {u.id.slice(0, 8)}
                    </div>
                  </td>
                  <td>
                    {u.email ?? ''}
                    {u.email && u.phone ? ' · ' : ''}
                    {u.phone ?? ''}
                  </td>
                  <td>
                    <span className={styles.pill} data-tone={u.status === 'ACTIVE' ? 'ok' : u.status === 'SUSPENDED' ? 'danger' : undefined}>
                      {u.status}
                    </span>
                  </td>
                  <td style={{ fontSize: 'var(--t-1)' }}>
                    {u.workspaces.map((w) => `${w.name} (${w.type.toLowerCase()}, ${w.role.toLowerCase()})`).join(' · ') || '—'}
                  </td>
                  <td className={tableCell.shrink}>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td className={tableCell.shrink}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination>
            <span>{rows.length} shown</span>
            {cursor && (
              <Button variant="ghost" size="sm" onClick={() => void search(cursor)}>
                More
              </Button>
            )}
          </Pagination>
        </>
      )}
    </div>
  );
}
