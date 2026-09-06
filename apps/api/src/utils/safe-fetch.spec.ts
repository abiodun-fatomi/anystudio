import { describe, expect, it } from 'vitest';
import { assertPublicHost, isPrivateAddress, UnsafeUrlError } from './safe-fetch';

describe('safe-fetch', () => {
  it('knows a private address when it sees one', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.9',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fd00::1',
      'fe80::1',
      '224.0.0.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses the obvious hosts before resolving anything', async () => {
    for (const u of [
      'http://example.com/x',
      'https://localhost/',
      'https://[::1]/',
      'https://169.254.169.254/latest',
      'https://shop.internal/',
      'https://x.local/',
    ])
      await expect(assertPublicHost(new URL(u)), u).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
