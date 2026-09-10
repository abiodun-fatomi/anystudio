/**
 * Form controls. Every one is labelled, hinted and errored the same way, and
 * the error is wired to the control with aria-describedby so a screen reader
 * says it when focus lands — not somewhere else, later.
 */
'use client';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Field.module.css';

interface FieldChrome {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
}

function Chrome({ id, label, hint, error, optional, className, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className={cx(styles.field, className)}>
      {label && (
        <label className={styles.label} htmlFor={id}>
          <span>{label}</span>
          {optional && <span className={styles.optional}>Optional</span>}
        </label>
      )}
      {children}
      {error ? (
        <div id={`${id}-err`} className={styles.error} role="alert">
          {error}
        </div>
      ) : hint ? (
        <div id={`${id}-hint`} className={styles.hint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

const describedBy = (id: string, error?: ReactNode, hint?: ReactNode) => (error ? `${id}-err` : hint ? `${id}-hint` : undefined);

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, FieldChrome {
  leading?: ReactNode;
  trailing?: ReactNode;
  /** The trailing slot holds a control (a button), not decoration: it stays clickable and visible to assistive tech. */
  trailingInteractive?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, optional, className, leading, trailing, trailingInteractive, id: given, ...rest },
  ref,
) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <Chrome id={id} label={label} hint={hint} error={error} optional={optional} className={className}>
      <div className={styles.control}>
        {leading && (
          <span className={styles.leading} aria-hidden="true">
            {leading}
          </span>
        )}
        <input
          ref={ref}
          id={id}
          className={cx(styles.input, leading ? styles.withLeading : null, trailing ? styles.withTrailing : null)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, hint)}
          {...rest}
        />
        {trailing && (
          <span
            className={styles.trailing}
            aria-hidden={trailingInteractive ? undefined : 'true'}
            style={trailingInteractive ? { pointerEvents: 'auto' } : undefined}
          >
            {trailing}
          </span>
        )}
      </div>
    </Chrome>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldChrome {
  /** Shows "n / max" and turns red past it. */
  showCount?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, optional, className, showCount, id: given, maxLength, value, ...rest },
  ref,
) {
  const auto = useId();
  const id = given ?? auto;
  const len = typeof value === 'string' ? value.length : 0;
  return (
    <Chrome id={id} label={label} hint={hint} error={error} optional={optional} className={className}>
      <textarea
        ref={ref}
        id={id}
        className={cx(styles.input, styles.textarea)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        maxLength={maxLength}
        value={value}
        {...rest}
      />
      {showCount && maxLength && (
        <div className={styles.count} data-over={len > maxLength || undefined} aria-live="polite">
          {len} / {maxLength}
        </div>
      )}
    </Chrome>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldChrome {
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, optional, className, options, placeholder, id: given, ...rest },
  ref,
) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <Chrome id={id} label={label} hint={hint} error={error} optional={optional} className={className}>
      <select
        ref={ref}
        id={id}
        className={cx(styles.input, styles.select)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Chrome>
  );
});
