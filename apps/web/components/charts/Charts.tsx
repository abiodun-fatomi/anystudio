'use client';
/**
 * The three chart forms Insights needs, drawn as SVG from the tokens.
 *
 *   DailyBars  — change over time, one or two series, hover tooltip, table view
 *   Breakdown  — magnitude by category, horizontal bars with direct labels
 *   Hero       — a single headline number with its context line
 *
 * Rules these follow (and the reasons a screen would break them): one axis
 * per chart; series colours in a fixed order from --chart-1…4, never cycled;
 * text in ink tokens, never the series colour; thin marks with a 2px gap;
 * a legend only when there are two or more series; every chart has a table
 * behind a toggle so nothing is colour-only.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './Charts.module.css';

export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

export function Hero({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className={styles.hero} data-tone={tone}>
      <span className={styles.heroLabel}>{label}</span>
      <strong className={styles.heroValue}>{value}</strong>
      {sub && <span className={styles.heroSub}>{sub}</span>}
    </div>
  );
}

export interface DailyPoint {
  date: string;
  values: number[];
}

/**
 * Bars per day. With two series the bars are grouped, not stacked, so each
 * day's failures are read against the same baseline as its successes.
 */
export function DailyBars({
  title,
  points,
  series,
  unit = '',
  height = 180,
}: {
  title: ReactNode;
  points: DailyPoint[];
  series: string[];
  unit?: string;
  height?: number;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  // The viewBox tracks the real width so text stays 11px whatever the container is.
  const plotRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 100) setW(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);
  const H = height;
  const padL = 34;
  const padB = 22;
  const padT = 8;
  const max = Math.max(1, ...points.flatMap((p) => p.values));
  const step = (W - padL) / Math.max(1, points.length);
  const barW = Math.max(2, (step - 2) / series.length - (series.length > 1 ? 1 : 0));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = useMemo(() => niceTicks(max), [max]);
  const labelEvery = points.length > 45 ? 14 : points.length > 14 ? 7 : W < 480 && points.length > 7 ? 2 : 1;
  const total = series.map((_, si) => points.reduce((s, p) => s + (p.values[si] ?? 0), 0));

  return (
    <figure className={styles.fig} aria-labelledby={`${id}-t`}>
      <figcaption className={styles.figHead}>
        <span id={`${id}-t`} className={styles.figTitle}>
          {title}
        </span>
        <span className={styles.figEnd}>
          {series.length > 1 && (
            <span className={styles.legend} aria-label="Series">
              {series.map((s, i) => (
                <span key={s} className={styles.legendItem}>
                  <i style={{ background: SERIES[i] }} aria-hidden="true" />
                  {s} <b>{total[i]?.toLocaleString()}</b>
                </span>
              ))}
            </span>
          )}
          <button type="button" className={styles.toggle} aria-pressed={table} onClick={() => setTable((t) => !t)}>
            {table ? 'Chart' : 'Table'}
          </button>
        </span>
      </figcaption>
      {table ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Day</th>
                {series.map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date}>
                  <td>{p.date}</td>
                  {p.values.map((v, i) => (
                    <td key={i}>
                      {v.toLocaleString()}
                      {unit}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.plot} ref={plotRef} onMouseLeave={() => setHover(null)}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            className={styles.svg}
            role="img"
            aria-label={`${typeof title === 'string' ? title : 'Chart'}: ${points.length} days`}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className={styles.grid} />
                <text x={padL - 6} y={y(t) + 3.5} className={styles.axisText} textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {/* Bars extend below the baseline and are clipped there, so only the data end is rounded. */}
            <defs>
              <clipPath id={`${id}-clip`}>
                <rect x={padL} y={padT} width={W - padL} height={y(0) - padT} />
              </clipPath>
            </defs>
            <g clipPath={`url(#${id}-clip)`}>
              {points.map((p, i) => {
                const x0 = padL + i * step + 1;
                return p.values.map((v, si) => {
                  const h = Math.max(0, y(0) - y(v));
                  if (h === 0) return null;
                  const r = Math.min(4, barW / 2);
                  return (
                    <rect
                      key={`${p.date}-${si}`}
                      x={x0 + si * (barW + 1)}
                      y={y(v)}
                      width={barW}
                      height={h + r + 2}
                      rx={r}
                      fill={SERIES[si]}
                      opacity={hover === null || hover === i ? 1 : 0.45}
                      className={styles.bar}
                    />
                  );
                });
              })}
            </g>
            {points.map((p, i) => {
              const x0 = padL + i * step + 1;
              return (
                <g key={p.date}>
                  {i % labelEvery === 0 && (
                    <text x={x0 + (step - 2) / 2} y={H - 6} className={styles.axisText} textAnchor="middle">
                      {shortDate(p.date)}
                    </text>
                  )}
                  <rect x={x0 - 1} y={padT} width={step} height={H - padT - padB} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
            <line x1={padL} x2={W} y1={y(0)} y2={y(0)} className={styles.baseline} />
          </svg>
          {hover !== null && points[hover] && (
            <div className={styles.tip} style={{ left: `${((padL + hover * step + step / 2) / W) * 100}%` }} role="status">
              <strong>{longDate(points[hover]!.date)}</strong>
              {series.map((s, si) => (
                <span key={s}>
                  <i style={{ background: SERIES[si] }} aria-hidden="true" />
                  {s}:{' '}
                  <b>
                    {(points[hover]!.values[si] ?? 0).toLocaleString()}
                    {unit}
                  </b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** Magnitude by category: one hue, longest first, the number written beside each bar. */
export function Breakdown({
  title,
  rows,
  unit = '',
  color = SERIES[0],
}: {
  title: ReactNode;
  rows: Array<{ label: string; value: number; sub?: string }>;
  unit?: string;
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className={styles.fig}>
      <figcaption className={styles.figHead}>
        <span className={styles.figTitle}>{title}</span>
      </figcaption>
      {rows.length === 0 ? (
        <p className={styles.empty}>Nothing in this period.</p>
      ) : (
        <ul className={styles.bars}>
          {rows.map((r) => (
            <li key={r.label} className={styles.barRow}>
              <span className={styles.barLabel}>
                {r.label}
                {r.sub && <small>{r.sub}</small>}
              </span>
              <span className={styles.barTrack}>
                <span className={styles.barFill} style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, background: color }} />
              </span>
              <span className={styles.barValue}>
                {r.value.toLocaleString()}
                {unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function niceTicks(max: number): number[] {
  const raw = max / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const stepN = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += stepN) out.push(Math.round(v * 100) / 100);
  return out.length > 1 ? out : [0, max];
}
function compact(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}
function shortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function longDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
