'use client';
/** The auth and admin event log: who did what, from where, with what reason. */
import { useState } from 'react';
import { api, type AdminEvent } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Input, Pager, useCursorPages, Skeleton, Table, tableCell } from '@/components/ui';
import styles from '../admin.module.css';

export default function AuditPage() {
  const [userId, setUserId] = useState('');
  const [type, setType] = useState('');
  const pages = useCursorPages<AdminEvent>(async (cursor, take) => {
    const r = await api.admin.audit({ userId: userId.trim() || undefined, type: type.trim() || undefined, cursor: cursor ?? undefined, take: String(take) });
    return { rows: r.events, nextCursor: r.nextCursor };
  });
  const { rows } = pages;
  const search = () => pages.reset();
  return (
    <div className="rise">
      <PageHeader title="Audit log" lede="Sign-ins, factor changes, staff actions. The requestId matches the API logs line for line." />
      <form
        className={styles.toolbar}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input label="User id" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="uuid" />
        <Input label="Event type" value={type} onChange={(e) => setType(e.target.value)} placeholder="SIGNED_IN, MFA_ENROLLED…" />
        <Button type="submit">Filter</Button>
      </form>
      {rows === null ? (
        <Skeleton height={240} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Who</th>
                <th>Surface</th>
                <th>IP</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className={tableCell.shrink}>{new Date(e.createdAt).toLocaleString()}</td>
                  <td className={styles.mono}>{e.type}</td>
                  <td>{e.user ? <a href={`/admin/customers/${e.userId}`}>{e.user.name ?? e.user.email ?? e.user.phone}</a> : '—'}</td>
                  <td>{e.surface ?? '—'}</td>
                  <td className={styles.mono}>{e.ip ?? '—'}</td>
                  <td className={styles.mono} style={{ color: 'var(--muted)' }}>
                    {e.detail ? JSON.stringify(e.detail).slice(0, 140) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager
            page={pages.page}
            count={rows.length}
            noun="events"
            size={pages.size}
            hasOlder={pages.hasOlder}
            hasNewer={pages.hasNewer}
            busy={pages.busy}
            onOlder={() => void pages.older()}
            onNewer={() => void pages.newer()}
            onSize={(n) => void pages.changeSize(n)}
          />
        </>
      )}
    </div>
  );
}
