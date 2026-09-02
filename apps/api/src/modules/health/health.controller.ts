/**
 * Health and readiness.
 *
 * Two endpoints, because they answer different questions and conflating them
 * causes outages: a liveness probe that checks the database will restart a
 * perfectly healthy API during a brief database blip, turning a degraded
 * service into a down one.
 */

import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Controller()
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
  health() {
    return {
      status: 'ok',
      service: process.env.SERVICE_NAME ?? 'api',
      env: process.env.APP_ENV ?? 'local',
      release: process.env.GIT_SHA?.slice(0, 7) ?? 'dev',
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
  async ready() {
    const started = Date.now();
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: 'ready', dbMs: Date.now() - started };
    } catch {
      // Deliberately no error detail — this endpoint is public, and a database
      // hostname or driver version in the body is free reconnaissance.
      return { status: 'degraded', dbMs: Date.now() - started };
    }
  }
}
