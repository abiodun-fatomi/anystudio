import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBytes, http, kindForStatus, MAX_PROVIDER_JSON_BYTES } from './http';

describe('provider HTTP error classification', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [400, 'REQUEST_REJECTED'],
    [413, 'REQUEST_REJECTED'],
    [415, 'REQUEST_REJECTED'],
    [422, 'REQUEST_REJECTED'],
    [401, 'PROVIDER_DOWN'],
    [402, 'PROVIDER_DOWN'],
    [404, 'PROVIDER_DOWN'],
    [408, 'RETRYABLE'],
    [429, 'RATE_LIMITED'],
    [503, 'RETRYABLE'],
  ] as const)('maps HTTP %s to %s', (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
  });

  it('marks a remote 422 distinctly from a locally detected adapter defect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'unsupported source media' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(http('paid:vendor', 'https://vendor.test/generate', { body: { prompt: 'x' }, timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: 'REQUEST_REJECTED',
      providerKey: 'paid:vendor',
      meta: { status: 422, raw: { detail: 'unsupported source media' } },
    });
  });

  it('keeps the timeout and parent abort active while consuming the response body', async () => {
    const parent = new AbortController();
    let observed: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      observed = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            observed?.addEventListener('abort', () => controller.error(observed?.reason), { once: true });
          },
        }),
      );
    });
    const request = http('paid:vendor', 'https://vendor.test/generate', { timeoutMs: 10_000, signal: parent.signal });

    parent.abort(new Error('runner cancelled'));

    await expect(request).rejects.toMatchObject({ kind: 'RETRYABLE', message: expect.stringContaining('runner cancelled') });
    expect(observed?.aborted).toBe(true);
  });

  it('rejects an oversized JSON body from Content-Length before buffering it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('small lie', { headers: { 'content-length': String(MAX_PROVIDER_JSON_BYTES + 1) } }));

    await expect(http('paid:vendor', 'https://vendor.test/generate', { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: 'RETRYABLE',
      message: expect.stringContaining('safety limit'),
    });
  });

  it('stops a chunked output body when it crosses the configured byte cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4, 5])));

    await expect(fetchBytes('paid:vendor', 'https://vendor.test/output', 1_000, undefined, 4)).rejects.toMatchObject({
      kind: 'RETRYABLE',
      message: expect.stringContaining('4-byte safety limit'),
    });
  });
});
