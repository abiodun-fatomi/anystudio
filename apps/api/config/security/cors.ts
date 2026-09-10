/**
 * CORS, per surface.
 *
 * The important decision here is the public org API: it gets NO CORS headers at
 * all, deliberately. Refusing browser calls means a merchant physically cannot
 * ship their secret key in frontend JavaScript, which is the most common way
 * API keys leak. It is a security control disguised as a missing feature.
 */

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** Every origin allowed to make credentialed calls, by environment. */
export function allowedOrigins(): string[] {
  const list = [process.env.ORIGIN_APP, process.env.ORIGIN_ORG, process.env.ORIGIN_ADMIN].filter((v): v is string => Boolean(v));

  if (list.length === 0) {
    throw new Error('No ORIGIN_* configured — refusing to start with an open CORS policy');
  }
  return list;
}

export function corsOptions(): CorsOptions {
  const origins = allowedOrigins();
  return {
    // A function, not an array, so an unknown origin gets no header at all
    // rather than a header naming someone else's origin.
    origin(origin, cb) {
      if (!origin) return cb(null, false); // curl, server-to-server: no CORS needed
      cb(null, origins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id', 'x-csrf-token', 'idempotency-key'],
    exposedHeaders: ['x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'],
    maxAge: 600,
  };
}
