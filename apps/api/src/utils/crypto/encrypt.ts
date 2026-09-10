/**
 * Encryption at rest for small secrets — TOTP seeds, provider credentials.
 *
 * AES-256-GCM under APP_KEY. GCM authenticates as well as encrypts, so a
 * tampered ciphertext fails to decrypt rather than decrypting to garbage.
 * Rotating APP_KEY without re-encrypting locks every staff account out of MFA;
 * that is why .env.example says so in capitals.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(): Buffer {
  const raw = process.env.APP_KEY;
  if (!raw) throw new Error('APP_KEY is not set');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('APP_KEY must be 32 bytes base64 (openssl rand -base64 32)');
  return k;
}

/**
 * Prove the key is usable, at boot.
 *
 * Without this the first encrypt is what discovers a bad APP_KEY — so a
 * misconfigured deployment goes green, passes its health check, and then
 * fails on someone's first sign-in with a 500 and no obvious cause. The API
 * already refuses to start without CORS origins; a key it cannot encrypt
 * with belongs in the same category.
 */
export function assertAppKey(): void {
  key();
}

/** Encrypts to a compact `iv.tag.ciphertext` string, all base64url. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

/** Reverses encrypt(). Throws on tampering or the wrong key. */
export function decrypt(packed: string): string {
  const [iv, tag, enc] = packed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !enc) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
