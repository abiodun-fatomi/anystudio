import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WEBHOOK_VERIFY_FUNCTION } from './developer-docs';

// Execute the exact JavaScript customers copy, rather than a separate implementation.
const verify = new Function('createHmac', 'timingSafeEqual', 'Buffer', WEBHOOK_VERIFY_FUNCTION.replace('export ', '') + '; return verify;')(
  createHmac,
  timingSafeEqual,
  Buffer,
) as (body: Buffer, header: unknown, secret: string) => boolean;
const body = Buffer.from('{"id":"evt_test","data":{"id":"generation"}}');
const secret = 'example-secret-not-a-live-key';

/**
 * The clock is frozen, and this file is the reason to freeze one.
 *
 * `now` used to be read once at module load and the out-of-window cases built
 * as `now ± 301` against the receiver's `> 300` tolerance. That leaves exactly
 * one second of headroom, spent by however long the suite takes to reach the
 * assertion — so `now + 301` was only 301 seconds away while less than a
 * second of wall-clock had passed, and drifted to 300 (inside the window,
 * accepted, test red) on any runner slower than that. It went green locally
 * and failed in CI, which is the worst way for a test to be wrong.
 *
 * The stale side never flaked, and that asymmetry is the tell: elapsed time
 * pushes a past timestamp further outside the window and a future one back
 * inside it.
 *
 * Frozen, the boundary is worth asserting rather than merely surviving, so it
 * is asserted on both sides below.
 */
const NOW_MS = 1_780_000_000_000;
const now = NOW_MS / 1000;
beforeAll(() => {
  // Only Date: the receiver reads Date.now(), and faking timers wholesale
  // would be a surprise for anything else that lands in this file later.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterAll(() => vi.useRealTimers());

const signature = (time: number) => `t=${time},v1=${createHmac('sha256', secret).update(`${time}.`).update(body).digest('hex')}`;

describe('copyable webhook receiver', () => {
  it('verifies the raw body, including a valid rotated signature', () => {
    expect(verify(body, signature(now), secret)).toBe(true);
    expect(verify(body, signature(now).replace(',v1=', ',v1=bad,v1='), secret)).toBe(true);
  });

  it('accepts a signature at the edge of the window, in both directions', () => {
    // A customer's server whose clock is a few minutes out must still be able
    // to receive events; that tolerance is the whole point of the check.
    expect(verify(body, signature(now - 300), secret)).toBe(true);
    expect(verify(body, signature(now + 300), secret)).toBe(true);
  });

  it.each([undefined, null, '', 'v1=abc', `t=${now}`, `t=${now},v1=xx`, 't=NaN,v1=abc', 't=Infinity,v1=abc'])(
    'rejects malformed headers without throwing: %s',
    (header) => {
      expect(verify(body, header, secret)).toBe(false);
    },
  );

  it.each([
    ['stale', now - 301],
    // A future timestamp has to be refused as firmly as an old one, or a
    // captured delivery stamped far enough ahead replays for as long as the
    // attacker chose.
    ['ahead of us', now + 301],
  ])('rejects a signature one second past the window (%s)', (_label, time) => {
    expect(verify(body, signature(time), secret)).toBe(false);
  });

  it('rejects tampering and incorrect secrets', () => {
    expect(verify(Buffer.from('{}'), signature(now), secret)).toBe(false);
    expect(verify(body, signature(now), 'wrong')).toBe(false);
  });
});
