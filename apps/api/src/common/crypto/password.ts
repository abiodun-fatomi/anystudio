/**
 * Passwords.
 *
 * Argon2id, with the OWASP-recommended floor. The parameters are deliberately
 * explicit rather than the library defaults, so a future library upgrade cannot
 * quietly weaken them.
 */

import * as argon2 from 'argon2';

const PARAMS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * A hash to compare against when the account does not exist.
 *
 * Verifying a password takes ~50ms; skipping the verify because the user was
 * not found takes ~0ms. That gap tells an attacker which emails are real. So
 * unknown accounts get a real verify against a throwaway hash, and every login
 * attempt costs the same whether the account exists or not.
 */
let DUMMY_HASH: string | undefined;

/** Hashes a new password. Never stores or logs the plaintext. */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, PARAMS);
}

/**
 * Verifies a password with uniform timing.
 *
 * Pass `hash` as null for an account that does not exist; the work is done
 * anyway and the answer is always false.
 */
export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (hash === null) {
    DUMMY_HASH ??= await argon2.hash('anystudio-dummy-password-for-timing', PARAMS);
    await argon2.verify(DUMMY_HASH, plain).catch(() => false);
    return false;
  }
  return argon2.verify(hash, plain).catch(() => false);
}

/** True if the stored hash was made with weaker parameters and should be redone. */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, PARAMS);
}
