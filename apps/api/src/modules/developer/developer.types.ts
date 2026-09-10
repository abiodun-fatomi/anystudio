/**
 * The developer platform's vocabulary: what a key looks like, what it may
 * do, and what an endpoint can be told.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_SCOPES = ['generations:write', 'generations:read', 'media:write', 'catalogue:read', 'balance:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const DEFAULT_SCOPES: ApiScope[] = [...API_SCOPES];

export const WEBHOOK_EVENTS = ['generation.succeeded', 'generation.failed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Endpoints paused after this many failed deliveries in a row. */
export const WEBHOOK_PAUSE_AFTER = 20;
/** Attempts per delivery; backoff doubles from a minute. */
export const WEBHOOK_MAX_ATTEMPTS = 8;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * "as_live_" + 32 base62 characters. The environment word tells a developer
 * at a glance which key they pasted, and lets a secret scanner match the
 * prefix. `test` keys are minted outside production and refused inside it.
 */
export function mintApiKey(env: 'live' | 'test'): { key: string; prefix: string; hash: string } {
  const bytes = randomBytes(32);
  let body = '';
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length];
  const key = `as_${env}_${body}`;
  return { key, prefix: key.slice(0, 16), hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function looksLikeApiKey(v: string): boolean {
  return /^as_(live|test)_[A-Za-z0-9]{32}$/.test(v);
}

/** A webhook signing secret: 32 bytes, hex, prefixed so it is recognisable. */
export function mintWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/**
 * Stripe-style signature: `t=<unix seconds>,v1=<hex hmac of "<t>.<body>">`.
 * The timestamp is in the signed string so a captured delivery cannot be
 * replayed later; receivers should reject anything older than five minutes.
 */
export function signWebhook(secret: string, body: string, at = Math.floor(Date.now() / 1000)): string {
  const hmac = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${hmac}`;
}

/** For tests and for the docs' example receiver. */
export function verifyWebhook(secret: string, body: string, header: string, toleranceSec = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now - t) > toleranceSec || !parts.v1) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
