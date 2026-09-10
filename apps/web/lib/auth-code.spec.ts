/**
 * What an authentication box will let you type.
 *
 * The bug that started this: the login challenge accepted `063296jjj`
 * happily and then told the merchant the code did not match. But the
 * obvious fix — "auth codes are six digits, clamp them all" — is wrong on
 * three of the five boxes in this app, because `verifyAnyFactor` on the
 * server also takes an eight-character RECOVERY code. Clamping those would
 * remove the recovery path from someone who has already lost their phone,
 * which is the single moment it exists for.
 *
 * So these tests are really about that distinction holding.
 */
import { describe, expect, it } from 'vitest';
import { cleanCode } from './auth-code';

describe('a box that only ever takes a TOTP code', () => {
  it('drops letters — the login challenge checks the secret and nothing else', () => {
    expect(cleanCode('063296jjj', 'totp')).toBe('063296');
  });

  it('stops at six, however much is pasted', () => {
    expect(cleanCode('12345678', 'totp')).toBe('123456');
  });

  it('cleans a code pasted with a space in it rather than rejecting it', () => {
    expect(cleanCode('063 296', 'totp')).toBe('063296');
  });

  it('leaves a good code exactly alone', () => {
    expect(cleanCode('063296', 'totp')).toBe('063296');
  });
});

describe('a box that also takes a recovery code', () => {
  it('keeps letters, because a recovery code is eight characters of them', () => {
    expect(cleanCode('K7M2QRPT', 'either')).toBe('K7M2QRPT');
  });

  it('upper-cases and strips dashes, matching how the server compares', () => {
    // The server does code.replace(/[\s-]/g, '').toUpperCase().
    expect(cleanCode('k7m2-qrpt', 'either')).toBe('K7M2QRPT');
  });

  it('still lets a plain six-digit code through', () => {
    expect(cleanCode('063296', 'either')).toBe('063296');
  });

  it('stops at eight, which is the recovery-code length', () => {
    expect(cleanCode('K7M2QRPTZZZZ', 'either')).toBe('K7M2QRPT');
  });

  it('does NOT clamp a recovery code to six — that would be the lockout', () => {
    expect(cleanCode('K7M2QRPT', 'either')).not.toBe('K7M2QR');
  });
});
