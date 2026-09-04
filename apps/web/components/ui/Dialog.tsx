/**
 * Dialog and Sheet on the native <dialog>: the browser gives us the focus
 * trap, Escape, the top layer and inert-behind for free, and gets them
 * right in ways a div-and-portal never quite does. We add: scroll lock,
 * focus return to the opener, a labelled title, and a mobile treatment
 * where every dialog becomes a bottom sheet because a centred modal on a
 * 360px screen is a modal you cannot reach the buttons of.
 */
'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Button } from './Button';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Sheet: docked right (desktop) or bottom. */
  sheet?: 'right' | 'bottom';
  /** Block closing by Escape/backdrop while something irreversible is in flight. */
  locked?: boolean;
}

export function Dialog({ open, onClose, title, description, children, footer, wide, sheet, locked }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement;
      el.showModal();
      document.documentElement.style.overflow = 'hidden';
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => { e.preventDefault(); if (!locked) onClose(); };
    const onClosed = () => {
      document.documentElement.style.overflow = '';
      (opener.current as HTMLElement | null)?.focus?.();
    };
    el.addEventListener('cancel', onCancel);
    el.addEventListener('close', onClosed);
    return () => { el.removeEventListener('cancel', onCancel); el.removeEventListener('close', onClosed); };
  }, [onClose, locked]);

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, wide && styles.wide, sheet && styles.sheet, sheet === 'bottom' && styles.bottom)}
      aria-labelledby={`${id}-t`}
      aria-describedby={description ? `${id}-d` : undefined}
      onClick={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}
    >
      <div className={styles.head}>
        <div>
          <h2 id={`${id}-t`} className={styles.title}>{title}</h2>
          {description && <p id={`${id}-d`} className={styles.desc}>{description}</p>}
        </div>
        <Button variant="ghost" size="sm" icon aria-label="Close" className={styles.close} onClick={onClose} disabled={locked}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </Button>
      </div>
      <div className={styles.body}>{children}</div>
      {footer && <div className={styles.foot}>{footer}</div>}
    </dialog>
  );
}

/** Confirm: the destructive action is never the default and never the first tab stop. */
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', danger, busy }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; description?: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} locked={busy}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>{confirmLabel}</Button></>} />
  );
}
