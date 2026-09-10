/**
 * Enforce the table in rate-limit.config.ts.
 *
 * Runs on every request, reads the rules for `<METHOD> <path>`, and counts one
 * hit per rule. A route can carry several rules at different scopes — login is
 * limited per IP *and* per account, because the two attacks are different: a
 * botnet spreads across addresses to hammer one account, and one address
 * sprays many accounts. Either alone leaves the other open.
 *
 * WHAT THIS GUARD WILL NOT DO
 * ---------------------------
 * Refuse a request because the limiter is broken. Every failure path here ends
 * in "allow" — an unreadable store, a scope it cannot resolve, an unexpected
 * error. A limiter is a defence against abuse, and a defence that takes the
 * service down when it malfunctions has become the more likely outage. The
 * store degrades to per-instance counting rather than erroring; this guard
 * degrades to letting traffic through rather than throwing.
 *
 * Response headers follow the IETF RateLimit draft (`RateLimit-Limit`,
 * `-Remaining`, `-Reset`), which is what the CORS config already exposes, so a
 * client can back off before it is refused rather than discovering the limit
 * by hitting it.
 */

import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DEFAULT_RATE_RULE, RATE_LIMITS, type RateRule } from './rate-limit.config';
import { RATE_LIMIT_STORE, type RateLimitStore } from './rate-limit.tokens';
import { RateLimitedError } from '../globals/errors';
import { createHash } from 'node:crypto';
import { logger } from '../logger';
import type { AuthenticatedRequest } from '../globals/interface';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();

    // Probes are how the platform decides whether to keep this instance in
    // rotation. Rate-limiting them is a way to be taken out of service by
    // your own health check.
    if (req.path === '/health' || req.path === '/ready') return true;

    // The table is keyed by the route as declared (":workspaceId"), which the
    // router has resolved by the time a guard runs; a literal path still
    // matches for routes without parameters.
    const pattern = (req as Request & { route?: { path?: string } }).route?.path;
    const route = pattern ? `${req.method} ${pattern}` : `${req.method} ${req.path}`;
    const rules = RATE_LIMITS[route] ?? RATE_LIMITS[`${req.method} ${req.path}`] ?? [DEFAULT_RATE_RULE];

    for (const rule of rules) {
      const subject = this.subject(req, rule);
      // A scope we cannot resolve — an account rule on a request with no
      // identifier, or an API-key rule before the org API exists — is skipped,
      // not guessed at. Guessing would either limit everyone as one subject or
      // limit no one, and both are worse than the rule not applying yet.
      if (!subject) continue;

      const key = `rl:${rule.scope}:${route}:${subject}`;
      let verdict;
      try {
        verdict = await this.store.hit(key, rule.limit, rule.windowSec);
      } catch (err) {
        logger.error({ err, key }, 'rate limiter failed; allowing the request');
        continue;
      }

      res.setHeader('RateLimit-Limit', rule.limit);
      res.setHeader('RateLimit-Remaining', verdict.remaining);
      res.setHeader('RateLimit-Reset', verdict.resetSec);

      if (!verdict.allowed) {
        res.setHeader('Retry-After', verdict.resetSec);
        // Warn, not error: being rate-limited is the system working. It is
        // logged because a burst of these on /auth/login is the first sign of
        // credential stuffing, and the shape of that burst is the story.
        logger.warn({ scope: rule.scope, route, limit: rule.limit, windowSec: rule.windowSec, ip: req.ip, requestId: req.requestId }, 'rate limit exceeded');
        throw new RateLimitedError(verdict.resetSec);
      }
    }
    return true;
  }

  /**
   * Who is being counted.
   *
   * `account` deliberately reads the submitted identifier rather than the
   * authenticated user: the endpoints that need an account-scoped limit are
   * the ones where nobody is signed in yet, and the whole point is to slow
   * attempts against *one address* whoever is making them. It is lowercased so
   * that casing variants are not three separate allowances.
   */
  private subject(req: Request, rule: RateRule): string | null {
    switch (rule.scope) {
      case 'ip':
        return req.ip ?? null;
      case 'account': {
        const actor = (req as AuthenticatedRequest).actor;
        if (actor?.userId) return actor.userId;
        // This guard runs before the session is resolved, so on a signed-in
        // route the actor is not there yet. The session cookie is: a hash of
        // it is a stable per-session subject, which is close enough to
        // per-account for a brake on credential guessing.
        const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
        const session = Object.entries(cookies).find(([k]) => k.startsWith('__Host-as_') && !k.endsWith('_r'))?.[1];
        if (session) return `s:${createHash('sha256').update(session).digest('hex').slice(0, 32)}`;
        const body = req.body as { email?: unknown; identifier?: unknown } | undefined;
        const claimed = body?.email ?? body?.identifier;
        return typeof claimed === 'string' && claimed ? claimed.toLowerCase().slice(0, 200) : null;
      }
      // The organization API: the key is the subject before it is resolved
      // (a hash of the bearer token is stable per key), and a merchant is the
      // key plus the caller's own reference for who this is for.
      case 'apiKey':
      case 'merchant': {
        const header = req.get('authorization') ?? '';
        if (!header.startsWith('Bearer ')) return null;
        const keyHash = createHash('sha256').update(header.slice(7).trim()).digest('hex').slice(0, 32);
        if (rule.scope === 'apiKey') return `k:${keyHash}`;
        const body = req.body as { merchantRef?: unknown } | undefined;
        const merchant = typeof body?.merchantRef === 'string' ? body.merchantRef : req.get('x-merchant-ref');
        return merchant ? `m:${keyHash}:${String(merchant).slice(0, 120)}` : null;
      }
      default:
        return null;
    }
  }
}
