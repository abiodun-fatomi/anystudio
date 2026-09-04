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
import { createHash, randomUUID } from 'node:crypto';
import { surfaceForOrigin, type AppEnv } from '@anystudio/shared';
import { SessionService, COOKIE, type IssuedSession } from './session.service';
import { verifyPassword, needsRehash, hashPassword } from '../../utils/crypto/password';
import { verifyCode } from '../../utils/crypto/totp';
import { decrypt } from '../../utils/crypto/encrypt';
import { ConflictError } from '../../../config/globals/errors';
import type { Actor } from './policy';
import { logger } from '../../../config/logger';
import { authLog } from './auth.log';

import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
import { VerificationService } from './verification.service';
import { GoogleProvider, OAUTH_COOKIE, OAUTH_COOKIE_OPTS } from './providers/google.provider';
import type { LoginDto, MfaDto, RegisterDto, ForgotPasswordDto, ResetPasswordDto, VerifyEmailDto, StepUpDto,
  GoogleStartQueryDto, GoogleCallbackQueryDto } from './auth.dto';
import type { LoginResult, MfaResult, RegisterResult, RefreshResult, Verified } from './auth.types';
import { Helpers } from '../../utils/helpers';
import { MESSAGES } from '../../utils/constant';
import { GoogleSignInError, VerificationFlavour } from '../../utils/enums';

const CHALLENGE_TTL_MS = 5 * 60_000;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly sessions: SessionService,
    private readonly registration: RegistrationService,
    private readonly resets: PasswordResetService,
    private readonly verification: VerificationService,
    private readonly google: GoogleProvider,
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

    const outcome = await this.registration.register(
      {
        name: dto.name, email: dto.email.toLowerCase(), password: dto.password,
        phone: RegistrationService.normalisePhone(dto.phone),
        phoneIsWhatsApp: dto.phoneIsWhatsApp ?? false,
        marketing: dto.marketing, sourceUrl: dto.sourceUrl,
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
    await this.issueSession(outcome.user, surface, 1, req, res);
    authLog('auth.register', 'succeeded', { userId: outcome.user.id, surface, mfa: 1 }, req);
    return Helpers.successResponse<RegisterResult>(201, MESSAGES.REGISTERED, { status: 'signed_in', next: '/welcome' });
  }

  /**
   * Password step of sign-in. Does NOT mint a session when a second factor
   * is owed — and on the admin surface one always is.
   */
  async login(dto: LoginDto, req: Request, res: Response) {
    const surface = this.surfaceFromOrigin(req);
    const outcome = await this.verifyPassword(dto.identifier, dto.password, surface, req);

    // One shape, one timing profile, whatever went wrong.
    if (outcome.kind === 'rejected') {
      // No userId on purpose: the response does not reveal whether the account
      // exists, and neither should the line describing it.
      authLog('auth.login', 'refused', { reason: 'invalid_credentials', surface }, req);
      return Helpers.successResponse<LoginResult>(200, MESSAGES.INVALID_CREDENTIALS, { status: 'invalid_credentials' });
    }
    if (outcome.kind === 'mfa_required') {
      authLog('auth.login', 'succeeded', { reason: 'mfa_required', surface, factors: outcome.factors }, req);
      return Helpers.successResponse<LoginResult>(200, MESSAGES.MFA_REQUIRED,
        { status: 'mfa_required', challengeId: outcome.challengeId, factors: outcome.factors });
    }
    await this.issueSession(outcome.user, surface, outcome.mfaLevel, req, res);
    authLog('auth.login', 'succeeded', { userId: outcome.user.id, surface, mfa: outcome.mfaLevel }, req);
    return Helpers.successResponse<LoginResult>(200, MESSAGES.SIGNED_IN,
      { status: 'signed_in', next: await this.landingFor(outcome.user.id, surface) });
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
    await this.issueSession(outcome.user, surface, 2, req, res);
    authLog('auth.mfa', 'succeeded', { userId: outcome.user.id, surface, mfa: 2 }, req);
    return Helpers.successResponse<MfaResult>(200, MESSAGES.SIGNED_IN,
      { status: 'signed_in', next: await this.landingFor(outcome.user.id, surface) });
  }

  /** Confirm a fresh second factor for the current session. */
  async stepUp(actor: Actor & { sessionId: string }, dto: StepUpDto, req: Request) {
    const ok = await this.verifyStepUp(actor, dto.code, req);
    authLog('auth.step_up', ok ? 'succeeded' : 'refused',
      { userId: actor.userId, surface: actor.surface, ...(ok ? {} : { reason: 'invalid_code' }) }, req);
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
    return Helpers.successResponse(200, ok ? MESSAGES.RESET_DONE : MESSAGES.INVALID_TOKEN,
      { status: ok ? 'reset' : 'invalid_token' });
  }

  /** Consume a confirmation link. */
  async verifyEmail(dto: VerifyEmailDto) {
    const ok = await this.verification.complete(dto.token);
    authLog('auth.verify', ok ? 'succeeded' : 'refused', ok ? {} : { reason: 'invalid_token' });
    return Helpers.successResponse(200, ok ? MESSAGES.VERIFIED : MESSAGES.INVALID_TOKEN,
      { status: ok ? 'verified' : 'invalid_token' });
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
    authLog('auth.google', 'succeeded',
      { userId: resolved.user.id, surface: state.f, mfa: 1, created: resolved.created }, req);
    const landing = resolved.created ? '/welcome' : await this.landingFor(resolved.user.id, state.f);
    res.redirect(302, state.r !== '/' ? state.r : landing);
  }

  /** Mint a session for a verified user and set its cookies. */
  private async issueSession(user: User, surface: Surface, mfaLevel: number, req: Request, res: Response): Promise<void> {
    const issued = await this.sessions.mint({
      userId: user.id, surface, mfaLevel, credentialEpoch: user.credentialEpoch,
      ip: req.ip, userAgent: req.get('user-agent') ?? undefined,
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
    const raw = process.env.APP_ENV;
    const env: AppEnv = raw === 'production' || raw === 'staging' || raw === 'dev' ? raw : 'local';
    return surfaceForOrigin(this.publicOrigin(req), env) ?? 'APP';
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
      return { kind: 'rejected' };
    }

    const factors = await this.db.mfaFactor.findMany({
      where: { userId: user.id, confirmedAt: { not: null }, type: { in: ['TOTP', 'WEBAUTHN'] } },
      select: { type: true },
    });

    if (surface === 'ADMIN' || factors.length > 0) {
      if (surface === 'ADMIN' && factors.length === 0) {
        // Staff without a factor cannot get in. Enrolment happens on APP first.
        await this.event(user.id, 'LOGIN_FAILED', surface, req, { reason: 'staff_without_mfa' });
        return { kind: 'rejected' };
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
  async verifySecondFactor(challengeId: string, code: string, req: Request):
    Promise<{ kind: 'rejected' } | { kind: 'signed_in'; user: User }> {
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
    if (!good) { await this.event(actor.userId, 'MFA_FAILED', actor.surface, req); return false; }
    await this.sessions.recordStepUp(actor.sessionId);
    await this.event(actor.userId, 'STEP_UP_COMPLETED', actor.surface, req);
    return true;
  }

  /**
   * Builds the Actor for a resolved session. This is the ONLY place authority
   * is assembled, and it reads nothing from the request body.
   */
  async actorFor(userId: string, surface: Surface, session: { id: string; mfaLevel: number; lastStepUpAt: Date | null }): Promise<Actor & { sessionId: string }> {
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
    if (surface === 'ORG') return '/overview';
    const first = await this.db.workspaceMember.findFirst({ where: { userId, workspace: { deletedAt: null } }, orderBy: { createdAt: 'asc' } });
    return first ? '/today' : '/welcome';
  }

  /** The /auth/me payload: who, where, and whether staff console is reachable. */
  async describeActor(actor: Actor): Promise<Record<string, unknown>> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { id: true, name: true, email: true, phone: true, phoneIsWhatsApp: true, avatarKey: true, locale: true, timezone: true, deleteRequestedAt: true, createdAt: true },
    });
    const workspaces = await this.db.workspace.findMany({
      where: { id: { in: [...actor.workspaceRoles.keys()] } },
      select: { id: true, type: true, name: true, currency: true },
    });
    return {
      user,
      surface: actor.surface,
      workspaces: workspaces.map((w) => ({ ...w, role: actor.workspaceRoles.get(w.id) })),
      // Reveals that a grant exists; carries no authority. Reaching the console
      // still means signing in there with a second factor.
      canSwitchToStaff: actor.staffRole !== null,
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
    return id.includes('@')
      ? this.db.user.findUnique({ where: { email: id } })
      : this.db.user.findUnique({ where: { phone: id.replace(/[\s-]/g, '') } });
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
        id, purpose: 'MFA_CHALLENGE', userId,
        tokenHash: createHash('sha256').update(id).digest('hex'),
        payload: { surface }, maxAttempts: 5,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS), createdIp: req.ip,
      },
    });
    return id;
  }

  private async touchLogin(userId: string, surface: Surface, req: Request): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.event(userId, 'LOGIN_SUCCEEDED', surface, req);
  }

  private async event(userId: string | null, type: Parameters<PrismaClient['authEvent']['create']>[0]['data']['type'],
    surface: Surface | null, req: Request, detail?: Record<string, unknown>): Promise<void> {
    await this.db.authEvent.create({
      data: { userId, type, surface, requestId: req.requestId, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 400), detail: detail ? (detail as Prisma.InputJsonObject) : undefined },
    }).catch((e) => logger.warn({ err: e }, 'auth event write failed'));
  }
}
