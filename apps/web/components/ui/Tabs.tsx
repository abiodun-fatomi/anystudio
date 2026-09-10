/** Tabs and SegmentedControl: roving tabindex, arrow keys, Home/End, and the WAI-ARIA roles that make them announce correctly. */
'use client';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

function roving(e: KeyboardEvent, items: Array<{ id: string; disabled?: boolean }>, current: string, select: (id: string) => void) {
  const enabled = items.filter((i) => !i.disabled);
  const idx = enabled.findIndex((i) => i.id === current);
  const go = (n: number) => {
    const next = enabled[(n + enabled.length) % enabled.length];
    if (next) select(next.id);
  };
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault();
      go(idx + 1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      go(idx - 1);
      break;
    case 'Home':
      e.preventDefault();
      go(0);
      break;
    case 'End':
      e.preventDefault();
      go(enabled.length - 1);
      break;
  }
}

export function Tabs({
  items,
  value,
  onChange,
  children,
  className,
  label,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  children?: ReactNode;
  className?: string;
  label: string;
}) {
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const select = (id: string) => {
    onChange(id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
  };
  return (
    <div className={className}>
      <div ref={listRef} role="tablist" aria-label={label} className={styles.list} onKeyDown={(e) => roving(e, items, value, select)}>
        {items.map((t) => (
          <button
            key={t.id}
            role="tab"
            data-id={t.id}
            id={`${base}-tab-${t.id}`}
            aria-selected={t.id === value}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={t.id === value ? 0 : -1}
            disabled={t.disabled}
            className={styles.tab}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {children !== undefined && (
        <div role="tabpanel" id={`${base}-panel-${value}`} aria-labelledby={`${base}-tab-${value}`} className={styles.panel} tabIndex={0}>
          {children}
        </div>
      )}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: Array<{ id: T; label: ReactNode; disabled?: boolean }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const select = (id: string) => {
    onChange(id as T);
    ref.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={cx(styles.seg, className)} onKeyDown={(e) => roving(e, items, value, select)}>
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          role="radio"
          data-id={i.id}
          aria-checked={i.id === value}
          tabIndex={i.id === value ? 0 : -1}
          disabled={i.disabled}
          className={styles.segItem}
          onClick={() => onChange(i.id)}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}
