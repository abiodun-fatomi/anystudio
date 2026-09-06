/**
 * Insights for a workspace: what was made, what it cost, how it is going.
 *
 * Everything here is an aggregate over rows that already exist —
 * generations and the ledger — computed on read. No counters to keep in
 * step, no nightly job to fall behind; the cost is a handful of grouped
 * queries over one workspace's rows, which the (workspaceId, createdAt)
 * indexes make cheap for years of a seller's history.
 *
 * Posts carry the numbers their platform last reported (PublishJob.metrics,
 * refreshed by the worker), so "how did it do" is answered from our own
 * rows too. The next steps at the end are rules, not a model: they name
 * the one thing a seller can do today that the numbers say is missing.
 */

import { Injectable } from '@nestjs/common';
import { PrismaClient, type ProviderCapability } from '@prisma/client';
import { NotFoundError } from '../../../config/globals/errors';
import { LedgerService } from '../ledger/ledger.service';
import { TYPE_OF } from '../library/library.service';

const DAY_MS = 24 * 3600_000;

export interface InsightsQuery {
  days: number;
}

@Injectable()
export class InsightsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
  ) {}

  async overview(workspaceId: string, q: InsightsQuery) {
    const days = Math.min(Math.max(q.days, 7), 365);
    const now = new Date();
    const since = new Date(Date.now() - days * DAY_MS);
    const prevSince = new Date(since.getTime() - days * DAY_MS);
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } });
    if (!wallet) throw new NotFoundError('workspace');

    const [daily, byCapability, prev, ledgerByKind, balance, spend14, library, topProducts, timing, posts, accounts, unposted, videoless, brandKit, ownVoice] =
      await Promise.all([
        // One row per day per outcome, for the chart.
        this.db.$queryRaw<Array<{ day: Date; status: string; count: number; credits: number }>>`
        SELECT date_trunc('day', g."createdAt") AS "day", g.status::text AS "status", count(*)::int AS "count", coalesce(sum(g.credits), 0)::int AS "credits"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.kind <> 'CHILD' AND g."createdAt" >= ${since} AND g.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
          AND coalesce(g.input->>'task', '') <> 'shot_plan'
        GROUP BY 1, 2 ORDER BY 1`,
        this.db.$queryRaw<Array<{ capability: ProviderCapability; count: number; credits: number; failed: number }>>`
        SELECT g.capability::text AS "capability", count(*) FILTER (WHERE g.status = 'SUCCEEDED')::int AS "count",
               coalesce(sum(g.credits) FILTER (WHERE g.status = 'SUCCEEDED'), 0)::int AS "credits",
               count(*) FILTER (WHERE g.status = 'FAILED')::int AS "failed"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.kind <> 'CHILD' AND g."createdAt" >= ${since} AND coalesce(g.input->>'task', '') <> 'shot_plan'
        GROUP BY 1`,
        this.db.$queryRaw<Array<{ count: number; credits: number }>>`
        SELECT count(*) FILTER (WHERE g.status = 'SUCCEEDED')::int AS "count", coalesce(sum(g.credits) FILTER (WHERE g.status = 'SUCCEEDED'), 0)::int AS "credits"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.kind <> 'CHILD' AND g."createdAt" >= ${prevSince} AND g."createdAt" < ${since} AND coalesce(g.input->>'task', '') <> 'shot_plan'`,
        this.db.$queryRaw<Array<{ kind: string; total: number }>>`
        SELECT l.kind::text AS "kind", coalesce(sum(l.delta), 0)::int AS "total"
        FROM ledger_entries l WHERE l."walletId" = ${wallet.id}::uuid AND l."createdAt" >= ${since} GROUP BY 1`,
        this.ledger.balance(wallet.id),
        this.db.$queryRaw<Array<{ spent: number }>>`
        SELECT coalesce(-sum(l.delta), 0)::int AS "spent" FROM ledger_entries l
        WHERE l."walletId" = ${wallet.id}::uuid AND l.kind IN ('DEBIT', 'REFUND') AND l."createdAt" >= ${new Date(Date.now() - 14 * DAY_MS)}`,
        this.db.$queryRaw<Array<{ total: number; added: number; images: number; videos: number; copy: number; sources: number }>>`
        SELECT count(*) FILTER (WHERE g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g.kind <> 'CHILD' AND coalesce(g.input->>'task', '') <> 'shot_plan')::int AS "total",
               count(*) FILTER (WHERE g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g.kind <> 'CHILD' AND coalesce(g.input->>'task', '') <> 'shot_plan' AND g."createdAt" >= ${since})::int AS "added",
               count(*) FILTER (WHERE g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g.kind <> 'CHILD' AND g.capability::text IN ('IMAGE_GENERATE','IMAGE_EDIT','BACKGROUND_REMOVE','BACKGROUND_REPLACE','RELIGHT','UPSCALE'))::int AS "images",
               count(*) FILTER (WHERE g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g.kind <> 'CHILD' AND g.capability::text IN ('IMAGE_TO_VIDEO','VIDEO_STITCH','DUB','LIPSYNC'))::int AS "videos",
               count(*) FILTER (WHERE g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g.kind <> 'CHILD' AND g.capability = 'TEXT_GENERATE' AND coalesce(g.input->>'task', '') <> 'shot_plan')::int AS "copy",
               (SELECT count(*) FROM media_assets m WHERE m."workspaceId" = ${workspaceId}::uuid AND m.kind = 'SOURCE' AND m.status = 'READY' AND m."deletedAt" IS NULL)::int AS "sources"
        FROM generations g WHERE g."workspaceId" = ${workspaceId}::uuid`,
        this.db.$queryRaw<Array<{ productKey: string; title: string | null; count: number; credits: number }>>`
        SELECT g."productKey", max(g.title) AS "title", count(*)::int AS "count", coalesce(sum(g.credits), 0)::int AS "credits"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.kind <> 'CHILD' AND g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g."productKey" IS NOT NULL AND g."createdAt" >= ${since}
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`,
        this.db.$queryRaw<Array<{ capability: ProviderCapability; p50: number | null; p90: number | null }>>`
        SELECT g.capability::text AS "capability",
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (g."finishedAt" - g."createdAt"))) AS "p50",
               percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (g."finishedAt" - g."createdAt"))) AS "p90"
        FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.kind <> 'CHILD' AND g.status = 'SUCCEEDED' AND g."finishedAt" IS NOT NULL AND g."createdAt" >= ${since}
        GROUP BY 1`,
        this.db.publishJob.findMany({
          where: { workspaceId, createdAt: { gte: since } },
          orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          take: 60,
          select: {
            id: true,
            platform: true,
            format: true,
            status: true,
            caption: true,
            publishedAt: true,
            scheduledFor: true,
            externalUrl: true,
            generationId: true,
            metrics: true,
            metricsAt: true,
            account: { select: { handle: true, displayName: true } },
          },
        }),
        this.db.socialAccount.count({ where: { workspaceId, status: 'CONNECTED' } }),
        // Finished images and videos in the range that were never posted from here.
        this.db.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count" FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.kind <> 'CHILD' AND g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g."createdAt" >= ${since}
          AND g.capability::text IN ('IMAGE_GENERATE','IMAGE_EDIT','BACKGROUND_REPLACE','IMAGE_TO_VIDEO')
          AND NOT EXISTS (SELECT 1 FROM publish_jobs p WHERE p."generationId" = g.id)`,
        // Products with pictures made but no video yet.
        this.db.$queryRaw<Array<{ productKey: string; title: string | null }>>`
        SELECT g."productKey", max(g.title) AS "title" FROM generations g
        WHERE g."workspaceId" = ${workspaceId}::uuid AND g.kind <> 'CHILD' AND g.status = 'SUCCEEDED' AND g."deletedAt" IS NULL AND g."productKey" IS NOT NULL
          AND g.capability::text IN ('IMAGE_GENERATE','IMAGE_EDIT','BACKGROUND_REPLACE')
          AND NOT EXISTS (SELECT 1 FROM generations v WHERE v."workspaceId" = g."workspaceId" AND v."productKey" = g."productKey" AND v.capability = 'IMAGE_TO_VIDEO' AND v.status = 'SUCCEEDED')
        GROUP BY 1 ORDER BY max(g."createdAt") DESC LIMIT 3`,
        this.db.brandKit.findUnique({ where: { workspaceId }, select: { businessName: true, logoKey: true } }),
        this.db.voiceProfile.count({ where: { workspaceId, kind: 'CLONE', active: true } }),
      ]);

    // Fill every day so the chart has no holes.
    const series: Array<{ date: string; made: number; failed: number; credits: number }> = [];
    const byDay = new Map<string, { made: number; failed: number; credits: number }>();
    for (const r of daily) {
      const k = r.day.toISOString().slice(0, 10);
      const d = byDay.get(k) ?? { made: 0, failed: 0, credits: 0 };
      if (r.status === 'SUCCEEDED') {
        d.made += r.count;
        d.credits += r.credits;
      } else if (r.status === 'FAILED') d.failed += r.count;
      byDay.set(k, d);
    }
    for (let i = days - 1; i >= 0; i--) {
      const k = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
      series.push({ date: k, ...(byDay.get(k) ?? { made: 0, failed: 0, credits: 0 }) });
    }

    const made = byCapability.reduce((s, r) => s + r.count, 0);
    const failed = byCapability.reduce((s, r) => s + r.failed, 0);
    const credits = byCapability.reduce((s, r) => s + r.credits, 0);
    const byType: Record<string, { count: number; credits: number; failed: number }> = {};
    for (const r of byCapability) {
      const t = TYPE_OF[r.capability] ?? 'image';
      const b = byType[t] ?? { count: 0, credits: 0, failed: 0 };
      b.count += r.count;
      b.credits += r.credits;
      b.failed += r.failed;
      byType[t] = b;
    }
    const ledger = Object.fromEntries(ledgerByKind.map((r) => [r.kind, r.total]));
    const dailySpend = (spend14[0]?.spent ?? 0) / 14;
    const runwayDays = dailySpend > 0 ? Math.floor(balance / dailySpend) : null;
    const previous = prev[0] ?? { count: 0, credits: 0 };

    // Posts: what went out, and how it did where the platform told us.
    type M = { views?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saved?: number | null };
    const published = posts.filter((p) => p.status === 'PUBLISHED');
    const sum = (k: keyof M) => {
      let any = false;
      let total = 0;
      for (const p of published) {
        const v = (p.metrics as M | null)?.[k];
        if (typeof v === 'number') {
          any = true;
          total += v;
        }
      }
      return any ? total : null;
    };
    const score = (p: (typeof posts)[number]) => {
      const m = (p.metrics as M | null) ?? {};
      return (m.likes ?? 0) + 2 * (m.comments ?? 0) + 2 * (m.shares ?? 0) + (m.saved ?? 0);
    };
    const best = published.filter((p) => p.metrics).sort((a, b) => score(b) - score(a))[0] ?? null;
    const postView = (p: (typeof posts)[number]) => ({
      id: p.id,
      platform: p.platform,
      format: p.format,
      status: p.status,
      caption: p.caption.slice(0, 120),
      publishedAt: p.publishedAt?.toISOString() ?? null,
      scheduledFor: p.scheduledFor.toISOString(),
      externalUrl: p.externalUrl,
      generationId: p.generationId,
      handle: p.account.handle ?? p.account.displayName,
      metrics: (p.metrics as M | null) ?? null,
      metricsAt: p.metricsAt?.toISOString() ?? null,
    });
    const postsOut = {
      published: published.length,
      scheduled: posts.filter((p) => p.status === 'SCHEDULED' || p.status === 'PUBLISHING').length,
      failed: posts.filter((p) => p.status === 'FAILED').length,
      byPlatform: Object.fromEntries(['INSTAGRAM', 'TIKTOK'].map((pl) => [pl, published.filter((p) => p.platform === pl).length])),
      totals: { views: sum('views'), reach: sum('reach'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), saved: sum('saved') },
      measured: published.filter((p) => p.metrics).length,
      recent: posts.slice(0, 6).map(postView),
      best: best ? postView(best) : null,
      accountsConnected: accounts,
    };

    // The next steps: rules over what is here, in the order a seller should act on them.
    const steps: Array<{ key: string; title: string; body: string; href: string; cta: string }> = [];
    const failedRate = made + failed >= 4 ? failed / (made + failed) : 0;
    if (runwayDays !== null && runwayDays < 7 && balance < 500)
      steps.push({
        key: 'topup',
        title: 'Credits run out in about a week',
        body: `${balance.toLocaleString()} left at your recent pace. Top up before a job stops halfway.`,
        href: '/billing/plans',
        cta: 'Top up',
      });
    if (accounts === 0)
      steps.push({
        key: 'connect',
        title: 'Connect Instagram or TikTok',
        body: 'Post straight from the studio and see how each post does, here.',
        href: '/publishing',
        cta: 'Connect an account',
      });
    const unpostedCount = unposted[0]?.count ?? 0;
    if (unpostedCount > 0)
      steps.push({
        key: 'unposted',
        title: unpostedCount === 1 ? 'One finished piece has not been posted' : `${unpostedCount} finished pieces have not been posted`,
        body: 'Made and never seen sells nothing. Pick the best and post it — Suggest captions writes the words.',
        href: '/library',
        cta: 'Open the library',
      });
    if (videoless[0])
      steps.push({
        key: 'video',
        title: `Make a video for ${videoless[0].title ?? 'your product'}`,
        body: 'It has pictures but no video, and reels reach people the feed does not. A 15-second ad takes a few minutes.',
        href: '/studio',
        cta: 'Make a video',
      });
    if (best && score(best) > 0)
      steps.push({
        key: 'repeat',
        title: 'Your best post — make another like it',
        body: `"${best.caption.slice(0, 60)}${best.caption.length > 60 ? '…' : ''}" is the one people responded to. The same product, a new angle.`,
        href: best.generationId ? `/library?item=${best.generationId}` : '/library',
        cta: 'See it',
      });
    if (failedRate > 0.25)
      steps.push({
        key: 'failures',
        title: 'A few jobs failed',
        body: `${Math.round(failedRate * 100)}% of recent jobs did not finish. Every failure refunded itself; the library says why each one stopped.`,
        href: '/library?status=failed',
        cta: 'See why',
      });
    if (!brandKit?.businessName && !brandKit?.logoKey)
      steps.push({
        key: 'brand',
        title: 'Add your name and logo once',
        body: 'Every image, video and caption picks them up. Two minutes, then never again.',
        href: '/brand',
        cta: 'Set up brand',
      });
    if (ownVoice === 0 && (byType.audio?.count ?? 0) + (byType.video?.count ?? 0) > 0)
      steps.push({
        key: 'voice',
        title: 'Record your voice',
        body: 'Voiceovers and presenter ads can speak in your own voice. Half a minute of talking is enough.',
        href: '/settings/voice',
        cta: 'Record it',
      });

    return {
      range: { days, from: since.toISOString(), to: now.toISOString() },
      totals: {
        made,
        failed,
        credits,
        successRate: made + failed > 0 ? Math.round((made / (made + failed)) * 100) : null,
        refunded: ledger.REFUND ?? 0,
        bought: (ledger.PURCHASE ?? 0) + (ledger.PROMO ?? 0),
        previous: { made: previous.count, credits: previous.credits },
      },
      balance: { credits: balance, dailySpend: Math.round(dailySpend * 10) / 10, runwayDays },
      series,
      byType,
      byCapability: byCapability.map((r) => ({ capability: r.capability, type: TYPE_OF[r.capability], count: r.count, credits: r.credits, failed: r.failed })),
      timing: timing.map((t) => ({
        capability: t.capability,
        p50Sec: t.p50 === null ? null : Math.round(Number(t.p50)),
        p90Sec: t.p90 === null ? null : Math.round(Number(t.p90)),
      })),
      library: library[0] ?? { total: 0, added: 0, images: 0, videos: 0, copy: 0, sources: 0 },
      topProducts,
      posts: postsOut,
      nextSteps: steps.slice(0, 4),
    };
  }
}
