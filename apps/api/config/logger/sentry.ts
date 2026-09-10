/**
 * Error tracking, behind one optional variable.
 *
 * With SENTRY_DSN unset nothing here does anything — no SDK is started, no
 * network is touched, and every export is a no-op. With it set, every
 * logger.error / logger.fatal call that carries an `err` is also sent to
 * Sentry with the same context the log line has (request id, user id,
 * workspace id, job id…), so the two tell one story and the Sentry issue
 * links straight back to the log search.
 *
 * What is never sent: request bodies, uploads, prompts, tokens. The log
 * redaction paths apply to the context we forward, and the SDK is told not
 * to attach request data on its own.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
let enabled = false;

export function initSentry(service: string): boolean {
  if (!dsn || enabled) return enabled;
  Sentry.init({
    dsn,
    environment: process.env.APP_ENV ?? 'local',
    release: (process.env.GIT_SHA ?? process.env.RENDER_GIT_COMMIT)?.slice(0, 7),
    serverName: service,
    // Errors only. Traces would double the bill for a picture the logs already paint.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    maxBreadcrumbs: 20,
    initialScope: { tags: { service } },
  });
  enabled = true;
  return enabled;
}

const CONTEXT_KEYS = [
  'requestId',
  'userId',
  'workspaceId',
  'generationId',
  'jobId',
  'invoiceId',
  'paymentId',
  'storeId',
  'path',
  'method',
  'step',
  'provider',
] as const;

/** Called by the logger for every error-level line. */
export function captureFromLog(obj: Record<string, unknown>, msg: string | undefined): void {
  if (!enabled) return;
  const err = obj.err;
  const tags: Record<string, string> = {};
  for (const k of CONTEXT_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' || typeof v === 'number') tags[k] = String(v);
  }
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    if (typeof obj.userId === 'string') scope.setUser({ id: obj.userId });
    if (msg) scope.setTag('log', msg.slice(0, 120));
    if (err instanceof Error) Sentry.captureException(err);
    else Sentry.captureMessage(msg ?? 'error', 'error');
  });
}

/** Give in-flight events a moment on shutdown. */
export async function flushSentry(): Promise<void> {
  if (enabled) await Sentry.flush(2000).catch(() => undefined);
}
