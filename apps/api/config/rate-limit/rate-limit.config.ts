/**
 * Rate limits, declared next to nothing else so they can be reviewed in one
 * screen. Keys are `<method> <route>`; windows are seconds.
 *
 * Three scopes, because the org API and the human portals are attacked
 * differently: an organization's key gets a per-key quota that is a
 * commercial term, a merchant behind that key gets a per-merchant fair-use
 * limit, and the human endpoints get per-IP and per-account brakes tuned to
 * how fast a person can legitimately act.
 *
 * Enforcement is a Redis token bucket in the guard that reads this table.
 * Until that guard lands, Cloudflare's WAF rule on /auth/* is the only limit
 * in force — and this file is the spec it will be built to.
 */

export type RateScope = 'ip' | 'account' | 'apiKey' | 'merchant';

export interface RateRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  scope: RateScope;
}

export const RATE_LIMITS: Record<string, RateRule[]> = {
  'POST /api/v1/auth/login':          [{ limit: 5, windowSec: 60, scope: 'ip' }, { limit: 10, windowSec: 3600, scope: 'account' }],
  'POST /api/v1/auth/login/mfa':      [{ limit: 10, windowSec: 300, scope: 'ip' }],
  'POST /api/v1/auth/register':       [{ limit: 3, windowSec: 3600, scope: 'ip' }],
  'POST /api/v1/auth/forgot':         [{ limit: 3, windowSec: 3600, scope: 'ip' }, { limit: 3, windowSec: 3600, scope: 'account' }],
  'POST /api/v1/auth/reset':          [{ limit: 5, windowSec: 3600, scope: 'ip' }],
  'POST /api/v1/auth/verify':         [{ limit: 10, windowSec: 3600, scope: 'ip' }],
  'POST /api/v1/auth/verify/resend':  [{ limit: 3, windowSec: 3600, scope: 'account' }],
  'GET /api/v1/auth/google/start':    [{ limit: 10, windowSec: 60, scope: 'ip' }],
  'POST /api/v1/auth/step-up':        [{ limit: 5, windowSec: 300, scope: 'account' }],
  // Account settings: each of these re-proves a credential, and a wrong guess is a guess.
  'POST /api/v1/me/email':            [{ limit: 5, windowSec: 3600, scope: 'account' }],
  'POST /api/v1/me/email/confirm':    [{ limit: 10, windowSec: 3600, scope: 'ip' }],
  'POST /api/v1/me/password':         [{ limit: 5, windowSec: 900, scope: 'account' }],
  'POST /api/v1/me/mfa/confirm':      [{ limit: 10, windowSec: 300, scope: 'account' }],
  'DELETE /api/v1/me/mfa':            [{ limit: 5, windowSec: 900, scope: 'account' }],
  'POST /api/v1/me/mfa/recovery-codes': [{ limit: 5, windowSec: 900, scope: 'account' }],
  'POST /api/v1/me/delete':           [{ limit: 5, windowSec: 3600, scope: 'account' }],
  'GET /api/v1/me/export':            [{ limit: 5, windowSec: 3600, scope: 'account' }],
  'POST /api/v1/workspaces/invites/accept': [{ limit: 10, windowSec: 3600, scope: 'ip' }],
  // Webhooks arrive in bursts from a handful of gateway IPs; the default per-IP ceiling would drop real events.
  'POST /api/v1/billing/webhooks/flutterwave': [{ limit: 3000, windowSec: 60, scope: 'ip' }],
  'POST /api/v1/billing/webhooks/paddle':      [{ limit: 3000, windowSec: 60, scope: 'ip' }],
  // Organization API (issued keys), per key and per merchant behind the key.
  'POST /api/v1/generations':         [{ limit: 60, windowSec: 60, scope: 'apiKey' }, { limit: 10, windowSec: 60, scope: 'merchant' }],
  'POST /api/v1/uploads/from-url':    [{ limit: 60, windowSec: 60, scope: 'apiKey' }],
  'POST /api/v1/uploads':             [{ limit: 120, windowSec: 60, scope: 'apiKey' }],
  'GET /api/v1/generations':          [{ limit: 300, windowSec: 60, scope: 'apiKey' }],
  // Portal: minting keys and endpoints is rare by nature.
  'POST /api/v1/workspaces/:workspaceId/developer/keys':     [{ limit: 10, windowSec: 3600, scope: 'account' }],
  'POST /api/v1/workspaces/:workspaceId/developer/webhooks': [{ limit: 10, windowSec: 3600, scope: 'account' }],
  // The help chat: each message costs a model call.
  'POST /api/v1/support/conversations':              [{ limit: 10, windowSec: 3600, scope: 'account' }],
  'POST /api/v1/support/conversations/:id/messages': [{ limit: 20, windowSec: 60, scope: 'account' }, { limit: 200, windowSec: 86400, scope: 'account' }],
  // Meta retries aggressively and from many IPs.
  'POST /api/v1/whatsapp/webhook':    [{ limit: 6000, windowSec: 60, scope: 'ip' }],
};

/** Default for anything not listed: a per-IP ceiling that only a script hits. */
export const DEFAULT_RATE_RULE: RateRule = { limit: 300, windowSec: 60, scope: 'ip' };
