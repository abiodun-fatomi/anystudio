/**
 * The one HTTP helper every adapter uses.
 *
 * It exists so that error classification happens in one place. A vendor's
 * 429, 5xx, auth failures and request rejection all leave as a ProviderError
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

export const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
// Unknown-length streams briefly exist both as chunks and as the final
// contiguous Uint8Array. 64 MiB therefore caps this helper near 128 MiB,
// leaving room for Node, sharp and the input on a 512 MiB worker.
export const MAX_PROVIDER_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * One deadline linked to the runner's cancellation signal. Call `dispose`
 * only after the response body has been consumed: fetch resolves when the
 * headers arrive, while most of the bytes may still be in flight.
 */
export function linkedTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  message = `timeout after ${timeoutMs}ms`,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason ?? new Error('aborted'));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(message)), Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** What a status code means before the vendor's body is considered. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 402 || status === 403 || status === 404) return 'PROVIDER_DOWN'; // our account, key or model — not the customer's fault
  if (status === 408) return 'RETRYABLE';
  // A remote 4xx is fundamentally different from an INVALID_INPUT raised by
  // our own validation before submission. Its body may describe bad customer
  // media or an adapter-contract defect, but it is non-retryable either way.
  // Calling another paid vendor would turn that ambiguity into duplicate cost.
  if (status >= 400 && status < 500) return 'REQUEST_REJECTED';
  if (status >= 500) return 'RETRYABLE';
  return 'RETRYABLE';
}

export async function http<T = unknown>(providerKey: string, url: string, opts: HttpOpts): Promise<HttpResponse<T>> {
  const linked = linkedTimeoutSignal(opts.signal, opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body || opts.bytes ? 'POST' : 'GET'),
      headers: {
        ...(opts.bytes ? {} : { 'content-type': 'application/json' }),
        accept: 'application/json',
        ...opts.headers,
      },
      body: opts.bytes ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      signal: linked.signal,
    });
    const text = new TextDecoder().decode(await readLimitedResponseBytes(providerKey, res, MAX_PROVIDER_JSON_BYTES, 'response body'));
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      throw new ProviderError(kindForStatus(res.status), `${providerKey}: HTTP ${res.status} from ${redact(url)}: ${text.slice(0, 500)}`, providerKey, {
        status: res.status,
        raw: json ?? text.slice(0, 2000),
      });
    }
    return { status: res.status, json: json as T, text, headers: res.headers };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderError('RETRYABLE', `${providerKey}: network error calling ${redact(url)}: ${message}`, providerKey);
  } finally {
    linked.dispose();
  }
}

/** Fetch a vendor's output file. Vendor URLs expire; call this immediately. */
export async function fetchBytes(
  providerKey: string,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxBytes = MAX_PROVIDER_OUTPUT_BYTES,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const linked = linkedTimeoutSignal(signal, timeoutMs, `download timeout after ${timeoutMs}ms`);
  try {
    const res = await fetch(url, { signal: linked.signal });
    if (!res.ok) {
      throw new ProviderError(kindForStatus(res.status), `${providerKey}: could not fetch output (${res.status})`, providerKey, { status: res.status });
    }
    return {
      bytes: await readLimitedResponseBytes(providerKey, res, maxBytes, 'output download'),
      mime: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('RETRYABLE', `${providerKey}: could not fetch output: ${err instanceof Error ? err.message : err}`, providerKey);
  } finally {
    linked.dispose();
  }
}

/** Consume a body incrementally and stop before an untrusted vendor can OOM the worker. */
export async function readLimitedResponseBytes(providerKey: string, res: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError('RETRYABLE', `${providerKey}: ${what} is larger than the ${maxBytes}-byte safety limit`, providerKey);
  }
  if (!res.body) return new Uint8Array();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError('RETRYABLE', `${providerKey}: ${what} is larger than the ${maxBytes}-byte safety limit`, providerKey);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
    await abortableDelay(opts.intervalMs, opts.signal);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
