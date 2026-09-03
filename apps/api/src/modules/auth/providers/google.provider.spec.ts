import { describe, expect, it, beforeAll } from 'vitest';
import { GoogleProvider } from './google.provider';

// The provider only touches the database in resolveUser, which is not under
// test here; a bare object is enough for the handshake helpers.
const provider = () => new GoogleProvider({} as never);

describe('GoogleProvider handshake', () => {
  beforeAll(() => { process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com'; });

  it('derives the callback from the origin that started the flow', () => {
    expect(provider().redirectUri('https://app.dev.anystudio.ai')).toBe('https://app.dev.anystudio.ai/api/v1/auth/google/callback');
  });

  it('sends state, nonce and an S256 challenge, and can read its own cookie back', () => {
    const p = provider();
    const { url, cookie } = p.begin('https://app.anystudio.ai', 'APP', '/today');
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    const state = p.readState(cookie);
    expect(state).not.toBeNull();
    expect(state?.s).toBe(u.searchParams.get('state'));
    expect(state?.n).toBe(u.searchParams.get('nonce'));
    expect(state?.f).toBe('APP');
    expect(state?.r).toBe('/today');
  });

  it('refuses a return path that would leave the app', () => {
    const p = provider();
    expect(p.readState(p.begin('https://app.anystudio.ai', 'APP', '//evil.example').cookie)?.r).toBe('/');
    expect(p.readState(p.begin('https://app.anystudio.ai', 'APP', 'https://evil.example').cookie)?.r).toBe('/');
  });

  it('treats a tampered or foreign cookie as absent', () => {
    const p = provider();
    expect(p.readState('not-a-cookie')).toBeNull();
    // Flip a byte inside the ciphertext: GCM's tag must reject it outright.
    const { cookie } = p.begin('https://a', 'APP', '/');
    const [iv, tag, ct] = cookie.split('.') as [string, string, string];
    const flipped = ct.slice(0, 5) + (ct[5] === 'A' ? 'B' : 'A') + ct.slice(6);
    expect(p.readState([iv, tag, flipped].join('.'))).toBeNull();
  });

  it('compares state in constant time and by value', () => {
    expect(GoogleProvider.matches('abc', 'abc')).toBe(true);
    expect(GoogleProvider.matches('abc', 'abd')).toBe(false);
    expect(GoogleProvider.matches('abc', 'ab')).toBe(false);
  });
});
