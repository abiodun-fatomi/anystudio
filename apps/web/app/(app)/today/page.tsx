'use client';
/**
 * Today — the first screen after sign-in, and the one a seller checks
 * between customers.
 *
 * It answers four questions in the order they are asked: what did I make
 * this week, how did what I posted do, what should I do next, and how much
 * is left in the account. The numbers are the API's — computed from the
 * generation rows, the ledger and the platforms' own counts — so nothing
 * here is estimated in the browser.
 *
 * "How did it do" is honest about what it does not know: until an account
 * is connected the section says so and offers the one button that fixes
 * it, rather than showing zeros that look like failure.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/app-context';
import { api, type Insights, type LedgerRow, type PostView } from '@/lib/api';
import { Button, LoadError, SegmentedControl, Skeleton } from '@/components/ui';
import { DailyBars, Hero } from '@/components/charts/Charts';
import { Icon } from '@/components/shell/icons';
import styles from './today.module.css';

const RANGES = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
] as const;
type Range = (typeof RANGES)[number]['id'];

const PLATFORM_WORDS: Record<string, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok' };
const FORMAT_WORDS: Record<string, string> = { IMAGE: 'Feed post', REEL: 'Reel', STORY: 'Story', VIDEO: 'Video' };

/** 1,284 · 12.9K · 1.2M — a big number the eye can take in at a glance. */
function compact(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}K`;
  return `${Math.round(n / 100_000) / 10}M`;
}

function delta(now: number, before: number): string | null {
  if (before === 0) return now > 0 ? 'first this period' : null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return 'same as the period before';
  return `${pct > 0 ? '+' : ''}${pct}% vs the period before`;
}

export default function TodayPage() {
  const { me, workspace: ws, setBalance } = useApp();
  const [days, setDays] = useState<Range>('7');
  const [data, setData] = useState<Insights | null>(null);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const seq = ++request.current;
    setError(null);
    try {
      const [insights, history] = await Promise.all([api.insights.overview(ws.id, Number(days)), api.wallet.history(ws.id).catch(() => ({ rows: [] }))]);
      if (seq !== request.current) return;
      setData(insights);
      setBalance(insights.balance.credits);
      setRows(history.rows.slice(0, 5));
      setError(null);
    } catch (e) {
      if (seq !== request.current) return;
      setError(e instanceof Error ? e.message : 'Could not load your studio just now.');
    }
  }, [ws.id, days, setBalance]);
  useEffect(() => {
    setData(null);
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  const first = me.user.name?.split(' ')[0];

  return (
    <div>
      <header className={styles.head}>
        <div>
          <h1>{first ? `Good to see you, ${first}.` : 'Today'}</h1>
          <p>{ws?.name ?? 'Your studio'}</p>
        </div>
        <div className={styles.headEnd}>
          <SegmentedControl label="Period" value={days} onChange={(v) => setDays(v as Range)} items={RANGES.map((r) => ({ id: r.id, label: r.label }))} />
          <Link href="/billing" className="mono">
            Credits &amp; billing →
          </Link>
        </div>
      </header>

      {error && !data && <LoadError what="your studio" message={error} onRetry={() => void load()} />}
      {!data && !error && <Skeleton style={{ height: 128 }} />}

      {data && (
        <>
          <div className={styles.heroes}>
            <Hero
              label={days === '7' ? 'Made this week' : 'Made this month'}
              value={compact(data.totals.made)}
              sub={delta(data.totals.made, data.totals.previous.made) ?? 'Photos, videos, copy and audio that finished.'}
            />
            <Hero
              label="Posted"
              value={compact(data.posts.published)}
              sub={
                data.posts.accountsConnected === 0
                  ? 'No account connected yet.'
                  : data.posts.scheduled > 0
                    ? `${data.posts.scheduled} waiting to go out.`
                    : 'Straight from the studio.'
              }
            />
            <Hero
              label="Credits spent"
              value={compact(data.totals.credits)}
              sub={
                data.totals.refunded > 0
                  ? `${compact(data.totals.refunded)} refunded — a failure never costs you.`
                  : (delta(data.totals.credits, data.totals.previous.credits) ?? 'Nothing spent yet.')
              }
            />
            <Hero
              label="Credits left"
              value={compact(data.balance.credits)}
              tone={data.balance.runwayDays !== null && data.balance.runwayDays < 7 ? 'warn' : undefined}
              sub={data.balance.runwayDays !== null ? `About ${data.balance.runwayDays} days at your recent pace.` : 'Top up any time.'}
            />
          </div>

          {data.nextSteps.length > 0 && (
            <section className={styles.section}>
              <h2>What to do next</h2>
              <div className={styles.steps}>
                {data.nextSteps.map((s) => (
                  <div key={s.key} className={styles.step}>
                    <div>
                      <strong>{s.title}</strong>
                      <p>{s.body}</p>
                    </div>
                    <Button href={s.href} variant="subtle" size="sm">
                      {s.cta}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className={styles.section}>
            <DailyBars
              title={`What you made · last ${data.range.days} days`}
              points={data.series.map((p) => ({ date: p.date, values: [p.made] }))}
              series={['Finished']}
              height={160}
            />
          </section>

          <section className={styles.section}>
            <h2>How your posts did {data.posts.accountsConnected > 0 && <Link href="/publishing">All posts</Link>}</h2>
            {data.posts.accountsConnected === 0 ? (
              <div className={styles.connect}>
                <div>
                  <strong>Connect Instagram or TikTok</strong>
                  <p>Post from the studio in one tap, and see views, likes and comments for every post here.</p>
                </div>
                <Button href="/publishing">Connect an account</Button>
              </div>
            ) : data.posts.published === 0 ? (
              <p className={styles.empty}>Nothing posted in this period. Anything in your library can go out in two taps.</p>
            ) : (
              <>
                <div className={styles.metrics}>
                  <Metric label="Views" value={data.posts.totals.views} />
                  <Metric label="Reach" value={data.posts.totals.reach} />
                  <Metric label="Likes" value={data.posts.totals.likes} />
                  <Metric label="Comments" value={data.posts.totals.comments} />
                  <Metric label="Shares" value={data.posts.totals.shares} />
                  <Metric label="Saves" value={data.posts.totals.saved} />
                </div>
                {data.posts.measured < data.posts.published && (
                  <p className={styles.fine}>
                    {data.posts.published - data.posts.measured} of {data.posts.published} posts have no numbers yet — they arrive within the hour of posting.
                  </p>
                )}
                <ul className={styles.posts}>
                  {data.posts.recent.map((p) => (
                    <PostRow key={p.id} post={p} best={data.posts.best?.id === p.id} />
                  ))}
                </ul>
              </>
            )}
          </section>

          {data.topProducts.length > 0 && (
            <section className={styles.section}>
              <h2>
                Most worked on <Link href="/library">Library</Link>
              </h2>
              <ul className={styles.products}>
                {data.topProducts.slice(0, 5).map((p) => (
                  <li key={p.productKey}>
                    <span>{p.title ?? p.productKey}</span>
                    <span className={styles.fine}>
                      {p.count} {p.count === 1 ? 'piece' : 'pieces'} · {p.credits.toLocaleString()} credits
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {rows && rows.length > 0 && (
            <section className={styles.section}>
              <h2>
                Recent credit activity <Link href="/billing">Full statement</Link>
              </h2>
              <ul className={styles.ledger}>
                {rows.map((r) => (
                  <li key={r.id}>
                    <span>{r.reason ?? r.kind}</span>
                    <span className={r.delta > 0 ? styles.pos : styles.neg}>{r.delta > 0 ? `+${r.delta.toLocaleString()}` : r.delta.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** One number from a platform. A metric the platform does not report shows a dash, never a zero. */
function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong>{value === null ? '—' : compact(value)}</strong>
    </div>
  );
}

function PostRow({ post, best }: { post: PostView; best: boolean }) {
  const m = post.metrics;
  const when = post.publishedAt ?? post.scheduledFor;
  return (
    <li className={styles.post} data-best={best || undefined}>
      <div className={styles.postMain}>
        <div className={styles.postHead}>
          <span className={styles.postWhere}>
            {PLATFORM_WORDS[post.platform] ?? post.platform} · {FORMAT_WORDS[post.format] ?? post.format}
            {post.handle ? ` · @${post.handle}` : ''}
          </span>
          {best && <span className={styles.badge}>Best this period</span>}
          {post.status === 'SCHEDULED' && <span className={styles.badgeSoft}>Scheduled</span>}
          {post.status === 'FAILED' && <span className={styles.badgeBad}>Did not go out</span>}
        </div>
        <p className={styles.postCaption}>{post.caption || '—'}</p>
        <span className={styles.fine}>
          {new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
          {m && (m.likes !== null || m.comments !== null || m.views !== null) && (
            <>
              {' · '}
              {[
                m.views !== null && `${compact(m.views)} views`,
                m.likes !== null && `${compact(m.likes)} likes`,
                m.comments !== null && `${compact(m.comments)} comments`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </>
          )}
        </span>
      </div>
      {post.externalUrl && (
        <a href={post.externalUrl} target="_blank" rel="noreferrer noopener" className={styles.postLink} aria-label="Open the post">
          <Icon.external />
        </a>
      )}
    </li>
  );
}
