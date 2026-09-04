/**
 * Worker entrypoint: `node dist/src/worker/main.js`.
 *
 * Same image as the API, different command. Provider calls take tens of
 * seconds to minutes and must never compete with webhook acknowledgements,
 * which have to return fast or the sender retries and we process the event
 * twice — so this is a separate process and a separate deploy, scaled on
 * its own.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { WorkerSupervisor } from './supervisor';
import { assertAppKey } from '../utils/crypto/encrypt';
import { logger } from '../../config/logger';

async function main(): Promise<void> {
  assertAppKey();
  process.env.SERVICE_NAME ??= 'worker';

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const supervisor = app.get(WorkerSupervisor);
  await supervisor.start();
  logger.info({ env: process.env.APP_ENV ?? 'local', redis: Boolean(process.env.REDIS_URL) }, 'worker started');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping: finishing jobs in hand');
    // SIGTERM arrives on every deploy. Finish the generation in hand — its
    // credits are already spent with the vendor — then leave.
    const deadline = setTimeout(() => { logger.error('worker did not stop in time; exiting'); process.exit(1); }, 5 * 60_000);
    deadline.unref();
    await supervisor.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection in worker'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
