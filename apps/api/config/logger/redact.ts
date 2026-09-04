/**
 * Log redaction.
 *
 * Two layers, because a named list alone always misses something eventually.
 * Layer one is pino's own path-based stripping, which is fast and covers the
 * fields we know about. Layer two is a recursive scrub for anything the list
 * did not predict — a new field called `providerSecret` should not need a code
 * change to stop leaking.
 */

/** Layer 1 — exact paths pino removes before serialising. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  '*.password',
  '*.passwordHash',
  '*.secret',
  '*.secretEnc',
  '*.token',
  '*.refreshToken',
  '*.sessionToken',
  '*.otp',
  '*.code',
  '*.cardNumber',
  // A signed R2 URL IS a credential — anyone holding it can fetch the object.
  // Log the object key instead.
  '*.signedUrl',
  'req.body.imageBase64',
];

/** Layer 2 — any key matching this is replaced wherever it appears, at any depth. */
const SENSITIVE_KEY =
  /secret|token|password|passwd|api[-_]?key|authorization|credential|otp|cvv|pan|signed_?url/i;

const PHONE = /(\+\d{1,3})(\d+)(\d{4})/g;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/**
 * Identifiers are kept useful rather than deleted outright — support has to be
 * able to match a log line to a customer without the log becoming a contact
 * database.
 *
 *   +2348012345678  →  +234****5678
 *   ada@shop.ng     →  a**@shop.ng
 */
export function scrubText(value: string): string {
  return value
    .replace(PHONE, (_m, cc, mid, last) => `${cc}${'*'.repeat(Math.min(mid.length, 4))}${last}`)
    .replace(EMAIL, (_m, first, domain) => `${first}**@${domain}`);
}

/**
 * Recursive scrub applied to anything we log by hand — prompts especially.
 *
 * Prompts MUST be logged: they are how a bad generation gets diagnosed. But a
 * customer types whatever they like into one, including their own phone number
 * and address, so the scrub runs over prompt text as well as structured fields.
 */
export function deepScrub(input: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (typeof input === 'string') return scrubText(input);
  if (Array.isArray(input)) return input.map((v) => deepScrub(v, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : deepScrub(v, depth + 1);
    }
    return out;
  }
  return input;
}
