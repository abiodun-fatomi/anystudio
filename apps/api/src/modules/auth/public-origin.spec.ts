import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { AuthService } from './auth.service';

/**
 * The header that writes our outgoing links.
 *
 * `publicOrigin` decides the host in the password-reset email, the address
 * verification, the workspace invite, and the Google redirect. It used to
 * accept `x-anystudio-origin` on shape alone — `/^https?:\/\/[a-z0-9.-]+/` —
 * on the reasoning that only our own Next proxy sets that header.
 *
 * The API is its own public Render service on `api.<base>`. Anyone can curl it
 * and set every header themselves; the proxy is not in the path and CORS
 * constrains browsers, not curl. So an attacker who knew a victim's email
 * could have the GENUINE reset mail delivered with a link pointing at their
 * host, and one click handed over a live token.
 *
 * These tests are the allowlist. If someone widens the check again to let a
 * useful-looking host through, this file is what goes red.
 */

const ENV = { APP_ENV: process.env.APP_ENV, ORIGIN_APP: process.env.ORIGIN_APP };

/** Only the three header reads matter here; the service is never constructed. */
const reqWith = (headers: Record<string, string>): Request => ({ get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

const publicOrigin = (headers: Record<string, string>): string =>
  (AuthService.prototype.publicOrigin as (this: unknown, req: Request) => string).call(Object.create(AuthService.prototype), reqWith(headers));

beforeEach(() => {
  process.env.APP_ENV = 'production';
  process.env.ORIGIN_APP = 'https://app.anystudio.ai';
});
afterEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('an origin we recognise is reflected', () => {
  it('takes the forwarded header when it names a surface', () => {
    expect(publicOrigin({ 'x-anystudio-origin': 'https://org.anystudio.ai' })).toBe('https://org.anystudio.ai');
  });

  it('takes the marketing site, where the sign-in pages live', () => {
    expect(publicOrigin({ 'x-anystudio-origin': 'https://anystudio.ai' })).toBe('https://anystudio.ai');
    expect(publicOrigin({ 'x-anystudio-origin': 'https://www.anystudio.ai' })).toBe('https://www.anystudio.ai');
  });

  it('falls back to Origin, then to Referer, and reduces a Referer to its origin', () => {
    expect(publicOrigin({ origin: 'https://admin.anystudio.ai' })).toBe('https://admin.anystudio.ai');
    expect(publicOrigin({ referer: 'https://app.anystudio.ai/reset?token=abc' })).toBe('https://app.anystudio.ai');
  });

  it('keeps each environment to its own hosts', () => {
    process.env.APP_ENV = 'dev';
    expect(publicOrigin({ 'x-anystudio-origin': 'https://app.dev.anystudio.ai' })).toBe('https://app.dev.anystudio.ai');
    // A production host is not ours to link to from the dev deployment.
    expect(publicOrigin({ 'x-anystudio-origin': 'https://app.anystudio.ai' })).toBe('https://app.anystudio.ai');
    process.env.ORIGIN_APP = 'https://app.dev.anystudio.ai';
    expect(publicOrigin({ 'x-anystudio-origin': 'https://app.anystudio.ai' })).toBe('https://app.dev.anystudio.ai');
  });
});

describe('an origin we do not recognise never reaches a link', () => {
  const APP = 'https://app.anystudio.ai';

  it('refuses an attacker host outright', () => {
    expect(publicOrigin({ 'x-anystudio-origin': 'https://evil.tld' })).toBe(APP);
  });

  it('refuses a lookalike that merely contains our domain', () => {
    for (const host of [
      'https://anystudio.ai.evil.tld',
      'https://app.anystudio.ai.evil.tld',
      'https://evil.tld/app.anystudio.ai',
      'https://anystudio-ai.tld',
      'https://xn--anystudo-hza.ai',
    ]) {
      expect(publicOrigin({ 'x-anystudio-origin': host })).toBe(APP);
    }
  });

  it('refuses a port or scheme we never serve on', () => {
    expect(publicOrigin({ 'x-anystudio-origin': 'https://app.anystudio.ai:8443' })).toBe(APP);
    expect(publicOrigin({ 'x-anystudio-origin': 'http://app.anystudio.ai' })).toBe(APP);
  });

  it('refuses credentials smuggled into the authority', () => {
    // `https://app.anystudio.ai@evil.tld` parses with host evil.tld — the old
    // shape check had no opinion about this at all.
    expect(publicOrigin({ 'x-anystudio-origin': 'https://app.anystudio.ai@evil.tld' })).toBe(APP);
  });

  it('refuses a non-http scheme', () => {
    expect(publicOrigin({ 'x-anystudio-origin': 'javascript:alert(1)' })).toBe(APP);
    expect(publicOrigin({ 'x-anystudio-origin': 'data:text/html,<script>' })).toBe(APP);
  });

  it('does not let a bad forwarded header shadow a good Origin', () => {
    expect(publicOrigin({ 'x-anystudio-origin': 'https://evil.tld', origin: 'https://org.anystudio.ai' })).toBe('https://org.anystudio.ai');
  });

  it('refuses every header at once and still returns somewhere of ours', () => {
    expect(publicOrigin({ 'x-anystudio-origin': 'https://evil.tld', origin: 'https://evil.tld', referer: 'https://evil.tld/x' })).toBe(APP);
  });

  it('returns the environment default when nothing is set at all', () => {
    expect(publicOrigin({})).toBe(APP);
    delete process.env.ORIGIN_APP;
    expect(publicOrigin({})).toBe(APP);
  });
});
