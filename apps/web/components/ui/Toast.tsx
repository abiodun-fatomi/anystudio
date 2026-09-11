/**
 * Toasts. One live region for the whole app; a toast is a sentence, an
 * optional action, and a tone. Errors do not auto-dismiss — a message that
 * says what went wrong must still be there when the person looks up.
 */
'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './Toast.module.css';

export type ToastTone = 'neutral' | 'ok' | 'warn' | 'danger';
export interface ToastInput {
  title: ReactNode;
  body?: ReactNode;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

const Ctx = createContext<{ toast: (t: ToastInput) => void; dismiss: (id: number) => void } | null>(null);
let seq = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const region = useRef<HTMLDivElement>(null);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: ToastInput) => {
      const id = seq++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      const ms = t.durationMs ?? (t.tone === 'danger' ? 0 : 5000);
      if (ms > 0) setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  /**
   * Put the region in the TOP LAYER, once, for the life of the app.
   *
   * `Dialog` opens with `showModal()`, which promotes it to the browser's top
   * layer — above every z-index there is. A toast fired while a dialog is open
   * therefore appeared UNDER the modal's backdrop: dimmed, blurred, and in the
   * one case where it matters most, because the thing a dialog usually has to
   * tell you is why it just refused what you asked for. `--z-toast` could not
   * reach it and no amount of raising it ever would.
   *
   * A manual popover joins the same top layer, so toasts sit above modals
   * again. It is opened on mount and never closed: the region is an
   * `aria-live` area, and a live region that is removed and re-added when the
   * first toast arrives is a live region screen readers do not announce. Empty,
   * it is invisible and untouchable anyway.
   *
   * Where `showPopover` is missing the attribute is ignored and the region
   * behaves exactly as it did before — correct everywhere except over a modal.
   */
  useEffect(() => {
    const el = region.current;
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      el.showPopover();
    } catch {
      // Already open — React re-ran the effect, which is not a problem.
    }
  }, []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div ref={region} popover="manual" className={styles.region} aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <div key={t.id} className={styles.toast} data-tone={t.tone ?? 'neutral'} role={t.tone === 'danger' ? 'alert' : 'status'}>
            <div className={styles.text}>
              <div className={styles.title}>{t.title}</div>
              {t.body && <div className={styles.body}>{t.body}</div>}
            </div>
            {t.action && (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className={styles.x} aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
