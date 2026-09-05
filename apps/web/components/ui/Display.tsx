/** The non-interactive vocabulary: badges, avatars, cards, skeletons, progress, empty states, tables, pagination, breadcrumbs, stats. */
import Link from 'next/link';
import type { HTMLAttributes, ReactNode, TableHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Display.module.css';

export function Badge({ tone, dot, mono, children, className }: { tone?: 'accent' | 'ok' | 'warn' | 'danger' | 'cyan'; dot?: boolean; mono?: boolean; children: ReactNode; className?: string }) {
  return <span className={cx(styles.badge, mono && styles.mono, className)} data-tone={tone}>{dot && <span className={styles.dot} aria-hidden="true" />}{children}</span>;
}

export function Avatar({ name, src, size, square, className }: { name: string; src?: string | null; size?: 'sm' | 'lg'; square?: boolean; className?: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return (
    <span className={cx(styles.avatar, size && styles[size], square && styles.square, className)} role="img" aria-label={name}>
      {src ? <img src={src} alt="" /> : initials}
    </span>
  );
}

export function Card({ pad = true, interactive, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { pad?: boolean; interactive?: boolean }) {
  return <div className={cx(styles.card, pad && styles.pad, interactive && styles.interactive, className)} tabIndex={interactive ? 0 : undefined} {...rest}>{children}</div>;
}
export function CardHeader({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return <div className={styles.cardHead}><div><div className={styles.cardTitle}>{title}</div>{sub && <div className={styles.cardSub}>{sub}</div>}</div>{action}</div>;
}

export function Skeleton({ width, height, round, text, className, style }: { width?: number | string; height?: number | string; round?: boolean; text?: boolean; className?: string; style?: React.CSSProperties }) {
  return <span className={cx(styles.skel, round && styles.round, text && styles.text, className)} style={{ width, height, ...style }} aria-hidden="true" />;
}

export function Progress({ value, label, detail, className }: { value: number | null; label?: ReactNode; detail?: ReactNode; className?: string }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div className={cx(styles.prog, className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label={typeof label === 'string' ? label : undefined}>
      {(label || detail) && <div className={styles.progHead}><span>{label}</span><span className={styles.progVal}>{detail ?? (pct !== null ? `${Math.round(pct)}%` : '')}</span></div>}
      <div className={styles.track}><div className={styles.fill} style={{ width: pct === null ? undefined : `${pct}%` }} data-indeterminate={pct === null || undefined} /></div>
    </div>
  );
}

export function EmptyState({ icon, title, body, actions, className }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx(styles.empty, className)}>
      {icon && <div className={styles.emptyIcon} aria-hidden="true">{icon}</div>}
      <div className={styles.emptyTitle}>{title}</div>
      {body && <div className={styles.emptyBody}>{body}</div>}
      {actions && <div className={styles.emptyActions}>{actions}</div>}
    </div>
  );
}

export function Table({ className, children, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <div className={styles.tableWrap}><table className={cx(styles.table, className)} {...rest}>{children}</table></div>;
}
export const tableCell = { num: styles.num, shrink: styles.shrink };

export function Pagination({ children, className }: { children: ReactNode; className?: string }) {
  return <nav className={cx(styles.pager, className)} aria-label="Pagination">{children}</nav>;
}

export function Breadcrumbs({ items }: { items: Array<{ label: ReactNode; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className={styles.crumbs}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span className={styles.crumbSep} aria-hidden="true">/</span>}
          {it.href && i < items.length - 1 ? <Link href={it.href}>{it.label}</Link> : <span aria-current={i === items.length - 1 ? 'page' : undefined}>{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return <div className={cx(styles.stat, className)}><div className={styles.statK}>{label}</div><div className={styles.statV}>{value}</div>{sub && <div className={styles.statS}>{sub}</div>}</div>;
}

/**
 * A screen that could not load says so and offers the one useful action.
 * A page that stays on its skeleton after a failed request looks blank, and
 * blank is the worst thing a page can be — nothing to read, nothing to do.
 */
export function LoadError({ what = 'this', message, onRetry }: { what?: string; message?: string | null; onRetry?: () => void }) {
  return (
    <div className={styles.empty} role="alert">
      <div className={styles.emptyTitle}>Could not load {what}</div>
      <div className={styles.emptyBody}>{message ?? 'The server did not answer as expected.'} If this keeps happening, the service may be mid-deploy — try again in a minute.</div>
      {onRetry && <div className={styles.emptyActions}><button type="button" className={styles.retry} onClick={onRetry}>Try again</button></div>}
    </div>
  );
}
