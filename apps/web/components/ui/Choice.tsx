/** Checkbox, Radio, Switch, Slider — the real input stays in the tree, hidden, so keyboard and forms just work. */
'use client';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Choice.module.css';

interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  hint?: ReactNode;
}

const Check = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--accent-ink)"
    strokeWidth="3.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m5 12 5 5L20 7" />
  </svg>
);
const Dot = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <circle cx="5" cy="5" r="5" fill="var(--accent-ink)" />
  </svg>
);

function Base(
  { kind, label, hint, className, disabled, id: given, ...rest }: ChoiceProps & { kind: 'checkbox' | 'radio' | 'switch' },
  ref: React.Ref<HTMLInputElement>,
) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <label className={cx(styles.row, className)} htmlFor={id} data-disabled={disabled || undefined}>
      <input
        ref={ref}
        id={id}
        type={kind === 'switch' ? 'checkbox' : kind}
        role={kind === 'switch' ? 'switch' : undefined}
        className={styles.input}
        disabled={disabled}
        {...rest}
      />
      {kind === 'switch' ? (
        <span className={styles.switch} aria-hidden="true" />
      ) : (
        <span className={cx(styles.box, kind === 'radio' && styles.round)} aria-hidden="true">
          {kind === 'radio' ? <Dot /> : <Check />}
        </span>
      )}
      <span className={styles.text}>
        <span>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
    </label>
  );
}

export const Checkbox = forwardRef<HTMLInputElement, ChoiceProps>(function Checkbox(p, ref) {
  return Base({ ...p, kind: 'checkbox' }, ref);
});
export const Radio = forwardRef<HTMLInputElement, ChoiceProps>(function Radio(p, ref) {
  return Base({ ...p, kind: 'radio' }, ref);
});
export const Switch = forwardRef<HTMLInputElement, ChoiceProps>(function Switch(p, ref) {
  return Base({ ...p, kind: 'switch' }, ref);
});

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  ticks?: string[];
}

export function Slider({ label, value, min, max, step = 1, onChange, format = String, ticks, className, id: given, ...rest }: SliderProps) {
  const auto = useId();
  const id = given ?? auto;
  const pct = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className={cx(styles.slider, className)}>
      <div className={styles.sliderHead}>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className={styles.sliderVal}>
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className={styles.range}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--pct' as string]: pct }}
        aria-valuetext={format(value)}
        {...rest}
      />
      {ticks && (
        <div className={styles.ticks} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}
