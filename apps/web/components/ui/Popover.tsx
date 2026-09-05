/** Popover, Menu and Tooltip. Click-outside and Escape close; arrow keys walk a menu; the trigger gets aria-expanded. */
'use client';
import Link from 'next/link';
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '@/lib/cx';
import styles from './Popover.module.css';

export interface PopoverProps {
  trigger: ReactElement<{ onClick?: () => void; 'aria-expanded'?: boolean; 'aria-controls'?: string; 'aria-haspopup'?: string }>;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  menu?: boolean;
  className?: string;
}

export function Popover({ trigger, children, align = 'start', side = 'bottom', menu, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => setOpen(false);

  // The panel hangs off its trigger. On a phone a trigger near either edge
  // would push the panel off screen — the bell at the top right did — so
  // once it is drawn it is nudged back inside the viewport, with a margin.
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const fit = () => {
      const el = panel.current;
      if (!el) return;
      el.style.translate = '';
      const r = el.getBoundingClientRect();
      const margin = 12;
      let dx = 0;
      if (r.left < margin) dx = margin - r.left;
      else if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
      setShift(Math.round(dx));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        (wrap.current?.firstElementChild as HTMLElement | null)?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    if (menu) wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, menu]);

  const onMenuKey = (e: KeyboardEvent) => {
    if (!menu) return;
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
    if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    }
    if (e.key === 'End') {
      e.preventDefault();
      items.at(-1)?.focus();
    }
  };

  // The trigger's own onClick still runs (a bell that loads on open), then the toggle.
  const t = isValidElement(trigger)
    ? cloneElement(trigger, {
        onClick: () => {
          trigger.props.onClick?.();
          setOpen((o) => !o);
        },
        'aria-expanded': open,
        'aria-controls': id,
        'aria-haspopup': menu ? 'menu' : 'dialog',
      })
    : trigger;

  return (
    <div ref={wrap} className={cx(styles.wrap, className)}>
      {t}
      {open && (
        <div
          id={id}
          ref={panel}
          role={menu ? 'menu' : 'dialog'}
          className={styles.panel}
          data-align={align}
          data-side={side}
          style={shift ? { translate: `${shift}px 0` } : undefined}
          onKeyDown={onMenuKey}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  href,
  danger,
  disabled,
  leading,
}: {
  children: ReactNode;
  onSelect?: () => void;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
}) {
  if (href)
    return (
      <Link role="menuitem" href={href} className={styles.menuItem} data-danger={danger || undefined} onClick={onSelect}>
        {leading}
        {children}
      </Link>
    );
  return (
    <button type="button" role="menuitem" className={styles.menuItem} data-danger={danger || undefined} disabled={disabled} onClick={onSelect}>
      {leading}
      {children}
    </button>
  );
}
export const MenuSeparator = () => <div role="separator" className={styles.sep} />;
export const MenuHeading = ({ children }: { children: ReactNode }) => (
  <div className={styles.menuHead} role="presentation">
    {children}
  </div>
);

/** Tooltip: hover and focus, described-by so it is read; never the only place a label lives. */
export function Tooltip({ label, children }: { label: string; children: ReactElement<{ 'aria-describedby'?: string }> }) {
  const id = useId();
  return (
    <span className={styles.tipWrap}>
      {isValidElement(children) ? cloneElement(children, { 'aria-describedby': id }) : children}
      <span role="tooltip" id={id} className={styles.tip}>
        {label}
      </span>
    </span>
  );
}
