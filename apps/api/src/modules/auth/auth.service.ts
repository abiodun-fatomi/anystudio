/**
 * Authentication.
 *
 * The controller decides HTTP shape; this service decides truth: is this
 * password right, is a second factor owed, which surface is the caller on,
 * what should happen next. It knows nothing about cookies except through
 * SessionService, and nothing about authorization at all — that is the policy
 * layer's job, and keeping them apart is what lets each be reasoned about alone.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type User, type Surface, type StaffRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { surfaceForOrigin, isMarketingOrigin, surfaceOriginFor, surfaceForWorkspaceType, type AppEnv } from '@anystudio/shared';
import { SessionService, COOKIE, type IssuedSession } from './session.service';
import { verifyPassword, needsRehash, hashPassword } from '../../utils/crypto/password';
import { verifyCode } from '../../utils/crypto/totp';
import { decrypt } from '../../utils/crypto/encrypt';
import { ConflictError, NotFoundError } from '../../../config/globals/errors';
import type { Actor } from './policy';
import { logger } from '../../../config/logger';
import { authLog } from './auth.log';

import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
import { VerificationService } from './verification.service';
import { GoogleProvider, OAUTH_COOKIE, OAUTH_COOKIE_OPTS } from './providers/google.provider';
import { MediaService } from '../media/media.service';
import type {
  LoginDto,
  MfaDto,
  RegisterDto,
  HandoffDto,
  HopDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
  StepUpDto,
  GoogleStartQueryDto,
  GoogleCallbackQueryDto,
} from './auth.dto';
import type { LoginResult, MfaResult, RegisterResult, RefreshResult, Verified, SignedIn } from './auth.types';
import { Helpers } from '../../utils/helpers';
import { MESSAGES } from '../../utils/constant';
import { GoogleSignInError, VerificationFlavour } from '../../utils/enums';

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
/** A landing page is a path on the app host, never somewhere else. */
const safeNext = (v: unknown): string => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/today');
const CHALLENGE_TTL_MS = 5 * 60_000;
/** A sign-in minted on the marketing host has this long to reach the app host. */
const HANDOFF_TTL_MS = 60_000;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly sessions: SessionService,
    private readonly registration: RegistrationService,
    private readonly resets: PasswordResetService,
    private readonly verification: VerificationService,
    private readonly google: GoogleProvider,
    private readonly media: MediaService,
  ) {}

  // ------------------------------------------------------------------
  // Use cases. One per endpoint; the controller only names them.
  // ------------------------------------------------------------------

  /**
   * Create an account and sign it in.
   *
   * Only the APP surface has a public sign-up: organizations and staff are
   * created by invitation. Duplicate email or phone is reported as a single
   * conflict — sign-up is the other half of the login oracle, and "that
   * number is taken" confirms an account exists just as surely as "wrong
   * password" would. The welcome email is sent before the session is minted
   * so a mail failure is logged against this request, but it never fails the
   * sign-up: the account exists, and the link can be re-sent.
   */
  async register(dto: RegisterDto, req: Request, res: Response) {
    const surface = this.surfaceFromOrigin(req);
    if (surface !== 'APP') {
      authLog('auth.register', 'refused', { reason: 'wrong_surface', surface }, req);
      return Helpers.successResponse<RegisterResult>(200, 'Sign-up is not available here', { status: 'not_available' });
    }

    const phone = RegistrationService.normalisePhone(dto.phone, dto.country);
    const outcome = await this.registration.register(
      {
        name: dto.name,
        email: dto.email.toLowerCase(),
        password: dto.password,
        phone,
        country: RegistrationService.countryOfPhone(phone) ?? RegistrationService.countryOfRequest(req),
        phoneIsWhatsApp: dto.phoneIsWhatsApp ?? false,
        marketing: dto.marketing,
        sourceUrl: dto.sourceUrl,
      },
      req,
    );
    // Not a success envelope with a 409 on it: a conflict is an error, and the
    // client handles every error through one path.
    if (outcome.kind === 'conflict') {
      authLog('auth.register', 'refused', { reason: 'already_exists' }, req);
      throw new ConflictError(MESSAGES.CONFLICT);
    }

    await this.verification.issue(outcome.user.id, this.publicOrigin(req), req, VerificationFlavour.Welcome);
    const result = await this.finishSignIn(outcome.user, surface, 1, '/welcome', req, res);
    authLog('auth.register', 'succeeded', { userId: outcome.user.id, surface, mfa: 1, handoff: result.status === 'handoff' }, req);
    return Helpers.successResponse<RegisterResult>(201, MESSAGES.REGISTERED, result);
  }

  /**
   * Password step of sign-in. Does NOT mint a session when a second factor
   * is owed — and on the admin surface one always is.
   */
  async login(dto: LoginDto, req: Request, res: Response) {
    const surface = this.surfaceFromOrigin(req);
    const outcome = await this.verifyPassword(dto.identifier, dto.password, surface, req);

    // One shape, one timing profile, whatever went wrong — except on the
    // console, where a PROVEN password that still cannot get in is told why
    // (no staff grant, or no authenticator yet): whoever holds the password
    // holds the account already, and "wrong password" would send them to
    // reset a password that was right.
    if (outcome.kind === 'rejected') {
      if (outcome.reason) {
        authLog('auth.login', 'refused', { reason: outcome.reason, surface }, req);
        return Helpers.successResponse<LoginResult>(200, MESSAGES.INVALID_CREDENTIALS, { status: outcome.reason });
      }
      // No userId on purpose: the response does not reveal whether the account
      // exists, and neither should the line describing it.
      authLog('auth.login', 'refused', { reason: 'invalid_credentials', surface }, req);
      return Helpers.successResponse<LoginResult>(200, MESSAGES.INVALID_CREDENTIALS, { status: 'invalid_credentials' });
    }
    if (outcome.kind === 'mfa_required') {
      authLog('auth.login', 'succeeded', { reason: 'mfa_required', surface, factors: outcome.factors }, req);
      return Helpers.successResponse<LoginResult>(200, MESSAGES.MFA_REQUIRED, {
        status: 'mfa_required',
        challengeId: outcome.challengeId,
        factors: outcome.factors,
      });
    }
    const result = await this.finishSignIn(outcome.user, surface, outcome.mfaLevel, await this.landingFor(outcome.user.id, surface), req, res);
    authLog('auth.login', 'succeeded', { userId: outcome.user.id, surface, mfa: outcome.mfaLevel, handoff: result.status === 'handoff' }, req);
    return Helpers.successResponse<LoginResult>(200, MESSAGES.SIGNED_IN, result);
  }

  /**
   * Second factor. The only path that can produce an ADMIN session, and
   * SessionService refuses to mint one below mfaLevel 2, so there is no way
   * around it.
   */
  async completeMfa(dto: MfaDto, req: Request, res: Response) {
    const surface = this.surfaceFromOrigin(req);
    const outcome = await this.verifySecondFactor(dto.challengeId, dto.code, req);
    if (outcome.kind === 'rejected') {
      authLog('auth.mfa', 'refused', { reason: 'invalid_code', surface }, req);
      return Helpers.successResponse<MfaResult>(200, MESSAGES.INVALID_CODE, { status: 'invalid_code' });
    }
    const result = await this.finishSignIn(outcome.user, surface, 2, await this.landingFor(outcome.user.id, surface), req, res);
    authLog('auth.mfa', 'succeeded', { userId: outcome.user.id, surface, mfa: 2, handoff: result.status === 'handoff' }, req);
    return Helpers.successResponse<MfaResult>(200, MESSAGES.SIGNED_IN, result);
  }

  /**
   * The app host's half of a sign-in that happened on the marketing host.
   *
   * The token is single-use, a minute old at most, and only ever redeemed
   * from the app origin — a __Host- cookie can only be set by the host that
   * will read it, so the marketing host hands the proven identity across
   * instead of a session. The MFA level travels with it, so a staff account
   * that proved a second factor keeps that proof.
   */
  async completeHandoff(dto: HandoffDto, req: Request, res: Response) {
    const surface = this.surfaceFromOrigin(req);
    const origin = this.publicOrigin(req);
    // Either portal host may redeem one — app. for businesses, org. for
    // organizations — but never the marketing host and never the console.
    if (surface === 'ADMIN' || isMarketingOrigin(origin, this.appEnv())) {
      authLog('auth.handoff', 'refused', { reason: 'wrong_surface', surface }, req);
      return Helpers.successResponse<SignedIn | { status: 'invalid_token' }>(200, MESSAGES.INVALID_TOKEN, { status: 'invalid_token' });
    }
    const row = await this.db.authToken.findUnique({ where: { tokenHash: sha256(dto.token) } });
    if (!row || row.purpose !== 'SESSION_HANDOFF' || !row.userId || row.consumedAt || row.expiresAt < new Date()) {
      authLog('auth.handoff', 'refused', { reason: 'invalid_token' }, req);
      return Helpers.successResponse<SignedIn | { status: 'invalid_token' }>(200, MESSAGES.INVALID_TOKEN, { status: 'invalid_token' });
    }
    // Consume first: two tabs redeeming the same link must not both win.
    const consumed = await this.db.authToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count === 0) {
      authLog('auth.handoff', 'refused', { reason: 'already_used' }, req);
      return Helpers.successResponse<SignedIn | { status: 'invalid_token' }>(200, MESSAGES.INVALID_TOKEN, { status: 'invalid_token' });
    }
    const user = await this.db.user.findUnique({ where: { id: row.userId } });
    if (!user || user.status === 'DELETED' || user.status === 'SUSPENDED') {
      authLog('auth.handoff', 'refused', { reason: 'account_unavailable', userId: row.userId }, req);
      return Helpers.successResponse<SignedIn | { status: 'invalid_token' }>(200, MESSAGES.INVALID_TOKEN, { status: 'invalid_token' });
    }
    const payload = (row.payload ?? {}) as { mfaLevel?: number; next?: string };
    const mfaLevel = payload.mfaLevel === 2 ? 2 : 1;
    await this.issueSession(user, surface, mfaLevel, req, res);
    authLog('auth.handoff', 'succeeded', { userId: user.id, surface, mfa: mfaLevel }, req);
    return Helpers.successResponse<SignedIn>(200, MESSAGES.SIGNED_IN, { status: 'signed_in', next: safeNext(payload.next) });
  }

  /** Confirm a fresh second factor for the current session. */
  async stepUp(actor: Actor & { sessionId: string }, dto: StepUpDto, req: Request) {
    const ok = await this.verifyStepUp(actor, dto.code, req);
    authLog('auth.step_up', ok ? 'succeeded' : 'refused', { userId: actor.userId, surface: actor.surface, ...(ok ? {} : { reason: 'invalid_code' }) }, req);
    return Helpers.successResponse(200, ok ? MESSAGES.OK : MESSAGES.INVALID_CODE, { status: ok ? 'ok' : 'invalid_code' });
  }

  /** Ask for a reset link. Same answer whether or not the address exists. */
  async forgotPassword(dto: ForgotPasswordDto, req: Request) {
    // Always 'succeeded': whether the address exists is exactly what this
    // endpoint refuses to disclose, and a log that distinguished the two
    // cases would disclose it to anyone reading the log.
    await this.resets.request(dto.email.toLowerCase(), this.publicOrigin(req), req);
    authLog('auth.forgot', 'succeeded', {}, req);
    return Helpers.successResponse(200, MESSAGES.RESET_SENT, { status: 'sent' });
  }

  /** Finish a reset. Ends every session on every surface. */
  async resetPassword(dto: ResetPasswordDto, req: Request) {
    const ok = await this.resets.complete(dto.token, dto.password, req);
    authLog('auth.reset', ok ? 'succeeded' : 'refused', ok ? {} : { reason: 'invalid_token' }, req);
    return Helpers.successResponse(200, ok ? MESSAGES.RESET_DONE : MESSAGES.INVALID_TOKEN, { status: ok ? 'reset' : 'invalid_token' });
  }

  /** Consume a confirmation link. */
  async verifyEmail(dto: VerifyEmailDto) {
    const ok = await this.verification.complete(dto.token);
    authLog('auth.verify', ok ? 'succeeded' : 'refused', ok ? {} : { reason: 'invalid_token' });
    return Helpers.successResponse(200, ok ? MESSAGES.VERIFIED : MESSAGES.INVALID_TOKEN, { status: ok ? 'verified' : 'invalid_token' });
  }

  /** Send the confirmation link again, to the signed-in owner only. */
  async resendVerification(actor: Actor, req: Request) {
    await this.verification.issue(actor.userId, this.publicOrigin(req), req, VerificationFlavour.Resend);
    authLog('auth.verify_resend', 'succeeded', { userId: actor.userId }, req);
    return Helpers.successResponse(202, MESSAGES.VERIFICATION_SENT, { status: 'sent' });
  }

  /**
   * Rotate the refresh token. A replayed token means two parties hold it, so
   * the whole family is revoked and the caller is told to sign in again.
   */
  async refresh(req: Request, res: Response) {
    const surface = this.surfaceFromOrigin(req);
    const token = req.cookies?.[`${COOKIE[surface]}_r`] as string | undefined;
    if (!token) {
      return Helpers.successResponse<RefreshResult>(200, MESSAGES.INVALID_TOKEN, { status: 'invalid' });
    }
    const out = await this.sessions.rotate(token, surface);
    if (out.result === 'reuse_detected') {
      // The loudest line in this file. A replayed refresh token means two
      // parties hold it: either a stolen session or a bug that duplicated one.
      authLog('auth.refresh', 'refused', { reason: 'reuse_detected', surface }, req);
      await this.onRefreshReuse(token, req);
      this.clearCookies(res, surface);
      return Helpers.successResponse<RefreshResult>(200, 'Please sign in again', { status: 'reauthenticate', reason: 'session_conflict' });
    }
    if (out.result !== 'ok') {
      authLog('auth.refresh', 'refused', { reason: out.result, surface }, req);
      this.clearCookies(res, surface);
      return Helpers.successResponse<RefreshResult>(200, MESSAGES.INVALID_TOKEN, { status: 'invalid' });
    }
    this.setCookies(res, surface, out.issued);
    return Helpers.successResponse<RefreshResult>(200, MESSAGES.OK, { status: 'ok' });
  }

  /** Sign out of this surface only. */
  async signOut(actor: Actor & { sessionId: string }, req: Request, res: Response): Promise<void> {
    await this.logout(actor, req);
    authLog('auth.signout', 'succeeded', { userId: actor.userId, surface: actor.surface }, req);
    this.clearCookies(res, actor.surface);
  }

  /** Sign out everywhere: bumps the credential epoch, which retires every session. */
  async signOutEverywhere(actor: Actor, res: Response): Promise<void> {
    await this.sessions.revokeAllForUser(actor.userId, 'user_requested');
    authLog('auth.signout', 'succeeded', { userId: actor.userId, surface: actor.surface, scope: 'everywhere' });
    this.clearCookies(res, actor.surface);
  }

  /**
   * Begin sign-in with Google: redirect to consent, remembering the surface,
   * the return path and the PKCE verifier in one encrypted cookie.
   */
  googleStart(q: GoogleStartQueryDto, req: Request, res: Response): void {
    if (!this.google.configured) {
      // An operator problem, not a visitor's: the button was shown because the
      // page cannot know, and the credentials are missing from this
      // environment. Error, so it reaches whoever can set them.
      authLog('auth.google', 'failed', { reason: GoogleSignInError.Unavailable }, req);
      res.redirect(302, `/login?error=${GoogleSignInError.Unavailable}`);
      return;
    }
    const surface = this.surfaceFromOrigin(req);
    const { url, cookie } = this.google.begin(this.publicOrigin(req), surface, q.next ?? '/');
    authLog('auth.google', 'succeeded', { reason: 'redirected_to_consent', surface }, req);
    res.cookie(OAUTH_COOKIE, cookie, OAUTH_COOKIE_OPTS);
    res.redirect(302, url);
  }

  /**
   * Finish sign-in with Google. Every failure ends at /login with a short
   * code rather than an error page — someone who declined the consent screen
   * has done nothing wrong and should land somewhere they can try again.
   *
   * Google proves an email, never a second factor: the admin surface is
   * refused here, so staff finish at the same challenge a password reaches.
   */
  async googleCallback(q: GoogleCallbackQueryDto, req: Request, res: Response): Promise<void> {
    const state = this.google.readState(req.cookies?.[OAUTH_COOKIE] as string | undefined);
    res.clearCookie(OAUTH_COOKIE, { ...OAUTH_COOKIE_OPTS, maxAge: undefined });

    const fail = (reason: GoogleSignInError): void => {
      authLog('auth.google', 'refused', { reason, surface: state?.f }, req);
      res.redirect(302, `/login?error=${reason}`);
    };

    if (q.error) return fail(GoogleSignInError.Declined);
    if (!state || !q.code || !q.state) return fail(GoogleSignInError.Expired);
    if (!GoogleProvider.matches(q.state, state.s)) return fail(GoogleSignInError.State);

    // Refused here, before the code is exchanged and before any account is
    // created or linked. Checked at the end instead, an ADMIN attempt would
    // still mint a user and attach a Google identity to it on its way to
    // being turned away — real state written by a flow that never succeeds.
    if (state.f === 'ADMIN') return fail(GoogleSignInError.MfaRequired);

    const profile = await this.google.exchange(q.code, state);
    if (!profile) return fail(GoogleSignInError.Rejected);

    const resolved = await this.google.resolveUser(profile, req);
    if (!resolved) return fail(GoogleSignInError.EmailUnverified);

    await this.issueSession(resolved.user, state.f, 1, req, res);
    authLog('auth.google', 'succeeded', { userId: resolved.user.id, surface: state.f, mfa: 1, created: resolved.created }, req);
    const landing = resolved.created ? '/welcome' : await this.landingFor(resolved.user.id, state.f);
    res.redirect(302, state.r !== '/' ? state.r : landing);
  }

  /**
   * End a proven sign-in: a session cookie when the browser is already on the
   * host that will read it, a one-time hand-off to the app host when it is on
   * the marketing site (where the sign-in and sign-up pages live). The token
   * is hashed at rest like every other, lives a minute, and carries the MFA
   * level and the landing page so the app host mints exactly the session this
   * host would have.
   */
  private async finishSignIn(user: User, surface: Surface, mfaLevel: number, next: string, req: Request, res: Response): Promise<SignedIn> {
    const env = this.appEnv();
    if (surface === 'APP' && isMarketingOrigin(this.publicOrigin(req), env)) {
      const token = await this.mintHandoff(user.id, mfaLevel, next, req);
      const home = await this.homeSurface(user.id);
      return { status: 'handoff', url: `${surfaceOriginFor(home, env)}/auth/handoff?token=${token}` };
    }
    await this.issueSession(user, surface, mfaLevel, req, res);
    return { status: 'signed_in', next };
  }

  /** A one-time token another portal host can trade for a session; a minute to use it. */
  private async mintHandoff(userId: string, mfaLevel: number, next: string, req: Request): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.authToken.create({
      data: {
        purpose: 'SESSION_HANDOFF',
        userId,
        tokenHash: sha256(token),
        payload: { mfaLevel, next },
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
        createdIp: req.ip,
      },
    });
    return token;
  }

  /**
   * The portal a sign-in should land on: app. unless everything this person
   * belongs to is an organization, in which case org. is home. Someone with
   * both starts on app. and hops from the workspace switcher.
   */
  private async homeSurface(userId: string): Promise<'APP' | 'ORG'> {
    const rows = await this.db.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: { workspace: { select: { type: true } } },
    });
    if (rows.length === 0) return 'APP';
    return rows.every((r) => surfaceForWorkspaceType(r.workspace.type) === 'ORG') ? 'ORG' : 'APP';
  }

  /**
   * Cross to the other portal host for a workspace that lives there. Sessions
   * are __Host- cookies, so a session on app. is invisible to org. and the
   * only way over is the same one-time hand-off a marketing sign-in uses;
   * the MFA level travels with it. Membership is checked here — the URL is
   * built for a workspace the caller actually belongs to.
   */
  async hop(actor: Actor, dto: HopDto, req: Request): Promise<{ url: string }> {
    const member = await this.db.workspaceMember.findFirst({
      where: { userId: actor.userId, workspaceId: dto.workspaceId, workspace: { deletedAt: null } },
      select: { workspace: { select: { type: true } } },
    });
    if (!member) throw new NotFoundError('workspace');
    const target = surfaceForWorkspaceType(member.workspace.type);
    const next = safeNext(dto.next);
    const landing = `${next}${next.includes('?') ? '&' : '?'}ws=${dto.workspaceId}`;
    const token = await this.mintHandoff(actor.userId, actor.mfaLevel >= 2 ? 2 : 1, landing, req);
    authLog('auth.hop', 'succeeded', { userId: actor.userId, from: actor.surface, to: target, workspaceId: dto.workspaceId }, req);
    return { url: `${surfaceOriginFor(target, this.appEnv())}/auth/handoff?token=${token}&next=${encodeURIComponent(landing)}` };
  }

  /** Mint a session for a verified user and set its cookies. */
  private async issueSession(user: User, surface: Surface, mfaLevel: number, req: Request, res: Response): Promise<void> {
    const issued = await this.sessions.mint({
      userId: user.id,
      surface,
      mfaLevel,
      credentialEpoch: user.credentialEpoch,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    this.setCookies(res, surface, issued);
  }

  /**
   * Which surface is calling, from the validated Origin — never from the body.
   * An unknown origin is treated as APP with credentials refused upstream by
   * CORS; it never resolves to ADMIN.
   */
  /**
   * The public origin the browser is actually on.
   *
   * Requests reach this service through the web app's /api proxy, so the Host
   * header names the API, not the site. The proxy forwards the real one; the
   * Origin and Referer headers are the fallbacks, and neither is present on a
   * top-level navigation — which is precisely when the OAuth handshake needs
   * to know where to send someone back to.
   */
  publicOrigin(req: Request): string {
    const forwarded = req.get('x-anystudio-origin');
    if (forwarded && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(forwarded)) return forwarded;
    const origin = req.get('origin');
    if (origin) return origin;
    try {
      return new URL(req.get('referer') ?? '').origin;
    } catch {
      return process.env.ORIGIN_APP ?? '';
    }
  }

  /**
   * Which surface this request belongs to.
   *
   * Derived from the origin and matched against a fixed map — never read from
   * a request body, because a caller must not be able to ask for an admin
   * session by typing "ADMIN" into JSON.
   */
  surfaceFromOrigin(req: Request): Surface {
    return surfaceForOrigin(this.publicOrigin(req), this.appEnv()) ?? 'APP';
  }

  private appEnv(): AppEnv {
    const raw = process.env.APP_ENV;
    return raw === 'production' || raw === 'staging' || raw === 'dev' ? raw : 'local';
  }

  /**
   * Password step of sign-in.
   *
   * Uniform timing: an unknown identifier still costs a full argon2 verify.
   * On the ADMIN surface a second factor is ALWAYS owed, and an account without
   * an active staff grant is rejected with the same response as a wrong
   * password — otherwise this endpoint confirms which customers are staff.
   */
  async verifyPassword(identifier: string, password: string, surface: Surface, req: Request): Promise<Verified> {
    const user = await this.findByIdentifier(identifier);
    const ok = await verifyPassword(password, user?.passwordHash ?? null);

    if (!user || !ok || user.status === 'DELETED') {
      await this.event(user?.id ?? null, 'LOGIN_FAILED', surface, req, { reason: 'credentials' });
      return { kind: 'rejected' };
    }

    if (needsRehash(user.passwordHash!)) {
      await this.db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
    }

    if (surface === 'ADMIN' && !(await this.activeStaffRole(user.id))) {
      await this.event(user.id, 'LOGIN_FAILED', surface, req, { reason: 'no_staff_grant' });
      return { kind: 'rejected', reason: 'not_staff' };
    }

    const factors = await this.db.mfaFactor.findMany({
      where: { userId: user.id, confirmedAt: { not: null }, type: { in: ['TOTP', 'WEBAUTHN'] } },
      select: { type: true },
    });

    if (surface === 'ADMIN' || factors.length > 0) {
      if (surface === 'ADMIN' && factors.length === 0) {
        // Staff without a factor cannot get in. Enrolment happens on APP first.
        await this.event(user.id, 'LOGIN_FAILED', surface, req, { reason: 'staff_without_mfa' });
        return { kind: 'rejected', reason: 'factor_required' };
      }
      const challengeId = await this.openChallenge(user.id, surface, req);
      await this.event(user.id, 'MFA_CHALLENGED', surface, req);
      return { kind: 'mfa_required', challengeId, factors: factors.map((f) => f.type as 'TOTP' | 'WEBAUTHN') };
    }

    await this.touchLogin(user.id, surface, req);
    return { kind: 'signed_in', user, mfaLevel: 0 };
  }

  /**
   * Second-factor step. Five attempts per challenge, then it dies.
   * Only TOTP is implemented here; WebAuthn assertion verification is a
   * separate module because it carries its own protocol surface.
   */
  async verifySecondFactor(challengeId: string, code: string, req: Request): Promise<{ kind: 'rejected' } | { kind: 'signed_in'; user: User }> {
    const token = await this.db.authToken.findFirst({
      where: { id: challengeId, purpose: 'MFA_CHALLENGE', consumedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!token || !token.userId || token.attempts >= token.maxAttempts) return { kind: 'rejected' };

    const factor = await this.db.mfaFactor.findFirst({
      where: { userId: token.userId, type: 'TOTP', confirmedAt: { not: null } },
    });
    const good = factor?.secretEnc ? verifyCode(decrypt(factor.secretEnc), code) : false;

    if (!good) {
      await this.db.authToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
      await this.event(token.userId, 'MFA_FAILED', null, req);
      return { kind: 'rejected' };
    }

    const surface = (token.payload as { surface?: Surface } | null)?.surface ?? 'APP';
    await this.db.$transaction([
      this.db.authToken.update({ where: { id: token.id }, data: { consumedAt: new Date() } }),
      this.db.mfaFactor.update({ where: { id: factor!.id }, data: { lastUsedAt: new Date() } }),
    ]);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: token.userId } });
    await this.touchLogin(user.id, surface, req);
    return { kind: 'signed_in', user };
  }

  /** Re-prove a factor inside a live session, opening the step-up window. */
  async verifyStepUp(actor: Actor & { sessionId: string }, code: string, req: Request): Promise<boolean> {
    const factor = await this.db.mfaFactor.findFirst({
      where: { userId: actor.userId, type: 'TOTP', confirmedAt: { not: null } },
    });
    const good = factor?.secretEnc ? verifyCode(decrypt(factor.secretEnc), code) : false;
    if (!good) {
      await this.event(actor.userId, 'MFA_FAILED', actor.surface, req);
      return false;
    }
    await this.sessions.recordStepUp(actor.sessionId);
    await this.event(actor.userId, 'STEP_UP_COMPLETED', actor.surface, req);
    return true;
  }

  /**
   * Builds the Actor for a resolved session. This is the ONLY place authority
   * is assembled, and it reads nothing from the request body.
   */
  async actorFor(
    userId: string,
    surface: Surface,
    session: { id: string; mfaLevel: number; lastStepUpAt: Date | null },
  ): Promise<Actor & { sessionId: string }> {
    const [members, staffRole] = await Promise.all([
      this.db.workspaceMember.findMany({ where: { userId, workspace: { deletedAt: null } }, select: { workspaceId: true, role: true } }),
      this.activeStaffRole(userId),
    ]);
    return {
      userId,
      surface,
      sessionId: session.id,
      staffRole,
      workspaceRoles: new Map(members.map((m) => [m.workspaceId, m.role])),
      mfaLevel: session.mfaLevel,
      lastStepUpAt: session.lastStepUpAt,
      impersonating: false,
    };
  }

  /** Where to send someone after sign-in on this surface. */
  async landingFor(userId: string, surface: Surface): Promise<string> {
    if (surface === 'ADMIN') return '/operations';
    const first = await this.db.workspaceMember.findFirst({ where: { userId, workspace: { deletedAt: null } }, orderBy: { createdAt: 'asc' } });
    return first ? '/today' : '/welcome';
  }

  /** The /auth/me payload: who, where, and whether staff console is reachable. */
  async describeActor(actor: Actor): Promise<Record<string, unknown>> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        phoneIsWhatsApp: true,
        avatarKey: true,
        locale: true,
        timezone: true,
        deleteRequestedAt: true,
        createdAt: true,
      },
    });
    const workspaces = await this.db.workspace.findMany({
      where: { id: { in: [...actor.workspaceRoles.keys()] } },
      select: { id: true, type: true, name: true, currency: true },
    });
    // The picture as a signed URL, the same way the profile screen gets it —
    // the top bar shows this payload, not the profile.
    const avatarUrl = user.avatarKey ? await this.media.signRead(user.avatarKey, 60 * 60).catch(() => null) : null;
    return {
      user: { ...user, avatarUrl },
      surface: actor.surface,
      workspaces: workspaces.map((w) => ({ ...w, role: actor.workspaceRoles.get(w.id) })),
      // Reveals that a grant exists; carries no authority. Reaching the console
      // still means signing in there with a second factor.
      canSwitchToStaff: actor.staffRole !== null,
      // On the ADMIN surface the console needs to know the rank to show the right controls; elsewhere it is not sent.
      ...(actor.surface === 'ADMIN' ? { staffRole: actor.staffRole } : {}),
      mfaLevel: actor.mfaLevel,
    };
  }

  /** Active sessions across every surface, for the security screen. */
  async listSessions(userId: string) {
    return this.db.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
      select: { id: true, surface: true, userAgent: true, geoLabel: true, createdAt: true, lastSeenAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /** The active staff grant for the console header. */
  async staffContext(actor: Actor) {
    const grant = await this.db.staffGrant.findFirst({
      where: { userId: actor.userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { role: true, expiresAt: true, createdAt: true },
    });
    return { grant };
  }

  /** Revokes this one session and records it. */
  async logout(actor: Actor & { sessionId: string }, req: Request): Promise<void> {
    await this.db.session.update({ where: { id: actor.sessionId }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
    await this.event(actor.userId, 'LOGGED_OUT', actor.surface, req);
  }

  /** A replayed refresh token: kill the family and write the row that matters most. */
  async onRefreshReuse(refreshToken: string, req: Request): Promise<void> {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    const s = await this.db.session.findUnique({ where: { refreshHash: hash }, select: { userId: true, refreshFamily: true } });
    if (!s?.refreshFamily) return;
    const n = await this.sessions.revokeFamily(s.refreshFamily, 'refresh_reuse');
    logger.warn({ userId: s.userId, family: s.refreshFamily, revoked: n, requestId: req.requestId }, 'refresh token reuse detected');
    await this.event(s.userId, 'REFRESH_REUSE_DETECTED', null, req, { revoked: n });
  }

  /** Session + refresh cookies. `__Host-` prefix: Secure, path=/, no Domain, enforced by the browser. */
  setCookies(res: Response, surface: Surface, issued: IssuedSession): void {
    const base = SessionService.cookieOptions(surface);
    res.cookie(COOKIE[surface], issued.sessionToken, base);
    res.cookie(`${COOKIE[surface]}_r`, issued.refreshToken, { ...base, path: '/auth/refresh' });
  }

  clearCookies(res: Response, surface: Surface): void {
    res.clearCookie(COOKIE[surface], { path: '/' });
    res.clearCookie(`${COOKIE[surface]}_r`, { path: '/auth/refresh' });
  }

  // ---------------------------------------------------------------- private

  /** Email or E.164 phone — one field, both accepted. */
  private async findByIdentifier(identifier: string): Promise<User | null> {
    const id = identifier.trim();
    if (id.includes('@')) return this.db.user.findUnique({ where: { email: id } });
    // A phone typed any way it is usually typed — with spaces, brackets, or as a local number.
    let phone = id.replace(/[\s().-]/g, '');
    try {
      phone = RegistrationService.normalisePhone(id);
    } catch {
      /* look it up as typed; it will simply not match */
    }
    return this.db.user.findUnique({ where: { phone } });
  }

  private async activeStaffRole(userId: string): Promise<StaffRole | null> {
    const g = await this.db.staffGrant.findFirst({
      where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
      select: { role: true },
    });
    return g?.role ?? null;
  }

  private async openChallenge(userId: string, surface: Surface, req: Request): Promise<string> {
    const id = randomUUID();
    await this.db.authToken.create({
      data: {
        id,
        purpose: 'MFA_CHALLENGE',
        userId,
        tokenHash: createHash('sha256').update(id).digest('hex'),
        payload: { surface },
        maxAttempts: 5,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        createdIp: req.ip,
      },
    });
    return id;
  }

  private async touchLogin(userId: string, surface: Surface, req: Request): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.event(userId, 'LOGIN_SUCCEEDED', surface, req);
  }

  private async event(
    userId: string | null,
    type: Parameters<PrismaClient['authEvent']['create']>[0]['data']['type'],
    surface: Surface | null,
    req: Request,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.authEvent
      .create({
        data: {
          userId,
          type,
          surface,
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get('user-agent')?.slice(0, 400),
          detail: detail ? (detail as Prisma.InputJsonObject) : undefined,
        },
      })
      .catch((e) => logger.warn({ err: e }, 'auth event write failed'));
  }
}
