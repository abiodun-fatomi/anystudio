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

@ApiTags('health')
@Public()
// Outside /api and outside versioning: a platform healthcheck must find
// these without knowing our conventions, and they must never move.
@Controller({ path: '', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly db: PrismaClient) {}

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
   * WHAT     Says this instance can serve real traffic — database reachable.
   *          The load balancer uses this to decide whether to send requests.
   * WHO      Anyone.
   * COSTS    One trivial query.
   * WRITES   Nothing.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: the database answers. Used by the load balancer.' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: 'ready', dbMs: Date.now() - started };
    } catch {
      // 503, not 200-with-a-sad-body: a load balancer reads the status code,
      // not the JSON, and would otherwise keep routing to an instance that
      // cannot serve. Deliberately no error detail — this endpoint is public,
      // and a database hostname or driver version in the body is free
      // reconnaissance.
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', dbMs: Date.now() - started };
    }
  }
}
