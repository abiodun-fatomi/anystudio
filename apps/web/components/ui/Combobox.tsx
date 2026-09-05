/** Combobox: a text input that filters a list; arrows move, Enter picks, Escape closes. ARIA 1.2 pattern. */
'use client';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Input, type InputProps } from './Field';
import styles from './Combobox.module.css';

export interface ComboOption {
  value: string;
  label: string;
  sub?: string;
  keywords?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  allowCustom,
  emptyText = 'No matches',
  ...input
}: Omit<InputProps, 'value' | 'onChange'> & {
  options: ComboOption[];
  value: string;
  onChange: (v: string) => void;
  allowCustom?: boolean;
  emptyText?: ReactNode;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.sub ?? ''} ${o.keywords ?? ''}`.toLowerCase().includes(q)).slice(0, 50) : options.slice(0, 50);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (o: ComboOption) => {
    onChange(o.value);
    setQuery('');
    setOpen(false);
  };

  return (
    <div ref={wrap} className={styles.wrap}>
      <Input
        {...input}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${id}-${active}` : undefined}
        value={open ? query : (selected?.label ?? (allowCustom ? value : ''))}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          if (allowCustom) onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            const o = shown[active];
            if (o) pick(o);
            else if (allowCustom) setOpen(false);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        autoComplete="off"
      />
      {open && (
        <ul id={`${id}-list`} role="listbox" className={styles.list}>
          {shown.length === 0 && <li className={styles.none}>{emptyText}</li>}
          {shown.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active || undefined}
              className={styles.opt}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              <span>{o.label}</span>
              {o.sub && <span className={styles.optSub}>{o.sub}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
