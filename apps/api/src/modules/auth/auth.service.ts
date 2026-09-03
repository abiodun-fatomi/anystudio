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
import { verifyPassword, needsRehash, hashPassword } from '../../common/crypto/password';
import { verifyCode } from '../../common/crypto/totp';
import { decrypt } from '../../common/crypto/encrypt';
import { UnauthorizedError } from '../../common/errors/app-error';
import type { Actor } from '../../common/policy/policy';
import { logger } from '../../common/logging/logger';

type Verified =
  | { kind: 'rejected' }
  | { kind: 'mfa_required'; challengeId: string; factors: Array<'TOTP' | 'WEBAUTHN'> }
  | { kind: 'signed_in'; user: User; mfaLevel: number };

const CHALLENGE_TTL_MS = 5 * 60_000;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly sessions: SessionService,
  ) {}

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
      this.db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true, role: true } }),
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
    const first = await this.db.workspaceMember.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return first ? '/today' : '/welcome';
  }

  /** The /auth/me payload: who, where, and whether staff console is reachable. */
  async describeActor(actor: Actor): Promise<Record<string, unknown>> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { id: true, name: true, email: true, phone: true, phoneIsWhatsApp: true, createdAt: true },
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
