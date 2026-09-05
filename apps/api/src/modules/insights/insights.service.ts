/**
 * Insights for a workspace: what was made, what it cost, how it is going.
 *
 * Everything here is an aggregate over rows that already exist —
 * generations and the ledger — computed on read. No counters to keep in
 * step, no nightly job to fall behind; the cost is a handful of grouped
 * queries over one workspace's rows, which the (workspaceId, createdAt)
 * indexes make cheap for years of a seller's history.
 *
 * Engagement per published post lands with the publishing phase; the
 * shape leaves room for it.
 */

import { Injectable } from '@nestjs/common';
import { PrismaClient, type ProviderCapability } from '@prisma/client';
import { NotFoundError } from '../../../config/globals/errors';
import { LedgerService } from '../ledger/ledger.service';
import { TYPE_OF } from '../library/library.service';

const DAY_MS = 24 * 3600_000;

export interface InsightsQuery { days: number }

@Injectable()
export class InsightsService {
  constructor(private readonly db: PrismaClient, private readonly ledger: LedgerService) {}

  async overview(workspaceId: string, q: InsightsQuery) {
    const days = Math.min(Math.max(q.days, 7), 365);
    const now = new Date();
    const since = new Date(Date.now() - days * DAY_MS);
    const prevSince = new Date(since.getTime() - days * DAY_MS);
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } });
    if (!wallet) throw new NotFoundError('workspace');

    const [daily, byCapability, prev, ledgerByKind, balance, spend14, library, topProducts, timing] = await Promise.all([
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
    ]);

    // Fill every day so the chart has no holes.
    const series: Array<{ date: string; made: number; failed: number; credits: number }> = [];
    const byDay = new Map<string, { made: number; failed: number; credits: number }>();
    for (const r of daily) {
      const k = r.day.toISOString().slice(0, 10);
      const d = byDay.get(k) ?? { made: 0, failed: 0, credits: 0 };
      if (r.status === 'SUCCEEDED') { d.made += r.count; d.credits += r.credits; } else if (r.status === 'FAILED') d.failed += r.count;
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
      b.count += r.count; b.credits += r.credits; b.failed += r.failed;
      byType[t] = b;
    }
    const ledger = Object.fromEntries(ledgerByKind.map((r) => [r.kind, r.total]));
    const dailySpend = (spend14[0]?.spent ?? 0) / 14;
    const runwayDays = dailySpend > 0 ? Math.floor(balance / dailySpend) : null;
    const previous = prev[0] ?? { count: 0, credits: 0 };

    return {
      range: { days, from: since.toISOString(), to: now.toISOString() },
      totals: {
        made, failed, credits,
        successRate: made + failed > 0 ? Math.round((made / (made + failed)) * 100) : null,
        refunded: ledger.REFUND ?? 0,
        bought: (ledger.PURCHASE ?? 0) + (ledger.PROMO ?? 0),
        previous: { made: previous.count, credits: previous.credits },
      },
      balance: { credits: balance, dailySpend: Math.round(dailySpend * 10) / 10, runwayDays },
      series,
      byType,
      byCapability: byCapability.map((r) => ({ capability: r.capability, type: TYPE_OF[r.capability], count: r.count, credits: r.credits, failed: r.failed })),
      timing: timing.map((t) => ({ capability: t.capability, p50Sec: t.p50 === null ? null : Math.round(Number(t.p50)), p90Sec: t.p90 === null ? null : Math.round(Number(t.p90)) })),
      library: library[0] ?? { total: 0, added: 0, images: 0, videos: 0, copy: 0, sources: 0 },
      topProducts,
      /** Filled by the publishing phase: engagement per published asset. */
      engagement: null,
    };
  }
}
