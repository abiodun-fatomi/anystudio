/**
 * TOTP, for the second factor.
 *
 * A window of one step either side tolerates clock drift on a phone without
 * making brute force meaningfully easier: six digits with a 90-second window is
 * still one-in-333k per guess, and the rate limiter caps guesses.
 */

import { authenticator } from 'otplib';

authenticator.options = { window: 1, step: 30, digits: 6 };

/** A fresh base32 seed for enrolment. Store it encrypted; never log it. */
export function newSeed(): string {
  return authenticator.generateSecret(20);
}

/** The otpauth:// URI the user's authenticator app scans. */
export function enrolmentUri(seed: string, accountLabel: string): string {
  return authenticator.keyuri(accountLabel, 'AnyStudio', seed);
}

/** Checks a six-digit code against a seed. */
export function verifyCode(seed: string, code: string): boolean {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  return authenticator.verify({ token: clean, secret: seed });
}
