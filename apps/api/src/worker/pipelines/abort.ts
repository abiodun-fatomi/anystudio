/**
 * A best-effort pipeline fallback must never turn cancellation into success.
 *
 * Some adapters preserve the platform AbortError while others may surface a
 * different error after their shared signal has already been aborted. Cover
 * both cases before a catch degrades to an optional path or an earlier result.
 */
export function rethrowIfAborted(signal: AbortSignal, err: unknown): void {
  if (signal.aborted) throw signal.reason ?? err;
  if (isAbortError(err)) throw err;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'AbortError';
}
