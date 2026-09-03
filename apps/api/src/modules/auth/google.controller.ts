/**
 * The two endpoints of the Google handshake.
 *
 * Both are reached through the web app's /api proxy, so the browser stays on
 * one origin for the whole flow and the state cookie is first-party. That is
 * also why the redirect_uri registered with Google is on the app's hostname,
 * not the API's.
 */

import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { GoogleService, OAUTH_COOKIE } from './google.service';
import { SessionService } from './session.service';
import { Public } from '../../common/guards';
import { logger } from '../../common/logging/logger';

/** Attributes for the short-lived handshake cookie. Deliberately not configurable. */
const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  // 'lax' and not 'strict': the browser arrives back here from accounts.google.com,
  // and a strict cookie would not be sent on that navigation.
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 10 * 60_000,
};

@Controller('auth/google')
export class GoogleController {
  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Begin sign-in with Google.
   *
   * WHAT     Redirects the browser to Google's consent screen, remembering
   *          the surface, the return path and the PKCE verifier in one
   *          encrypted cookie.
   * WHO      Anyone. Public. Reached by navigation, not by fetch.
   * COSTS    Nothing. Rate limited to 10/min per IP.
   * WRITES   Nothing. The handshake state is a cookie, not a row.
   */
  @Public()
  @Get('start')
  start(@Req() req: Request, @Res() res: Response, @Query() q: unknown): void {
    if (!this.google.configured) {
      res.redirect(302, '/login?error=google_unavailable');
      return;
    }
    const { next } = z.object({ next: z.string().max(200).optional() }).parse(q ?? {});
    const surface = this.auth.surfaceFromOrigin(req);
    const origin = this.auth.publicOrigin(req);

    const { url, cookie } = this.google.begin(origin, surface, next ?? '/');
    res.cookie(OAUTH_COOKIE, cookie, COOKIE_OPTS);
    res.redirect(302, url);
  }

  /**
   * Finish sign-in with Google.
   *
   * WHAT     Validates state, exchanges the code, verifies the id_token, finds
   *          or creates the user, mints the session and returns the browser to
   *          the app.
   * WHO      Anyone holding a matching state cookie.
   * COSTS    Nothing.
   * WRITES   An Identity on first use, a User if this is a new person, the
   *          session, and an AuthEvent.
   *
   * Every failure ends at /login with a short code rather than an error page.
   * A person who declined the consent screen has not done anything wrong and
   * should land somewhere they can simply try again.
   */
  @Public()
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response, @Query() q: unknown): Promise<void> {
    const input = z.object({
      code: z.string().min(1).max(2000).optional(),
      state: z.string().min(1).max(200).optional(),
      error: z.string().max(100).optional(),
    }).parse(q ?? {});

    const state = this.google.readState(req.cookies?.[OAUTH_COOKIE] as string | undefined);
    res.clearCookie(OAUTH_COOKIE, { ...COOKIE_OPTS, maxAge: undefined });

    const fail = (reason: string): void => {
      logger.warn({ reason }, 'google sign-in did not complete');
      res.redirect(302, `/login?error=${reason}`);
    };

    if (input.error) return fail('google_declined');
    if (!state || !input.code || !input.state) return fail('google_expired');
    if (!GoogleService.matches(input.state, state.s)) return fail('google_state');

    const profile = await this.google.exchange(input.code, state);
    if (!profile) return fail('google_rejected');

    const resolved = await this.google.resolveUser(profile, req);
    if (!resolved) return fail('google_email_unverified');

    // Google proves an email, never a second factor. The admin surface refuses
    // a session below mfaLevel 2, so staff finish at the same challenge they
    // would have reached with a password.
    if (state.f === 'ADMIN') {
      return fail('mfa_required');
    }

    const issued = await this.sessions.mint({
      userId: resolved.user.id,
      surface: state.f,
      mfaLevel: 1,
      credentialEpoch: resolved.user.credentialEpoch,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    this.auth.setCookies(res, state.f, issued);

    const landing = resolved.created ? '/welcome' : await this.auth.landingFor(resolved.user.id, state.f);
    res.redirect(302, state.r !== '/' ? state.r : landing);
  }
}
