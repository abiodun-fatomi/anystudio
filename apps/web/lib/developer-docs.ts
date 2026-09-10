/** The exact JavaScript displayed in the portal, executed by its contract tests. */
export const WEBHOOK_VERIFY_FUNCTION = `export function verify(rawBody, header, secret) {
  if (!header || typeof header !== 'string') return false;
  const parts = header.split(',').map((part) => part.trim());
  const ts = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!ts || !/^\\d+$/.test(ts)) return false;
  const time = Number(ts);
  if (!Number.isSafeInteger(time) || time <= 0 || Math.abs(Date.now() / 1000 - time) > 300) return false;
  const expected = createHmac('sha256', secret).update(ts + '.').update(rawBody).digest();
  return signatures.some((signature) => /^[0-9a-f]{64}$/i.test(signature) &&
    timingSafeEqual(Buffer.from(signature, 'hex'), expected));
}`;

export const WEBHOOK_VERIFY_EXAMPLE = `import { createHmac, timingSafeEqual } from 'node:crypto';

${WEBHOOK_VERIFY_FUNCTION}

// Pass the untouched request Buffer (for example, Express express.raw()).
// Verify BEFORE JSON.parse. Reject bad signatures with 401.
// Persist/enqueue the event durably, deduplicate by payload.id, then return 2xx.
// GET /generations/{id} refreshes output URLs if a queued delivery is old.`;
