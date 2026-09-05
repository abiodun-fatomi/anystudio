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

  const load = useCallback(
    async (after?: string) => {
      try {
        const r = await api.notifications.list({ take: 40, cursor: after, unread: filter === 'unread' });
        // An older API answers with a bare array and no counts; an empty
        // inbox is never a reason to fail the page.
        const rows: NotificationItem[] = Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : [];
        setItems((cur) => (after && cur ? [...cur, ...rows] : rows));
        setCursor(typeof r?.nextCursor === 'string' ? r.nextCursor : null);
        setUnread(typeof r?.unread === 'number' ? r.unread : rows.filter((n) => !n.read).length);
      } catch {
        setItems([]);
      } finally {
        setMore(false);
      }
    },
    [filter],
  );
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const markAll = async () => {
    try {
      const r = await api.notifications.read({ all: true });
      setUnread(r.unread);
      setItems((cur) => cur?.map((i) => ({ ...i, read: true })) ?? cur);
    } catch {
      /* next load */
    }
  };
  const open = (n: NotificationItem) => {
    if (!n.read) {
      void api.notifications
        .read({ ids: [n.id] })
        .then((r) => setUnread(r.unread))
        .catch(() => undefined);
      setItems((cur) => cur?.map((i) => (i.id === n.id ? { ...i, read: true } : i)) ?? cur);
    }
  };

  return (
    <div className="rise">
      <PageHeader
        title="Notifications"
        lede="What finished, what arrived, and what the platform wants you to know."
        actions={
          unread > 0 ? (
            <Button variant="ghost" onClick={markAll}>
              Mark all read
            </Button>
          ) : undefined
        }
      />
      <div style={{ marginBottom: 'var(--s-4)' }}>
        <SegmentedControl
          label="Show"
          value={filter}
          onChange={(v) => setFilter(v as 'all' | 'unread')}
          items={[
            { id: 'all', label: 'Everything' },
            { id: 'unread', label: `Unread${unread ? ` · ${unread}` : ''}` },
          ]}
        />
      </div>
      {items === null ? (
        <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={64} />
          ))}
        </div>
      ) : items.length === 0 ? (
        filter === 'unread' ? (
          <EmptyState icon={<Icon.bell />} title="All caught up" body="Nothing is waiting for you. Everything you have already seen is under Everything." />
        ) : (
          <Quiet />
        )
      ) : (
        <>
          <div className={styles.list}>
            {items.map((n) => (
              <Link key={n.id} href={n.href ?? '#'} className={styles.item} data-unread={!n.read || undefined} onClick={() => open(n)}>
                <span className={styles.icon} data-kind={n.kind} aria-hidden="true">
                  {iconFor(n.kind)}
                </span>
                <span className={styles.text}>
                  <span className={styles.title}>{n.title}</span>
                  {n.body && <span className={styles.body}>{n.body}</span>}
                </span>
                <span className={styles.when}>{ago(n.createdAt)}</span>
              </Link>
            ))}
          </div>
          <Pagination>
            <span>{items.length} shown</span>
            {cursor && (
              <Button
                variant="ghost"
                size="sm"
                loading={more}
                onClick={() => {
                  setMore(true);
                  void load(cursor);
                }}
              >
                Show older
              </Button>
            )}
          </Pagination>
        </>
      )}
    </div>
  );
}

/**
 * An empty inbox is a first-day thing, so it shows what the page is for:
 * three of the moments that will land here, drawn as they will look, and
 * the shortest way to make the first one happen.
 */
const PREVIEW: Array<{ kind: NotificationItem['kind']; title: string; body: string; when: string }> = [
  { kind: 'GENERATION_DONE', title: 'Your product reel is ready', body: 'Hair oil · 6 frames · 12 seconds', when: 'in a moment' },
  { kind: 'CREDITS', title: '150 credits landed', body: 'Welcome credits — enough for a first campaign', when: 'today' },
  { kind: 'MEMBER', title: 'Ravi joined your workspace', body: 'Now a member — they can make and post', when: 'this week' },
];

const NEXT: Array<{ href: string; title: string; body: string; icon: keyof typeof Icon }> = [
  { href: '/studio', title: 'Make something', body: 'One product photo in. A reel, a set of stills, copy that fits — out.', icon: 'studio' },
  { href: '/settings/workspace', title: 'Bring a teammate', body: 'Invite someone to your workspace; you both hear when work lands.', icon: 'user' },
  { href: '/billing', title: 'Top up credits', body: 'When credits arrive, the receipt shows up here first.', icon: 'credits' },
];

function Quiet() {
  return (
    <div className={styles.quiet}>
      <div className={styles.quietCard}>
        <div className={styles.preview} aria-hidden="true">
          {PREVIEW.map((p, i) => (
            <div key={p.title} className={styles.previewRow} style={{ animationDelay: `${120 + i * 140}ms` }}>
              <span className={styles.icon} data-kind={p.kind}>
                {iconFor(p.kind)}
              </span>
              <span className={styles.text}>
                <span className={styles.title}>{p.title}</span>
                <span className={styles.body}>{p.body}</span>
              </span>
              <span className={styles.when}>{p.when}</span>
            </div>
          ))}
          <div className={styles.previewFade} />
        </div>
        <h2 className={styles.quietTitle}>Quiet for now.</h2>
        <p className={styles.quietLede}>
          This is where the studio taps you on the shoulder: a reel that finished rendering, credits that arrived, a teammate who joined, a post that went out.
          Nothing has happened yet — here is how to change that.
        </p>
      </div>
      <div className={styles.next}>
        {NEXT.map((n) => {
          const I = Icon[n.icon];
          return (
            <Link key={n.href} href={n.href} className={styles.nextCard}>
              <span className={styles.nextIcon}>
                <I width={18} height={18} />
              </span>
              <span className={styles.nextTitle}>{n.title}</span>
              <span className={styles.nextBody}>{n.body}</span>
              <span className={styles.nextGo}>
                Go <Icon.chevron width={14} height={14} />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
