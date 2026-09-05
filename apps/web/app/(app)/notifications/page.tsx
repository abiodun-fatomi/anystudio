'use client';
/** Everything the bell has ever said, newest first, with the read ones dimmed. */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type NotificationItem } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, EmptyState, Pagination, SegmentedControl, Skeleton } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { ago, iconFor } from '@/components/shell/Bell';
import styles from './notifications.module.css';

export default function NotificationsPage() {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);

  const load = useCallback(async (after?: string) => {
    try {
      const r = await api.notifications.list({ take: 40, cursor: after, unread: filter === 'unread' });
      setItems((cur) => (after && cur ? [...cur, ...r.items] : r.items)); setCursor(r.nextCursor); setUnread(r.unread);
    } catch { setItems([]); } finally { setMore(false); }
  }, [filter]);
  useEffect(() => { setItems(null); void load(); }, [load]);

  const markAll = async () => { try { const r = await api.notifications.read({ all: true }); setUnread(r.unread); setItems((cur) => cur?.map((i) => ({ ...i, read: true })) ?? cur); } catch { /* next load */ } };
  const open = (n: NotificationItem) => { if (!n.read) { void api.notifications.read({ ids: [n.id] }).then((r) => setUnread(r.unread)).catch(() => undefined); setItems((cur) => cur?.map((i) => (i.id === n.id ? { ...i, read: true } : i)) ?? cur); } };

  return (
    <div className="rise">
      <PageHeader title="Notifications" lede="What finished, what arrived, and what the platform wants you to know." actions={unread > 0 ? <Button variant="ghost" onClick={markAll}>Mark all read</Button> : undefined} />
      <div style={{ marginBottom: 'var(--s-4)' }}><SegmentedControl label="Show" value={filter} onChange={(v) => setFilter(v as 'all' | 'unread')} items={[{ id: 'all', label: 'Everything' }, { id: 'unread', label: `Unread${unread ? ` · ${unread}` : ''}` }]} /></div>
      {items === null ? <div style={{ display: 'grid', gap: 'var(--s-2)' }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} />)}</div>
        : items.length === 0 ? <EmptyState icon={<Icon.bell />} title={filter === 'unread' ? 'Nothing unread' : 'Nothing yet'} body="When something you made is ready, credits land, or someone joins your workspace, it shows here." />
          : (
            <>
              <div className={styles.list}>
                {items.map((n) => (
                  <Link key={n.id} href={n.href ?? '#'} className={styles.item} data-unread={!n.read || undefined} onClick={() => open(n)}>
                    <span className={styles.icon} data-kind={n.kind} aria-hidden="true">{iconFor(n.kind)}</span>
                    <span className={styles.text}><span className={styles.title}>{n.title}</span>{n.body && <span className={styles.body}>{n.body}</span>}</span>
                    <span className={styles.when}>{ago(n.createdAt)}</span>
                  </Link>
                ))}
              </div>
              <Pagination><span>{items.length} shown</span>{cursor && <Button variant="ghost" size="sm" loading={more} onClick={() => { setMore(true); void load(cursor); }}>Show older</Button>}</Pagination>
            </>
          )}
    </div>
  );
}
