/**
 * Container healthcheck for either worker service.
 *
 * Postgres is intentionally the source here. Redis may be unavailable while
 * the worker is correctly draining its own queue class through the database
 * fallback; tying liveness to Redis would restart that healthy fallback in a
 * loop. The supervisor writes this same per-service row every thirty seconds.
 */
import { PrismaClient } from '@prisma/client';
import { hostname } from 'node:os';

export function heartbeatIsFresh(seenAt: Date | null | undefined, now = Date.now()): boolean {
  return seenAt !== null && seenAt !== undefined && now - seenAt.getTime() < 90_000;
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  let code = 1;
  try {
    const service = process.env.SERVICE_NAME?.trim() || 'worker';
    const row = await db.workerHeartbeat.findUnique({ where: { id: `${service}@${hostname()}` }, select: { seenAt: true } });
    code = heartbeatIsFresh(row?.seenAt) ? 0 : 1;
  } catch {
    code = 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
    process.exit(code);
  }
}

if (require.main === module) void main();
