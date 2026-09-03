/**
 * The logger.
 *
 * One JSON line per event, so a customer can quote a code off an error screen
 * and support finds the exact request in one search.
 */

import pino, { type LoggerOptions } from 'pino';
import { REDACT_PATHS } from './redact';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Human-readable logs in development, JSON everywhere else.
 *
 * pino-pretty is a devDependency, so it is absent from production images by
 * design — and a logger must never be the reason a process refuses to start.
 * If it cannot be resolved we fall back to JSON instead of throwing, which is
 * also what saves a production container that was built with NODE_ENV unset.
 */
function devTransport(): LoggerOptions['transport'] {
  if (isProd) return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, singleLine: false } };
  } catch {
    return undefined;
  }
}

export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: {
    service: process.env.SERVICE_NAME ?? 'api',
    env: process.env.APP_ENV ?? 'local',
    release: (process.env.GIT_SHA ?? process.env.RENDER_GIT_COMMIT)?.slice(0, 7),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  // Readable in development, machine-parseable everywhere else.
  transport: devTransport(),
};

export const logger = pino(loggerOptions);

/**
 * WARN means "recovered, but somebody would want to know": a provider fell
 * back, a retry succeeded, a soft quota was crossed, a webhook needed a second
 * attempt. If nobody would ever act on it, it is INFO.
 *
 * ERROR is logged once, at the boundary, with the stack. Log-and-rethrow at
 * every layer turns one failure into five and buries the cause.
 */
export const LOG_LEVEL_GUIDE = {
  fatal: 'the process cannot continue',
  error: 'a request or job failed and someone must look',
  warn: 'recovered, but notable — fallbacks, retries, soft limits',
  info: 'a request completed, a job ran, a state changed',
  debug: 'development detail',
} as const;
