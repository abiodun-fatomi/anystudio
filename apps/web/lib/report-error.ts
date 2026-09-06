/**
 * Browser error reporting, without a 60 KB SDK in the Workers bundle.
 *
 * Sentry's ingest endpoint takes an "envelope": two lines of JSON headers
 * and one event. That is all a crash report needs — the exception, where it
 * happened, which release and environment — so this file writes it by hand
 * and posts it with a keepalive fetch. With NEXT_PUBLIC_SENTRY_DSN unset,
 * every call returns at once and nothing leaves the page.
 *
 * What is sent: the error's name, message and stack, the page path (never
 * the query string), the release and environment, and a few words of
 * context from the caller. Never: form contents, tokens, user identity.
 */
const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? '';
const RELEASE = process.env.NEXT_PUBLIC_RELEASE ?? undefined;
const MAX_PER_LOAD = 5;

interface Target {
  endpoint: string;
  key: string;
  dsn: string;
}

function parse(dsn: string): Target | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, '');
    if (!u.username || !projectId) return null;
    return { endpoint: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, key: u.username, dsn };
  } catch {
    return null;
  }
}

const target = DSN ? parse(DSN) : null;
let sent = 0;
const seen = new Set<string>();

/** dev./staging. hosts name their environment; everything else is production, and localhost is local. */
function environment(host: string): string {
  if (/^(localhost|127\.0\.0\.1)/.test(host)) return 'local';
  const m = /(?:^|\.)(dev|staging)\.anystudio\.ai$/.exec(host);
  return m?.[1] === 'dev' ? 'development' : (m?.[1] ?? 'production');
}

function uuid(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function frames(stack: string | undefined) {
  if (!stack) return undefined;
  const out: { filename: string; function: string; lineno?: number; colno?: number }[] = [];
  for (const line of stack.split('\n').slice(0, 30)) {
    const m = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line) ?? /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line);
    if (m) out.push({ function: m[1] || '<anonymous>', filename: m[2]!, lineno: Number(m[3]), colno: Number(m[4]) });
  }
  // Sentry wants the oldest frame first.
  return out.length ? { frames: out.reverse() } : undefined;
}

export interface ReportContext {
  /** Where it surfaced: 'app-error', 'root-error', 'window', 'promise'. */
  where: string;
  /** Next's error digest, when there is one — it is what support asks for. */
  digest?: string;
  tags?: Record<string, string>;
}

/** Send one error. Safe to call anywhere in the browser; a no-op on the server and without a DSN. */
export function reportError(error: unknown, ctx: ReportContext): void {
  if (!target || typeof window === 'undefined') return;
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-error thrown');
  const fingerprint = `${err.name}:${err.message}:${ctx.where}`;
  if (sent >= MAX_PER_LOAD || seen.has(fingerprint)) return;
  seen.add(fingerprint);
  sent += 1;

  const event = {
    event_id: uuid(),
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    environment: environment(window.location.hostname),
    release: RELEASE,
    tags: { where: ctx.where, ...(ctx.digest ? { digest: ctx.digest } : {}), ...(ctx.tags ?? {}) },
    request: { url: `${window.location.origin}${window.location.pathname}`, headers: { 'User-Agent': navigator.userAgent } },
    exception: { values: [{ type: err.name, value: err.message.slice(0, 1000), stacktrace: frames(err.stack) }] },
  };
  const body = [
    JSON.stringify({ event_id: event.event_id, dsn: target.dsn, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
  try {
    void fetch(`${target.endpoint}?sentry_key=${target.key}&sentry_version=7`, {
      method: 'POST',
      body,
      keepalive: true,
      mode: 'cors',
      credentials: 'omit',
      headers: { 'content-type': 'application/x-sentry-envelope' },
    }).catch(() => undefined);
  } catch {
    // A reporter must never be the thing that crashes.
  }
}

/** True when a DSN is configured, so callers can skip work. */
export const errorReportingOn = target !== null;
