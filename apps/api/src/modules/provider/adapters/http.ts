/**
 * The one HTTP helper every adapter uses.
 *
 * It exists so that error classification happens in one place. A vendor's
 * 429, 5xx, 401 and policy refusal all land here and leave as a ProviderError
 * with a kind the pipeline can act on. Adapters add vendor-specific mapping
 * on top (a 200 whose body says "rejected"), never below.
 *
 * Native fetch: no SDKs. Each vendor SDK pulls its own HTTP stack, retry
 * policy and logging into the image, and none of them agree with ours.
 */

import { ProviderError, type ProviderErrorKind } from '@anystudio/shared';

export interface HttpOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw bytes for uploads; wins over body. */
  bytes?: Uint8Array;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  json: T;
  text: string;
  headers: Headers;
}

/** What a status code means before the vendor's body is considered. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403 || status === 404) return 'PROVIDER_DOWN'; // our key, their model — not the customer's fault
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'INVALID_INPUT';
  if (status >= 500) return 'RETRYABLE';
  return 'RETRYABLE';
}

export async function http<T = unknown>(providerKey: string, url: string, opts: HttpOpts): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs);
  opts.signal?.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body || opts.bytes ? 'POST' : 'GET'),
      headers: {
        ...(opts.bytes ? {} : { 'content-type': 'application/json' }),
        accept: 'application/json',
        ...opts.headers,
      },
      body: opts.bytes ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderError('RETRYABLE', `${providerKey}: network error calling ${redact(url)}: ${message}`, providerKey);
  }
  clearTimeout(timer);

  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    throw new ProviderError(
      kindForStatus(res.status),
      `${providerKey}: HTTP ${res.status} from ${redact(url)}: ${text.slice(0, 500)}`,
      providerKey,
      { status: res.status, raw: json ?? text.slice(0, 2000) },
    );
  }
  return { status: res.status, json: json as T, text, headers: res.headers };
}

/** Fetch a vendor's output file. Vendor URLs expire; call this immediately. */
export async function fetchBytes(providerKey: string, url: string, timeoutMs: number): Promise<{ bytes: Uint8Array; mime: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new ProviderError(kindForStatus(res.status), `${providerKey}: could not fetch output (${res.status})`, providerKey, { status: res.status });
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('RETRYABLE', `${providerKey}: could not fetch output: ${err instanceof Error ? err.message : err}`, providerKey);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for an async vendor job. `check` returns the result when finished,
 * null while running, or throws a ProviderError. Reports progress so the
 * generation's heartbeat stays fresh for the whole wait.
 */
export async function poll<T>(
  check: () => Promise<T | null>,
  opts: { intervalMs: number; timeoutMs: number; onTick?: (elapsedMs: number) => void; signal?: AbortSignal },
): Promise<T> {
  const started = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const result = await check();
    if (result !== null) return result;
    const elapsed = Date.now() - started;
    if (elapsed > opts.timeoutMs) throw new Error(`vendor job did not finish within ${opts.timeoutMs}ms`);
    opts.onTick?.(elapsed);
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

/** Keys and tokens never belong in a log line, even inside a URL. */
function redact(url: string): string {
  return url.replace(/([?&](key|api_key|token|access_token)=)[^&]+/gi, '$1[redacted]');
}

/** Small helper to read a nested value from an untyped vendor response. */
export function pick<T = unknown>(obj: unknown, path: string): T | undefined {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur as T | undefined;
}
