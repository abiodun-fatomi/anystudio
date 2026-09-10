'use client';
/**
 * The month at a glance. Each day carries its posts as small chips —
 * platform, time, status colour — and a scheduled chip can be dragged to
 * another day to move it (the time of day is kept). Clicking a day lists
 * its posts in full underneath, with the same edit and cancel as the list
 * view, so this is a different window on the same rows, not a second
 * system.
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { api, type PublishJob, type SocialPlatform } from '@/lib/api';
import { Badge, Button, Skeleton, useToast } from '@/components/ui';
import { PLATFORM_WORDS } from '@/components/publishing/PublishDialog';
import styles from './calendar.module.css';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS_TONE: Record<PublishJob['status'], 'accent' | 'ok' | 'warn' | 'danger' | 'cyan' | undefined> = {
  SCHEDULED: 'accent',
  PUBLISHING: 'cyan',
  PUBLISHED: 'ok',
  FAILED: 'danger',
  CANCELLED: undefined,
};
const STATUS_WORDS: Record<PublishJob['status'], string> = {
  SCHEDULED: 'Scheduled',
  PUBLISHING: 'Posting…',
  PUBLISHED: 'Posted',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const PLATFORM_SHORT: Record<SocialPlatform, string> = { INSTAGRAM: 'IG', TIKTOK: 'TT' };

/** The 6-week grid that shows `month`, Monday-first, in local time. */
function gridFor(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(first);
  start.setDate(first.getDate() - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function Calendar({
  workspaceId,
  onEdit,
  onCancel,
  onRetry,
  refreshKey,
}: {
  workspaceId: string;
  onEdit: (job: PublishJob) => void;
  onCancel: (job: PublishJob) => void;
  onRetry: (job: PublishJob) => Promise<void>;
  refreshKey: number;
}) {
  const { toast } = useToast();
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [jobs, setJobs] = useState<PublishJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  const days = useMemo(() => gridFor(month), [month]);
  const weeks = useMemo(() => Array.from({ length: 6 }, (_, i) => days.slice(i * 7, i * 7 + 7)), [days]);
  const load = useCallback(async () => {
    const from = days[0]!;
    const to = new Date(days[41]!);
    to.setDate(to.getDate() + 1);
    try {
      const r = await api.publishing.window(workspaceId, from, to);
      setJobs(Array.isArray(r?.rows) ? r.rows : []);
      setFailed(false);
    } catch {
      setJobs((cur) => cur ?? []);
      setFailed(true);
    }
  }, [workspaceId, days]);
  useEffect(() => {
    setJobs(null);
    void load();
  }, [load, refreshKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, PublishJob[]>();
    for (const j of jobs ?? []) {
      const k = ymd(new Date(j.scheduledFor));
      map.set(k, [...(map.get(k) ?? []), j]);
    }
    return map;
  }, [jobs]);

  const today = ymd(new Date());
  const monthLabel = month.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const selectedJobs = byDay.get(selected) ?? [];
  const selectedDate = useMemo(() => {
    const [y, m, d] = selected.split('-').map(Number);
    return new Date(y!, m! - 1, d!);
  }, [selected]);

  /** Drop a scheduled post on another day: same time, new date. */
  const moveTo = async (jobId: string, day: Date) => {
    const job = jobs?.find((j) => j.id === jobId);
    if (!job || job.status !== 'SCHEDULED') return;
    const was = new Date(job.scheduledFor);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), was.getHours(), was.getMinutes());
    if (ymd(next) === ymd(was)) return;
    if (next.getTime() < Date.now()) {
      toast({ title: 'That day has passed', body: 'Drop it on today or later.', tone: 'warn' });
      return;
    }
    setMoving(jobId);
    setJobs((cur) => cur?.map((j) => (j.id === jobId ? { ...j, scheduledFor: next.toISOString() } : j)) ?? cur);
    try {
      await api.publishing.patch(workspaceId, jobId, { scheduledFor: next.toISOString() });
      toast({ title: `Moved to ${next.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`, tone: 'ok' });
    } catch (e) {
      toast({ title: 'Could not move it', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
      void load();
    } finally {
      setMoving(null);
    }
  };

  const onDragStart = (e: DragEvent, job: PublishJob) => {
    if (job.status !== 'SCHEDULED') {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', job.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(job.id);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <div className={styles.monthNav}>
          <Button variant="ghost" size="sm" onClick={() => shift(-1)} aria-label="Previous month">
            ←
          </Button>
          <h3 className={styles.month}>{monthLabel}</h3>
          <Button variant="ghost" size="sm" onClick={() => shift(1)} aria-label="Next month">
            →
          </Button>
        </div>
        <div className={styles.barRight}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const n = new Date();
              setMonth(new Date(n.getFullYear(), n.getMonth(), 1));
              setSelected(ymd(n));
            }}
          >
            Today
          </Button>
          <span className={styles.hint}>Drag a scheduled post to another day to move it.</span>
        </div>
      </div>

      {failed && (
        <div className={styles.failed} role="alert">
          The month could not be loaded.{' '}
          <Button size="sm" variant="link" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
      <div className={styles.grid} role="grid" aria-label={monthLabel}>
        <div role="row" className={styles.row}>
          {WEEKDAYS.map((w) => (
            <div key={w} className={styles.weekday} role="columnheader">
              {w}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} role="row" className={styles.row}>
            {week.map((d) => {
              const key = ymd(d);
              const list = byDay.get(key) ?? [];
              const outside = d.getMonth() !== month.getMonth();
              const past = key < today;
              return (
                <div
                  key={key}
                  role="gridcell"
                  tabIndex={0}
                  className={styles.cell}
                  data-outside={outside || undefined}
                  data-today={key === today || undefined}
                  data-selected={key === selected || undefined}
                  data-over={over === key || undefined}
                  data-past={past || undefined}
                  onClick={() => setSelected(key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(key);
                    }
                  }}
                  onDragOver={(e) => {
                    if (!dragging || past) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (over !== key) setOver(key);
                  }}
                  onDragLeave={() => {
                    if (over === key) setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData('text/plain') || dragging;
                    setOver(null);
                    setDragging(null);
                    if (id) void moveTo(id, d);
                  }}
                >
                  <span className={styles.srOnly}>
                    {d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
                    {list.length ? `, ${list.length} post${list.length === 1 ? '' : 's'}` : ''}
                  </span>
                  <div className={styles.dayNum} aria-hidden="true">
                    {d.getDate()}
                  </div>
                  {jobs === null ? (
                    <Skeleton height={16} />
                  ) : (
                    <div className={styles.chips}>
                      {list.slice(0, 3).map((j) => (
                        <div
                          key={j.id}
                          className={styles.chip}
                          data-status={j.status}
                          data-moving={moving === j.id || undefined}
                          draggable={j.status === 'SCHEDULED'}
                          onDragStart={(e) => onDragStart(e, j)}
                          onDragEnd={() => {
                            setDragging(null);
                            setOver(null);
                          }}
                          title={`${PLATFORM_WORDS[j.platform] ?? j.platform} · ${timeOf(j.scheduledFor)} · ${STATUS_WORDS[j.status]}${j.caption ? ` — ${j.caption.slice(0, 80)}` : ''}`}
                        >
                          <span className={styles.chipDot} />
                          <span className={styles.chipPlat}>{PLATFORM_SHORT[j.platform] ?? j.platform.slice(0, 2)}</span>
                          <span className={styles.chipTime}>{timeOf(j.scheduledFor)}</span>
                          <span className={styles.srOnly}>{STATUS_WORDS[j.status]}</span>
                        </div>
                      ))}
                      {list.length > 3 && <div className={styles.more}>+{list.length - 3} more</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className={styles.dayPanel}>
        <div className={styles.dayPanelHead}>
          <strong>{selectedDate.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
          <span className={styles.hint}>
            {selectedJobs.length === 0 ? 'Nothing scheduled.' : `${selectedJobs.length} post${selectedJobs.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {selectedJobs.length > 0 && (
          <ul className={styles.dayList}>
            {selectedJobs.map((j) => (
              <li key={j.id} className={styles.dayItem} data-status={j.status}>
                <div className={styles.dayThumb}>
                  {j.mediaUrl ? (
                    j.mediaMime?.startsWith('video/') ? (
                      <video src={j.mediaUrl} muted playsInline preload="metadata" />
                    ) : (
                      <img src={j.mediaUrl} alt="" />
                    )
                  ) : null}
                </div>
                <div className={styles.dayBody}>
                  <div className={styles.dayTop}>
                    <span className={styles.dayWhen}>{timeOf(j.scheduledFor)}</span>
                    <span>
                      {PLATFORM_WORDS[j.platform] ?? j.platform}
                      {j.account?.handle ? ` · @${j.account.handle}` : ''}
                    </span>
                    <Badge tone={STATUS_TONE[j.status]}>{STATUS_WORDS[j.status]}</Badge>
                  </div>
                  <div className={styles.dayCaption}>{j.caption || <em>No caption</em>}</div>
                  {j.failureReason && <div className={styles.dayFail}>{j.failureReason}</div>}
                </div>
                <div className={styles.dayActions}>
                  {j.status === 'SCHEDULED' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => onEdit(j)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onCancel(j)}>
                        Cancel
                      </Button>
                    </>
                  )}
                  {j.status === 'FAILED' && (
                    <Button size="sm" variant="ghost" onClick={() => void onRetry(j)}>
                      Try again
                    </Button>
                  )}
                  {j.externalUrl && (
                    <a className={styles.viewLink} href={j.externalUrl} target="_blank" rel="noreferrer">
                      View ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
