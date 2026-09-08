import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_VERIFY_FUNCTION } from './developer-docs';

// Execute the exact JavaScript customers copy, rather than a separate implementation.
const verify = new Function('createHmac', 'timingSafeEqual', 'Buffer', WEBHOOK_VERIFY_FUNCTION.replace('export ', '') + '; return verify;')(
  createHmac,
  timingSafeEqual,
  Buffer,
) as (body: Buffer, header: unknown, secret: string) => boolean;
const body = Buffer.from('{"id":"evt_test","data":{"id":"generation"}}');
const secret = 'example-secret-not-a-live-key';
const now = Math.floor(Date.now() / 1000);
const signature = (time: number) => `t=${time},v1=${createHmac('sha256', secret).update(`${time}.`).update(body).digest('hex')}`;

describe('copyable webhook receiver', () => {
  it('verifies the raw body, including a valid rotated signature', () => {
    expect(verify(body, signature(now), secret)).toBe(true);
    expect(verify(body, signature(now).replace(',v1=', ',v1=bad,v1='), secret)).toBe(true);
  });
  it.each([undefined, null, '', 'v1=abc', `t=${now}`, `t=${now},v1=xx`, 't=NaN,v1=abc', 't=Infinity,v1=abc', signature(now - 301), signature(now + 301)])(
    'rejects malformed or stale headers without throwing: %s',
    (header) => {
      expect(verify(body, header, secret)).toBe(false);
    },
  );
  it('rejects tampering and incorrect secrets', () => {
    expect(verify(Buffer.from('{}'), signature(now), secret)).toBe(false);
    expect(verify(body, signature(now), 'wrong')).toBe(false);
  });
});
