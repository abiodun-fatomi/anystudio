/**
 * API entrypoint.
 *
 * Everything security-relevant is applied here, before any route exists, so a
 * new controller cannot accidentally opt out of it.
 */

import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { corsOptions } from './common/http/cors';
import { logger } from './common/logging/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, cors: false });

  /**
   * Headers. `frame-ancestors 'none'` and X-Frame-Options are the clickjacking
   * controls; the full CSP is served by the web apps, not the API, because the
   * API returns JSON and has no scripts to govern.
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      // The API serves no HTML; this stops a browser from guessing otherwise.
      xContentTypeOptions: true,
    }),
  );
  app.use(cookieParser());
  app.enableCors(corsOptions());

  // Behind Render/Cloudflare, so req.ip must come from the forwarded header —
  // otherwise every rate limit sees one proxy address and limits everyone at once.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.disable?.('x-powered-by');

  /**
   * Graceful shutdown. SIGTERM arrives on every deploy; without this an
   * in-flight generation is cut off after its credits have already been spent
   * with the provider.
   */
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  logger.info({ port, env: process.env.APP_ENV ?? 'local' }, 'api listening');
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
