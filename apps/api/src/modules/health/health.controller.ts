/**
 * Health and readiness.
 *
 * Two endpoints, because they answer different questions and conflating them
 * causes outages: a liveness probe that checks the database will restart a
 * perfectly healthy API during a brief database blip, turning a degraded
 * service into a down one.
 */

import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { BillingCatalogueReadinessService } from '../billing/billing-catalogue-readiness.service';

const WORKER_STALE_MS = 90_000;

interface WorkerProbeRow {
  seenAt: Date;
  version: string | null;
}

/** Public readiness contains no host or infrastructure identifiers. */
export function workerProbe(row: WorkerProbeRow | null, now = Date.now()): { alive: boolean; release: string | null } {
  return {
    alive: row !== null && now - row.seenAt.getTime() < WORKER_STALE_MS,
    release: row?.version?.slice(0, 7) ?? null,
  };
}

@ApiTags('health')
@Public()
// Outside /api and outside versioning: a platform healthcheck must find
// these without knowing our conventions, and they must never move.
@Controller({ path: '', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly db: PrismaClient,
    private readonly billingCatalogue: BillingCatalogueReadinessService,
  ) {}

  /**
   * Liveness.
   *
   * WHAT     Says the process is up and serving. Checks nothing external.
   * WHO      Anyone. The platform's healthcheck calls it unauthenticated.
   * COSTS    Nothing.
   * WRITES   Nothing.
   */
  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is up. Checks nothing external.' })
  health() {
    return {
      status: 'ok',
      service: process.env.SERVICE_NAME ?? 'api',
      env: process.env.APP_ENV ?? 'local',
      // Render sets RENDER_GIT_COMMIT on every git-backed service; a Docker
      // build elsewhere passes GIT_SHA. The deploy's smoke test compares this
      // to the commit it just shipped.
      release: (process.env.GIT_SHA ?? process.env.RENDER_GIT_COMMIT)?.slice(0, 7) ?? 'dev',
      uptime: Math.round(process.uptime()),
    };
  }

  /**
   * Readiness.
   *
   * WHAT     Says this release can serve real traffic: the database answers
   *          and both queue classes have a fresh worker heartbeat. Render's
   *          web liveness probe remains /health, so a worker outage degrades
   *          this signal without restarting an otherwise healthy API.
   * WHO      Anyone.
   * COSTS    A small fixed set of local database queries; never vendor I/O.
   * WRITES   Nothing.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: the database answers. Used by the load balancer.' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    try {
      const [, workerRow, mediaRow, billing] = await Promise.all([
        this.db.$queryRaw`SELECT 1`,
        this.db.workerHeartbeat.findFirst({ where: { service: 'worker' }, orderBy: { seenAt: 'desc' }, select: { seenAt: true, version: true } }),
        this.db.workerHeartbeat.findFirst({ where: { service: 'media' }, orderBy: { seenAt: 'desc' }, select: { seenAt: true, version: true } }),
        this.billingCatalogue.check(),
      ]);
      const now = Date.now();
      const workers = { worker: workerProbe(workerRow, now), media: workerProbe(mediaRow, now) };
      // `payments: "off"` appears only when a person declared PAYMENTS_DISABLED.
      // It is the difference between "this release is broken" and "this release
      // cannot take money yet, on purpose" — the one fact an operator reading a
      // status page actually needs, and one the sign-up flow already tells any
      // visitor who tries to buy credits.
      const publicBilling = billing.paymentsDisabled ? { ready: billing.ready, payments: 'off' as const } : { ready: billing.ready };
      if (!workers.worker.alive || !workers.media.alive || !billing.ready) {
        res.status(HttpStatus.SERVICE_UNAVAILABLE);
        return { status: 'degraded', dbMs: Date.now() - started, workers, billing: publicBilling };
      }
      return { status: 'ready', dbMs: Date.now() - started, workers, billing: publicBilling };
    } catch {
      // 503, not 200-with-a-sad-body: a load balancer reads the status code,
      // not the JSON, and would otherwise keep routing to an instance that
      // cannot serve. Deliberately no error detail — this endpoint is public,
      // and a database hostname or driver version in the body is free
      // reconnaissance.
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', dbMs: Date.now() - started, workers: null, billing: { ready: false } };
    }
  }
}
