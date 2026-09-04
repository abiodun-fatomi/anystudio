/**
 * HTTP hardening, in one place, applied by main.ts in a fixed order.
 *
 * Nothing here is configurable per environment on purpose: a header that is
 * "off in staging" is a header that is off when someone forgets to turn it on.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { corsOptions } from './cors';

export { corsOptions, allowedOrigins } from './cors';

/** Helmet, tuned for a JSON API that serves no HTML of its own. */
export function helmetOptions(): Parameters<typeof helmet>[0] {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // Two years, subdomains, preload-eligible. The web apps send their own.
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  };
}

/** Everything that must run before a route sees the request. */
export function configureSecurity(app: NestExpressApplication): void {
  // Behind Render/Cloudflare, so req.ip must come from the forwarded header —
  // otherwise every rate limit sees one proxy address and limits everyone at once.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet(helmetOptions()));
  app.use(compression());
  app.use(cookieParser());
  app.enableCors(corsOptions());
}

/** Body size ceiling. Uploads go to object storage, never through this API. */
export const BODY_LIMIT = '256kb';
