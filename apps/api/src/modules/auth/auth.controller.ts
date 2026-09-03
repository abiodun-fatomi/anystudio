/**
 * Authentication endpoints, shared by all three surfaces.
 *
 * The surface is derived from the validated Origin, never from a request body
 * field — a caller must not be able to ask for an admin session by typing
 * "ADMIN" into JSON.
 *
 * Every handler below documents four things: what it does, who may call it,
 * what it costs, and what it writes. That last one matters most during an
 * incident, when the question is always "what changed?".
 */

import { Body, Controller, Get, Post, Req, Res, HttpCode } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
import { VerificationService } from './verification.service';
import { SessionService, COOKIE } from './session.service';
import { Public, CurrentActor, RequireSurface, RequireStepUp } from '../../common/guards';
import type { Actor, SessionActor } from '../../common/policy/policy';

const identifier = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .describe('An email address or an E.164 phone number — one field, both accepted');

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly registration: RegistrationService,
    private readonly resets: PasswordResetService,
    private readonly verification: VerificationService,
  ) {}

  /**
   * Ask for a password reset link.
   *
   * WHAT     Emails a single-use, 30-minute link to the address — if it is
   *          one we know. The response is 200 and empty either way.
   * WHO      Anyone. Public. Rate limited to 3/hour per IP and per address.
   * COSTS    Nothing.
   * WRITES   A PASSWORD_RESET AuthToken (hashed) and retires any earlier ones.
   */
  @Public()
  @Post('forgot')
  @HttpCode(200)
  async forgot(@Req() req: Request, @Body() body: unknown) {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).parse(body);
    await this.resets.request(email, this.auth.publicOrigin(req), req);
    return { status: 'sent' as const };
  }

  /**
   * Confirm an email address.
   *
   * WHAT     Consumes the link from the welcome email and marks the address
   *          verified.
   * WHO      Anyone holding a live token. Public — the person may be reading
   *          their email on a device that is not signed in.
   * COSTS    Nothing. Rate limited to 10/hour per IP.
   * WRITES   User.emailVerifiedAt, and consumes the token.
   */
  @Public()
  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: unknown) {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(body);
    const ok = await this.verification.complete(token);
    return ok ? { status: 'verified' as const } : { status: 'invalid_token' as const };
  }

  /**
   * Send the confirmation link again.
   *
   * WHAT     Issues a fresh link and retires the previous one.
   * WHO      The signed-in owner of the address. Requiring a session keeps
   *          this from being a way to mail strangers on our behalf.
   * COSTS    Nothing. Rate limited to 3/hour per account.
   * WRITES   A new EMAIL_VERIFY token; consumes any earlier ones.
   */
  @Post('verify/resend')
  @HttpCode(202)
  async resendVerification(@Req() req: Request, @CurrentActor() actor: SessionActor) {
    await this.verification.issue(actor.userId, this.auth.publicOrigin(req), req, 'resend');
    return { status: 'sent' as const };
  }

  /**
   * Finish a password reset.
   *
   * WHAT     Sets the new password and ends every session on every surface.
   * WHO      Anyone holding a live reset token.
   * COSTS    Nothing. Rate limited to 5/hour per IP.
   * WRITES   The user's passwordHash and credentialEpoch; revokes sessions;
   *          consumes the token; one AuthEvent (PASSWORD_CHANGED).
   */
  @Public()
  @Post('reset')
  @HttpCode(200)
  async reset(@Req() req: Request, @Body() body: unknown) {
    const input = z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(400) }).parse(body);
    const ok = await this.resets.complete(input.token, input.password, req);
    return ok ? { status: 'reset' as const } : { status: 'invalid_token' as const };
  }

  /**
   * Create an account.
   *
   * WHAT     Registers a person with email, phone and password; creates their
   *          personal workspace, its wallet and the welcome credits; records
   *          the marketing consent answer verbatim; signs them in on the APP
   *          surface.
   * WHO      Anyone. Public. APP surface only — organizations and staff are
   *          created by invitation, never by a public form.
   * COSTS    Nothing to the caller. Rate limited to 3/hour per IP.
   * WRITES   User, Identity, Workspace, WorkspaceMember, Wallet, one PROMO
   *          LedgerEntry, one Consent row, one AuthEvent (SIGNED_UP), and the
   *          session — all in one transaction except the session.
   *
   * A duplicate email or phone returns 409 with no field named. Sign-up is the
   * other half of the login oracle: "this number is taken" confirms an account
   * exists just as surely as "wrong password" would.
   */
  @Public()
  @Post('register')
  @HttpCode(201)
  async register(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = z
      .object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().toLowerCase().email().max(320),
        phone: z.string().trim().min(7).max(24),
        password: z.string().min(8).max(400),
        phoneIsWhatsApp: z.boolean().default(false),
        marketing: z.object({ granted: z.boolean(), wording: z.string().min(1).max(500) }),
        sourceUrl: z.string().url().max(500).optional(),
      })
      .parse(body);

    const surface = this.auth.surfaceFromOrigin(req);
    if (surface !== 'APP') {
      // Not a 403 with an explanation: on the org and admin hosts this route
      // simply does not exist.
      return { status: 'not_available' as const };
    }

    const outcome = await this.registration.register(
      { ...input, phone: RegistrationService.normalisePhone(input.phone) },
      req,
    );
    if (outcome.kind === 'conflict') {
      res.status(409);
      return { status: 'conflict' as const, message: 'An account already exists with those details. Try signing in.' };
    }

    // Awaited so a transport error is logged against this request, but the
    // service never throws: the account exists, and a failed send must not be
    // reported to someone who just signed up successfully.
    await this.verification.issue(outcome.user.id, this.auth.publicOrigin(req), req, 'welcome');

    const issued = await this.sessions.mint({
      userId: outcome.user.id,
      surface,
      mfaLevel: 1,
      credentialEpoch: outcome.user.credentialEpoch,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    this.auth.setCookies(res, surface, issued);
    return { status: 'signed_in' as const, next: '/welcome' };
  }

  /**
   * Begin sign-in.
   *
   * WHAT     Verifies the identifier and password, then says what still has to
   *          happen. It does NOT mint a session — a second factor may be owed,
   *          and on the admin surface one always is.
   * WHO      Anyone. Public.
   * COSTS    Nothing. Rate limited to 5/min per IP and 10/hour per account.
   * WRITES   An AuthEvent (LOGIN_SUCCEEDED or LOGIN_FAILED). On the admin
   *          surface, an MFA_CHALLENGE AuthToken.
   *
   * The response is deliberately identical for "no such account", "wrong
   * password" and "no staff access on the admin surface". Distinguishing them
   * turns this endpoint into an oracle that confirms which emails are real, and
   * on admin it would confirm which of your customers are staff.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = z
      .object({ identifier, password: z.string().min(1).max(400) })
      .parse(body);

    const surface = this.auth.surfaceFromOrigin(req);
    const outcome = await this.auth.verifyPassword(input.identifier, input.password, surface, req);

    // One shape, one timing profile, whatever went wrong.
    if (outcome.kind === 'rejected') {
      return { status: 'invalid_credentials' as const };
    }

    if (outcome.kind === 'mfa_required') {
      // The challenge id is not a credential — it identifies an in-flight
      // attempt and expires in five minutes.
      return { status: 'mfa_required' as const, challengeId: outcome.challengeId, factors: outcome.factors };
    }

    const issued = await this.sessions.mint({
      userId: outcome.user.id,
      surface,
      mfaLevel: outcome.mfaLevel,
      credentialEpoch: outcome.user.credentialEpoch,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    this.auth.setCookies(res, surface, issued);
    return { status: 'signed_in' as const, next: await this.auth.landingFor(outcome.user.id, surface) };
  }

  /**
   * Complete a second factor and finish sign-in.
   *
   * WHAT     Checks a TOTP code or WebAuthn assertion against the challenge
   *          from /login, then mints the session.
   * WHO      Anyone holding a valid, unexpired challenge id.
   * COSTS    Nothing. Five attempts per challenge, then the challenge dies.
   * WRITES   The session, and an AuthEvent (MFA_CHALLENGED or MFA_FAILED).
   *
   * This is the only route that can produce an ADMIN session. SessionService
   * refuses to mint one below mfaLevel 2, so there is no path around it.
   */
  @Public()
  @Post('login/mfa')
  @HttpCode(200)
  async completeMfa(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = z
      .object({ challengeId: z.string().uuid(), code: z.string().min(6).max(400) })
      .parse(body);

    const surface = this.auth.surfaceFromOrigin(req);
    const outcome = await this.auth.verifySecondFactor(input.challengeId, input.code, req);
    if (outcome.kind === 'rejected') return { status: 'invalid_code' as const };

    const issued = await this.sessions.mint({
      userId: outcome.user.id,
      surface,
      mfaLevel: 2,
      credentialEpoch: outcome.user.credentialEpoch,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    this.auth.setCookies(res, surface, issued);
    return { status: 'signed_in' as const, next: await this.auth.landingFor(outcome.user.id, surface) };
  }

  /**
   * Who am I, on this surface.
   *
   * WHAT     Returns the signed-in person, their workspaces, whether they hold
   *          staff access, and which onboarding tour (if any) they still owe.
   * WHO      Any valid session for the calling surface.
   * COSTS    Nothing.
   * WRITES   Nothing. Read-only, and safe to call on every page load.
   *
   * `canSwitchToStaff` is what powers the "Staff console" link in the customer
   * app. It reveals that a staff grant exists; it does not carry any authority.
   * Reaching the console still means signing in there with a second factor.
   */
  @Get('me')
  async me(@CurrentActor() actor: Actor) {
    return this.auth.describeActor(actor);
  }

  /**
   * Re-prove a second factor inside an existing session.
   *
   * WHAT     Opens the step-up window for a few minutes.
   * WHO      Any signed-in user with a confirmed factor.
   * COSTS    Nothing.
   * WRITES   Session.lastStepUpAt, and an AuthEvent (STEP_UP_COMPLETED).
   *
   * Required before moving money, changing a role, revealing an API key or
   * deleting an organization. The risk being managed is an unattended session,
   * not an old one.
   */
  @Post('step-up')
  @HttpCode(200)
  async stepUp(@CurrentActor() actor: SessionActor, @Req() req: Request, @Body() body: unknown) {
    const input = z.object({ code: z.string().min(6).max(400) }).parse(body);
    const ok = await this.auth.verifyStepUp(actor, input.code, req);
    return { status: ok ? ('ok' as const) : ('invalid_code' as const) };
  }

  /**
   * Rotate the session.
   *
   * WHAT     Exchanges the refresh cookie for a fresh pair.
   * WHO      Anyone holding the refresh cookie for this surface.
   * COSTS    Nothing.
   * WRITES   A new session; revokes the old one. On reuse, revokes the whole
   *          family and writes REFRESH_REUSE_DETECTED.
   *
   * Reuse means two parties hold a single-use token, and we cannot tell which is
   * the customer. Both are signed out. An unnecessary re-login is a far smaller
   * harm than an attacker silently refreshing forever.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const surface = this.auth.surfaceFromOrigin(req);
    const token = req.cookies?.[`${COOKIE[surface]}_r`];
    if (!token) return { status: 'invalid' as const };

    const out = await this.sessions.rotate(token, surface);
    if (out.result === 'reuse_detected') {
      await this.auth.onRefreshReuse(token, req);
      this.auth.clearCookies(res, surface);
      return { status: 'reauthenticate' as const, reason: 'session_conflict' };
    }
    if (out.result !== 'ok') {
      this.auth.clearCookies(res, surface);
      return { status: 'invalid' as const };
    }
    this.auth.setCookies(res, surface, out.issued);
    return { status: 'ok' as const };
  }

  /**
   * Sign out of this surface only.
   *
   * WHAT     Revokes this one session. A staff member signing out of the console
   *          stays signed in to their own workspace, which is the behaviour
   *          people expect from two separate places.
   * WHO      Any valid session.
   * COSTS    Nothing.
   * WRITES   Session.revokedAt, and an AuthEvent (LOGGED_OUT).
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response, @CurrentActor() actor: SessionActor) {
    await this.auth.logout(actor, req);
    this.auth.clearCookies(res, actor.surface);
  }

  /**
   * Sign out everywhere, on every surface and device.
   *
   * WHAT     Increments the credential epoch, which retires every existing
   *          session at once — including admin sessions.
   * WHO      The account owner. Step-up required, because this is what someone
   *          reaches for when they think they have been compromised, and it
   *          must not itself be reachable by the compromise.
   * COSTS    Nothing.
   * WRITES   User.credentialEpoch, every Session row, and an AuthEvent.
   */
  @Post('logout-everywhere')
  @RequireStepUp(5)
  @HttpCode(204)
  async logoutEverywhere(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revokeAllForUser(actor.userId, 'user_requested');
    this.auth.clearCookies(res, actor.surface);
  }

  /**
   * List this account's active sessions.
   *
   * WHAT     Device, coarse location, last seen and surface for each live
   *          session, so a person can spot one they do not recognise.
   * WHO      The account owner, on any surface.
   * COSTS    Nothing.
   * WRITES   Nothing.
   *
   * Deliberately includes admin sessions when the person holds staff access.
   * Someone with both roles should be able to see their whole footprint in one
   * place, not two.
   */
  @Get('sessions')
  async listSessions(@CurrentActor() actor: Actor) {
    return this.auth.listSessions(actor.userId);
  }

  /**
   * Staff-only: confirm that this account may reach the console at all.
   *
   * WHAT     Returns the active staff grant and its expiry.
   * WHO      An ADMIN-surface session with a live grant.
   * COSTS    Nothing.
   * WRITES   Nothing.
   */
  @Get('staff/context')
  @RequireSurface('ADMIN')
  async staffContext(@CurrentActor() actor: Actor) {
    return this.auth.staffContext(actor);
  }
}
