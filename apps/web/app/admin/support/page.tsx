'use client';
/**
 * Help chats: every conversation the floater opened, the assistant's answers
 * beside the person's words, and the ones that need a person on top.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminSupportRow } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Input, SegmentedControl, Skeleton, Table, Button } from '@/components/ui';
import styles from '../admin.module.css';

type Filter = 'needs_human' | 'open' | 'closed' | 'all';
const ROLE: Record<string, string> = { USER: 'Person', ASSISTANT: 'Assistant', STAFF: 'Team', SYSTEM: '' };

export default function SupportListPage() {
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ counts: { open: number; needsHuman: number }; rows: AdminSupportRow[]; nextCursor: string | null } | null>(null);
  const [more, setMore] = useState(false);
  const load = useCallback((cursor?: string) => {
    if (cursor) setMore(true);
    api.admin.support({ filter, q: q.trim() || undefined, cursor })
      .then((r) => setData((cur) => (cursor && cur ? { ...r, rows: [...cur.rows, ...r.rows] } : r)))
      .catch(() => setData({ counts: { open: 0, needsHuman: 0 }, rows: [], nextCursor: null }))
      .finally(() => setMore(false));
  }, [filter, q]);
  useEffect(() => { const t = setTimeout(() => load(), q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const t = setInterval(() => load(), 30_000); return () => clearInterval(t); }, [load]);

  return (
    <div className="rise">
      <PageHeader title="Help chats" lede={data ? `${data.counts.open} open · ${data.counts.needsHuman} waiting for a person. The assistant answers first; step in from a chat.` : 'Loading…'} />
      <div className={styles.toolbar}>
        <SegmentedControl<Filter> label="Show" value={filter} onChange={setFilter}
          items={[{ id: 'needs_human', label: `Needs a person${data?.counts.needsHuman ? ` (${data.counts.needsHuman})` : ''}` }, { id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }, { id: 'all', label: 'All' }]} />
        <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email, name or topic" />
      </div>
      {data === null ? <Skeleton height={240} /> : data.rows.length === 0 ? <p style={{ color: 'var(--muted)' }}>{filter === 'needs_human' ? 'Nobody is waiting. The assistant has it.' : 'No chats here.'}</p> : (
        <Table>
          <thead><tr><th>Who</th><th>About</th><th>Last message</th><th>State</th><th>When</th></tr></thead>
          <tbody>{data.rows.map((r) => (
            <tr key={r.id} className={styles.clickRow} onClick={() => { window.location.href = `/admin/support/${r.id}`; }}>
              <td><Link href={`/admin/support/${r.id}`} onClick={(e) => e.stopPropagation()}><strong>{r.user.name ?? r.user.email ?? 'Someone'}</strong></Link><div className={styles.mono} style={{ color: 'var(--muted)' }}>{r.user.email}</div></td>
              <td>{r.topic ?? <span style={{ color: 'var(--muted)' }}>—</span>}{r.page && <div className={styles.mono} style={{ color: 'var(--muted)' }}>{r.page}</div>}</td>
              <td style={{ maxWidth: 360 }}>{r.last ? <><span style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>{ROLE[r.last.role]} · </span>{r.last.text}</> : <span style={{ color: 'var(--muted)' }}>Nothing said yet</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {r.status === 'CLOSED' ? <span className={styles.pill}>closed</span> : r.needsHuman ? <span className={styles.pill} data-tone="warn">needs a person</span> : <span className={styles.pill} data-tone="ok">assistant</span>}
                {r.staffJoined && <span className={styles.pill} style={{ marginLeft: 6 }}>team in</span>}
              </td>
              <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{new Date(r.lastMessageAt).toLocaleString()}<div className={styles.mono}>{r.messageCount} msgs</div></td>
            </tr>
          ))}</tbody>
        </Table>
      )}
      {data?.nextCursor && <div style={{ marginTop: 'var(--s-4)' }}><Button variant="ghost" loading={more} onClick={() => load(data.nextCursor!)}>Show older</Button></div>}
    </div>
  );
}
