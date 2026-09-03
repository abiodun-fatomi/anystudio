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
  // Organization API (issued keys), per key and per merchant behind the key.
  'POST /api/v1/generations':         [{ limit: 60, windowSec: 60, scope: 'apiKey' }, { limit: 10, windowSec: 60, scope: 'merchant' }],
};

/** Default for anything not listed: a per-IP ceiling that only a script hits. */
export const DEFAULT_RATE_RULE: RateRule = { limit: 300, windowSec: 60, scope: 'ip' };
