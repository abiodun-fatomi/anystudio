/**
 * API entrypoint.
 *
 * Everything security-relevant is applied here, before any route exists, so a
 * new controller cannot accidentally opt out of it. The order is fixed:
 * refuse-to-start checks, then hardening, then validation, then routes.
 *
 * Routes are versioned in the path — /api/v1/auth/login — except the two
 * probes (/health, /ready), which a platform healthcheck must find without
 * knowing our conventions.
 */
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertAppKey } from './utils/crypto/encrypt';
import { BODY_LIMIT, configureSecurity } from '../config/security';
import SwaggerConfig from '../config/swagger';
import { logger } from '../config/logger';

async function bootstrap(): Promise<void> {
  // Refuse to start on a key we cannot encrypt with, rather than discovering
  // it on someone's first sign-in.
  assertAppKey();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    cors: false,
    bodyParser: true,
    rawBody: true, // webhook signature checks need the bytes as sent
  });
  app.useBodyParser('json', { limit: BODY_LIMIT });

  configureSecurity(app);

  // DTOs are the contract: unknown fields are stripped, types are coerced,
  // and a body that fails its DTO never reaches a service.
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidUnknownValues: false }));

  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  new SwaggerConfig().set(app);

  // SIGTERM arrives on every deploy; without this an in-flight generation is
  // cut off after its credits have already been spent with the provider.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  logger.info({ port, env: process.env.APP_ENV ?? 'local', docs: SwaggerConfig.enabled() ? '/api/v1/docs' : 'off' }, 'api listening');
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
