'use client';
/**
 * The bell: what happened while you were away. A count while there is
 * something unread, the latest ten in a popover, "mark all read", and a
 * page with everything. It asks the server once a minute and whenever the
 * tab regains focus — a generation finishing shows in the studio card
 * first and in the bell a moment later; nothing needs a socket.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type NotificationItem } from '@/lib/api';
import { Button, Popover, Skeleton } from '@/components/ui';
import { Icon } from './icons';
import styles from './Bell.module.css';

const POLL_MS = 60_000;

export function Bell() {
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [opened, setOpened] = useState(false);

  const refreshCount = useCallback(() => {
    api.notifications
      .unread()
      .then((r) => setUnread(r?.unread ?? 0))
      .catch(() => undefined);
  }, []);
  const load = useCallback(() => {
    api.notifications
      .list({ take: 10 })
      .then((r) => {
        // An older API (a deploy in flight) may not know this route yet.
        setItems(Array.isArray(r?.items) ? r.items : []);
        setUnread(r?.unread ?? 0);
      })
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    refreshCount();
    const t = setInterval(refreshCount, POLL_MS);
    const onFocus = () => refreshCount();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCount]);

  const markAll = async () => {
    try {
      const r = await api.notifications.read({ all: true });
      setUnread(r.unread);
      setItems((cur) => cur?.map((i) => ({ ...i, read: true })) ?? cur);
    } catch {
      /* next poll */
    }
  };
  const open = (n: NotificationItem, close: () => void) => {
    if (!n.read) {
      void api.notifications
        .read({ ids: [n.id] })
        .then((r) => setUnread(r.unread))
        .catch(() => undefined);
      setItems((cur) => cur?.map((i) => (i.id === n.id ? { ...i, read: true } : i)) ?? cur);
    }
    close();
  };

  return (
    <Popover
      align="end"
      trigger={
        <button
          type="button"
          className={styles.bell}
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          onClick={() => {
            if (!opened) {
              setOpened(true);
              load();
            } else load();
          }}
        >
          <Icon.bell />
          {unread > 0 && (
            <span className={styles.badge} aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      }
    >
      {(close) => (
        <div className={styles.panel}>
          <div className={styles.head}>
            <strong>Notifications</strong>
            {unread > 0 && (
              <Button variant="link" size="sm" onClick={markAll}>
                Mark all read
              </Button>
            )}
          </div>
          {items === null ? (
            <div className={styles.list}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={56} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className={styles.empty}>Nothing yet. When something you made is ready, or credits land, it shows here.</div>
          ) : (
            <div className={styles.list} role="list">
              {items.map((n) => (
                <Link
                  key={n.id}
                  href={n.href ?? '/notifications'}
                  className={styles.item}
                  data-unread={!n.read || undefined}
                  role="listitem"
                  onClick={() => open(n, close)}
                >
                  <span className={styles.icon} data-kind={n.kind} aria-hidden="true">
                    {iconFor(n.kind)}
                  </span>
                  <span className={styles.text}>
                    <span className={styles.title}>{n.title}</span>
                    {n.body && <span className={styles.body}>{n.body}</span>}
                    <span className={styles.when}>{ago(n.createdAt)}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
          <div className={styles.foot}>
            <Link href="/notifications" onClick={close}>
              See everything
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function iconFor(kind: NotificationItem['kind']) {
  switch (kind) {
    case 'GENERATION_DONE':
      return <Icon.check width={16} height={16} />;
    case 'GENERATION_FAILED':
      return <Icon.bell width={16} height={16} />;
    case 'CREDITS':
      return <Icon.credits width={16} height={16} />;
    case 'MEMBER':
      return <Icon.user width={16} height={16} />;
    case 'PUBLISH':
      return <Icon.publish width={16} height={16} />;
    default:
      return <Icon.studio width={16} height={16} />;
  }
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
