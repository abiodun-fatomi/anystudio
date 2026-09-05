/**
 * Button. One component, every variant, every state.
 *
 * `href` renders a Next link with the same look, so a call to action that
 * navigates and one that submits are indistinguishable to the eye and to a
 * screen reader that reads the role. `loading` keeps the width (the label is
 * made transparent, not removed) so a form does not jump when it submits.
 */
import Link from 'next/link';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  full?: boolean;
  /** Renders as a link that looks like a button. */
  href?: string;
  /** Icon-only: square, and `aria-label` is required. */
  icon?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, full, href, icon, leading, trailing, className, children, disabled, type, ...rest },
  ref,
) {
  const cls = cx(styles.btn, styles[variant], size !== 'md' && styles[size], full && styles.full, icon && styles.icon, className);
  if (href) {
    return (
      <Link href={href} className={cls} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}>
        {leading}
        {children}
        {trailing}
      </Link>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cls}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {leading}
      {children}
      {trailing}
    </button>
  );
});
