/**
 * Routing: which adapter answers a capability, in what order, and when one
 * is taken out of rotation.
 *
 * THE ROWS DECIDE, THE CODE OBEYS
 * -------------------------------
 * `route()` reads ProviderModel rows for the capability, keeps the ones this
 * process has an adapter and a credential for, drops any whose breaker is
 * open, and orders them by priority. Nothing here knows a vendor's name.
 * Changing the default model is an UPDATE; taking one out during an outage
 * is `enabled = false`; both are visible in the log line that explains every
 * routing decision.
 *
 * THE BREAKER
 * -----------
 * A provider that fails often is demoted before it fails for every customer.
 * Outcomes are counted per (key, capability) in a short sliding window held
 * in this process — deliberately not in Redis, so a Redis outage cannot open
 * every breaker at once — and persisted to `breakerOpenedAt` on the row when
 * one trips, which is how the operations console shows it and how other
 * worker processes learn of it on their next route. A tripped breaker
 * half-opens after a cooldown: one probe request is let through, and its
 * result decides whether the row is back.
 *
 * Only RETRYABLE, RATE_LIMITED and PROVIDER_DOWN count against a provider.
 * CONTENT_REJECTED is about the customer's input and INVALID_INPUT is about
 * our request; neither says anything about the vendor's health.
 */

import { Injectable } from '@nestjs/common';
import { PrismaClient, type ProviderModel, type WorkspaceType } from '@prisma/client';
import type { Capability, GenerationProvider, ProviderErrorKind } from '@anystudio/shared';
import { logger } from '../../../config/logger';
import { ProviderRegistry } from './provider.registry';

export interface RouteCandidate {
  row: ProviderModel;
  provider: GenerationProvider;
}

/** How a pipeline narrows the router's choice; see `route`. */
export interface RouteConstraint {
  only?: string;
  exclude?: string[];
  prefer?: string[];
}

export interface RouteDecision {
  capability: Capability;
  candidates: RouteCandidate[];
  /** What was considered and why it was not chosen. Logged, and shown to operators. */
  excluded: Array<{ key: string; reason: string }>;
}

/** Sliding-window health per (key, capability). */
interface Health {
  window: Array<{ at: number; ok: boolean }>;
  openedAt: number | null;
  probing: boolean;
}

const WINDOW_MS = 2 * 60 * 1000;
const MIN_SAMPLES = 5;
const TRIP_ERROR_RATE = 0.5;
const COOLDOWN_MS = 60 * 1000;

@Injectable()
export class ProviderRouter {
  private readonly health = new Map<string, Health>();

  constructor(
    private readonly db: PrismaClient,
    private readonly registry: ProviderRegistry,
  ) {}

  /** Ordered candidates for a capability, or an empty list with the reasons. */
  async route(capability: Capability, workspaceType: WorkspaceType, ctx: RouteConstraint & { generationId?: string } = {}): Promise<RouteDecision> {
    // `only`: a voice belongs to one vendor, so the row for that vendor is the only candidate.
    // `exclude`: vendors known not to serve this request (a dub into a language they lack).
    // `prefer`: vendors to try first regardless of priority (the one that can also move the lips).
    const rows = await this.db.providerModel.findMany({
      where: { capability, enabled: true, OR: [{ workspaceType: null }, { workspaceType }], ...(ctx.only ? { key: ctx.only } : ctx.exclude?.length ? { key: { notIn: ctx.exclude } } : {}) },
      orderBy: [{ priority: 'asc' }, { key: 'asc' }],
    });
    if (ctx.prefer?.length) {
      const rank = (k: string) => { const i = ctx.prefer!.indexOf(k); return i === -1 ? ctx.prefer!.length : i; };
      rows.sort((a, b) => rank(a.key) - rank(b.key) || a.priority - b.priority);
    }

    const candidates: RouteCandidate[] = [];
    const excluded: RouteDecision['excluded'] = [];
    const now = Date.now();

    // A tier-specific row outranks the general one at the same priority (a preferred vendor keeps its place).
    if (!ctx.prefer?.length) rows.sort((a, b) => a.priority - b.priority || (a.workspaceType ? -1 : 0) - (b.workspaceType ? -1 : 0));

    for (const row of rows) {
      const provider = this.registry.get(row.key);
      if (!provider) { excluded.push({ key: row.key, reason: 'no adapter or credential in this process' }); continue; }
      if (!provider.supports(capability)) { excluded.push({ key: row.key, reason: 'adapter does not implement this capability' }); continue; }

      const h = this.healthFor(row.key, capability);
      const openedAt = h.openedAt ?? row.breakerOpenedAt?.getTime() ?? null;
      if (openedAt !== null) {
        if (now - openedAt < COOLDOWN_MS) { excluded.push({ key: row.key, reason: `breaker open for ${Math.round((now - openedAt) / 1000)}s` }); continue; }
        if (h.probing) { excluded.push({ key: row.key, reason: 'breaker half-open; a probe is already in flight' }); continue; }
        h.probing = true; // this request is the probe
        logger.warn({ providerKey: row.key, capability, ...ctx }, 'breaker half-open: sending one probe request');
      }
      candidates.push({ row, provider });
    }

    if (candidates.length === 0) {
      logger.error({ capability, workspaceType, excluded, ...ctx }, 'no provider can serve this capability right now');
    } else {
      logger.info(
        { capability, workspaceType, chosen: candidates[0]!.row.key, fallbacks: candidates.slice(1).map((c) => c.row.key), excluded, ...ctx },
        'provider routed',
      );
    }
    return { capability, candidates, excluded };
  }

  /** Record how a call went. Trips or resets the breaker; always cheap. */
  async report(key: string, capability: Capability, outcome: { ok: true; latencyMs: number } | { ok: false; kind: ProviderErrorKind; latencyMs: number }, ctx: { generationId?: string } = {}): Promise<void> {
    const h = this.healthFor(key, capability);
    const now = Date.now();
    h.window = h.window.filter((s) => now - s.at < WINDOW_MS);

    if (outcome.ok) {
      h.window.push({ at: now, ok: true });
      if (h.openedAt !== null || h.probing) {
        h.openedAt = null; h.probing = false; h.window = [];
        await this.persist(key, capability, null);
        logger.info({ providerKey: key, capability, ...ctx }, 'breaker closed: provider is healthy again');
      }
      return;
    }

    const counts = outcome.kind === 'RETRYABLE' || outcome.kind === 'RATE_LIMITED' || outcome.kind === 'PROVIDER_DOWN';
    if (!counts) return; // the customer's input or our bug — says nothing about the vendor
    h.window.push({ at: now, ok: false });

    if (h.probing) {
      // The probe failed: stay open for another cooldown.
      h.openedAt = now; h.probing = false;
      await this.persist(key, capability, new Date(now));
      logger.warn({ providerKey: key, capability, kind: outcome.kind, ...ctx }, 'breaker probe failed: staying open');
      return;
    }

    const failures = h.window.filter((s) => !s.ok).length;
    const rate = failures / h.window.length;
    const trip = outcome.kind === 'PROVIDER_DOWN' || (h.window.length >= MIN_SAMPLES && rate >= TRIP_ERROR_RATE);
    if (trip && h.openedAt === null) {
      h.openedAt = now;
      await this.persist(key, capability, new Date(now));
      logger.error(
        { providerKey: key, capability, kind: outcome.kind, failures, samples: h.window.length, errorRate: Number(rate.toFixed(2)), ...ctx },
        'breaker OPENED: provider demoted for the cooldown; traffic falls to the next candidate',
      );
    }
  }

  /** For the operations dashboard. */
  snapshot(): Array<{ key: string; capability: string; openedAt: number | null; samples: number; failures: number }> {
    return [...this.health.entries()].map(([k, h]) => {
      const [key, capability] = k.split('|') as [string, string];
      return { key, capability, openedAt: h.openedAt, samples: h.window.length, failures: h.window.filter((s) => !s.ok).length };
    });
  }

  private healthFor(key: string, capability: Capability): Health {
    const k = `${key}|${capability}`;
    let h = this.health.get(k);
    if (!h) { h = { window: [], openedAt: null, probing: false }; this.health.set(k, h); }
    return h;
  }

  private async persist(key: string, capability: Capability, openedAt: Date | null): Promise<void> {
    try {
      await this.db.providerModel.updateMany({ where: { key, capability }, data: { breakerOpenedAt: openedAt } });
    } catch (err) {
      // The in-memory breaker still protects this process; only the shared view is stale.
      logger.warn({ providerKey: key, capability, err }, 'could not persist breaker state');
    }
  }
}
