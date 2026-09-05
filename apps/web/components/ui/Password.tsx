'use client';
/**
 * A password field: an eye to reveal what was typed, and no copy, cut or
 * paste — a password is typed, not pasted from somewhere it should not have
 * been. The eye is a real button (keyboard, screen reader: "Show password",
 * pressed or not); it never steals focus from the field.
 *
 * `PasswordControl` is the bare control for forms that own their own label
 * markup (the auth pages); `PasswordInput` wraps it in the standard Field
 * chrome for everything else.
 */
import { forwardRef, useState, type ClipboardEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Input, type InputProps } from './Field';
import styles from './Password.module.css';

const block = (e: ClipboardEvent<HTMLInputElement>) => { e.preventDefault(); };

export const PasswordControl = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function PasswordControl({ className, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <div className={styles.wrap}>
      <input ref={ref} {...rest} type={shown ? 'text' : 'password'} className={cx(className, styles.input)} onCopy={block} onCut={block} onPaste={block} spellCheck={false} autoCapitalize="off" />
      <Eye shown={shown} onToggle={() => setShown((s) => !s)} />
    </div>
  );
});

export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'trailing'>>(function PasswordInput({ className, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <Input ref={ref} {...rest} className={className} type={shown ? 'text' : 'password'} onCopy={block} onCut={block} onPaste={block} spellCheck={false} autoCapitalize="off"
      trailingInteractive trailing={<Eye shown={shown} onToggle={() => setShown((s) => !s)} />} />
  );
});

function Eye({ shown, onToggle }: { shown: boolean; onToggle: () => void }): ReactNode {
  return (
    <button type="button" className={styles.eye} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} title={shown ? 'Hide password' : 'Show password'}
      onMouseDown={(e) => e.preventDefault()} onClick={onToggle}>
      {shown ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.4 10.4 0 0 1 12 5c5 0 8.5 4 9.5 7-.4 1.1-1.1 2.3-2 3.3M6.6 6.6C4.6 8 3.3 10 2.5 12c1 3 4.5 7 9.5 7 1.7 0 3.2-.4 4.5-1.1" /></svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 12c1-3 4.5-7 9.5-7s8.5 4 9.5 7c-1 3-4.5 7-9.5 7s-8.5-4-9.5-7Z" /><circle cx="12" cy="12" r="3" /></svg>
      )}
    </button>
  );
}
