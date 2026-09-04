/**
 * One vocabulary for everything that happens to an account.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before it, the auth flows logged their failures and almost none of their
 * successes — so the log could tell you that something went wrong but never
 * what a person had been doing when it did. At 2am the question is rarely
 * "did an error occur"; it is "what happened to this account, in order".
 * That needs the ordinary steps recorded too, in a shape you can filter on.
 *
 * Every line carries the same fields, so `event` and `outcome` are groupable
 * and `requestId` stitches a request across services. The narrative is
 * readable straight out of the log:
 *
 *   auth.register  succeeded  requestId=… userId=…
 *   auth.verify    refused    reason=invalid_token
 *   auth.verify    succeeded  userId=…
 *   auth.login     refused    reason=bad_credentials  ip=…
 *   auth.login     succeeded  userId=… surface=APP mfa=1
 *
 * WHAT NEVER APPEARS HERE
 * -----------------------
 * Passwords, tokens, codes, cookies, session ids. The logger's redaction is a
 * safety net, not permission to pass them — nothing in this file's call sites
 * puts a credential in a field. Email addresses are masked by the redactor,
 * so `userId` is the identifier worth carrying.
 *
 * LEVELS
 * ------
 * succeeded → info    the ordinary story
 * refused   → warn    the system working: bad password, expired link, wrong
 *                     surface. Warn rather than info because a burst of
 *                     refusals is the shape of an attack, and that shape is
 *                     what you want to alert on.
 * failed    → error   our fault: the mail provider is down, the database
 *                     refused a write. Someone has to do something.
 */

import type { Request } from 'express';
import { logger } from '../../../config/logger';

export type AuthEventName =
  | 'auth.register'
  | 'auth.login'
  | 'auth.mfa'
  | 'auth.step_up'
  | 'auth.forgot'
  | 'auth.reset'
  | 'auth.verify'
  | 'auth.verify_resend'
  | 'auth.google'
  | 'auth.refresh'
  | 'auth.signout'
  // Account settings — same vocabulary, so one query finds a person's whole story.
  | 'account.reauth'
  | 'account.profile'
  | 'account.email_change'
  | 'account.password'
  | 'account.mfa'
  | 'account.recovery_codes'
  | 'account.sessions'
  | 'account.identity'
  | 'account.notifications'
  | 'account.export'
  | 'account.delete'
  | 'member.invite'
  | 'member.accept'
  | 'member.role'
  | 'member.remove'
  | 'member.transfer'
  | 'workspace.update'
  | 'workspace.delete'
  | 'billing.checkout'
  | 'billing.verify'
  | 'billing.cancel';

export type AuthOutcome = 'succeeded' | 'refused' | 'failed';

export interface AuthLogFields {
  /** Why it was refused, or what failed. A short stable slug, never a sentence. */
  reason?: string;
  userId?: string;
  surface?: string;
  /** Which factor level the resulting session carries, where one was minted. */
  mfa?: number;
  /** Free-form extras — must not contain anything secret. */
  [key: string]: unknown;
}

/**
 * Record one step of an auth flow.
 *
 * `req` is optional so the sweeper and other non-HTTP callers can use the same
 * vocabulary rather than inventing a second one.
 */
export function authLog(
  event: AuthEventName,
  outcome: AuthOutcome,
  fields: AuthLogFields = {},
  req?: Request,
): void {
  const line = {
    event,
    outcome,
    ...(req ? { requestId: req.requestId, ip: req.ip } : {}),
    ...fields,
  };

  const message = `${event} ${outcome}`;
  if (outcome === 'succeeded') logger.info(line, message);
  else if (outcome === 'refused') logger.warn(line, message);
  else logger.error(line, message);
}
