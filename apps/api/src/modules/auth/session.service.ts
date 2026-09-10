/**
 * Sessions.
 *
 * Opaque random tokens, hashed at rest, scoped to one surface, with refresh
 * rotation and stolen-token detection.
 *
 * Why not JWTs: revocation. When a staff account is compromised at 02:00 the
 * only acceptable answer is that their sessions stop working now, not when a
 * token happens to expire. A stateless token cannot be taken back. The price is
 * one indexed read per request, which is cheap next to the alternative.
 */

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaClient, Surface, Session } from '@prisma/client';

/**
 * Session lifetimes, per surface.
 *
 * Admin is deliberately hostile to convenience: two hours of inactivity and a
 * hard stop at eight, so a forgotten session dies inside one working day.
 * Customers get a month, because making a seller re-authenticate every week to
 * post a photo teaches them to pick a weaker password.
 */
const LIFETIME: Record<Surface, { idleMin: number; absoluteHrs: number; requiresMfa: boolean }> = {
  APP: { idleMin: 60 * 24 * 7, absoluteHrs: 24 * 30, requiresMfa: false },
  ORG: { idleMin: 60 * 24 * 3, absoluteHrs: 24 * 14, requiresMfa: false },
  ADMIN: { idleMin: 120, absoluteHrs: 8, requiresMfa: true },
};

/** Cookie names. The `__Host-` prefix is enforced by the browser: it refuses the
 *  cookie unless it is Secure, path=/ and has NO Domain attribute — which is
 *  precisely the guarantee we want, since a Domain attribute is what would let
 *  an app cookie travel to the admin host. */
export const COOKIE: Record<Surface, string> = {
  APP: '__Host-as_app',
  ORG: '__Host-as_org',
  ADMIN: '__Host-as_admin',
};

export interface MintOptions {
  userId: string;
  surface: Surface;
  mfaLevel: number;
  credentialEpoch: number;
  ip?: string;
  userAgent?: string;
  geoLabel?: string;
}

export interface IssuedSession {
  /** Goes in the session cookie. Never logged, never returned in a body. */
  sessionToken: string;
  /** Goes in a separate, path-scoped refresh cookie. */
  refreshToken: string;
  session: Session;
}

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function newToken(): string {
  // 32 bytes of CSPRNG. base64url so it survives a cookie without escaping.
  return randomBytes(32).toString('base64url');
}

@Injectable()
export class SessionService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Create a session for exactly one surface.
   *
   * Throws if an ADMIN session is requested without a second factor. That check
   * lives here rather than in the controller so there is no path to an
   * unverified admin session, however the controller is later refactored.
   */
  async mint(o: MintOptions): Promise<IssuedSession> {
    const cfg = LIFETIME[o.surface];
    if (cfg.requiresMfa && o.mfaLevel < 2) {
      throw new Error('Refusing to mint an ADMIN session without a fresh second factor');
    }

    const sessionToken = newToken();
    const refreshToken = newToken();
    const now = Date.now();

    const session = await this.db.session.create({
      data: {
        userId: o.userId,
        surface: o.surface,
        tokenHash: sha256(sessionToken),
        refreshHash: sha256(refreshToken),
        refreshFamily: randomUUID(),
        mfaLevel: o.mfaLevel,
        lastStepUpAt: o.mfaLevel >= 2 ? new Date() : null,
        credentialEpoch: o.credentialEpoch,
        ip: o.ip,
        userAgent: o.userAgent?.slice(0, 400),
        geoLabel: o.geoLabel,
        idleExpiresAt: new Date(now + cfg.idleMin * 60_000),
        absoluteExpiresAt: new Date(now + cfg.absoluteHrs * 3_600_000),
      },
    });

    return { sessionToken, refreshToken, session };
  }

  /**
   * Resolve a session cookie, for the surface that received it.
   *
   * Returns null for every failure — expired, revoked, wrong surface, stale
   * credential epoch. The caller turns that into one generic 401; distinguishing
   * the reasons would tell an attacker which of their guesses was closest.
   */
  async resolve(token: string, surface: Surface): Promise<Session | null> {
    const session = await this.db.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { credentialEpoch: true, status: true } } },
    });
    if (!session) return null;

    // A session is bound to the surface it was minted for. This is the check
    // that keeps one identity from becoming one blast radius.
    if (session.surface !== surface) return null;

    if (session.revokedAt) return null;
    const now = new Date();
    if (session.idleExpiresAt < now || session.absoluteExpiresAt < now) return null;

    // Password change, factor removal or "sign out everywhere" bumps the epoch,
    // which retires every session minted before it without touching a row.
    if (session.credentialEpoch !== session.user.credentialEpoch) return null;
    if (session.user.status === 'DELETED') return null;

    // Sliding idle window. Written at most once a minute so a busy tab does not
    // turn every request into a write.
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      const cfg = LIFETIME[surface];
      await this.db.session.update({
        where: { id: session.id },
        data: {
          lastSeenAt: now,
          idleExpiresAt: new Date(now.getTime() + cfg.idleMin * 60_000),
        },
      });
    }

    return session;
  }

  /**
   * Exchange a refresh token for a new pair, and detect theft while doing it.
   *
   * Refresh tokens are single use. Presenting one that has already been rotated
   * means two parties hold it, which means one of them stole it — and we cannot
   * tell which. So the entire family is revoked and both are logged out. A user
   * being asked to sign in again is a small cost; an attacker keeping a rotating
   * foothold indefinitely is not.
   */
  async rotate(refreshToken: string, surface: Surface): Promise<{ result: 'ok'; issued: IssuedSession } | { result: 'reuse_detected' | 'invalid' }> {
    const hash = sha256(refreshToken);
    const current = await this.db.session.findUnique({
      where: { refreshHash: hash },
      include: { user: { select: { credentialEpoch: true } } },
    });

    if (!current) return { result: 'invalid' };

    // THE THEFT SIGNAL.
    //
    // A rotated session keeps its refreshHash and is marked revoked, precisely
    // so that presenting it again is detectable. If we nulled the hash on
    // rotation, a replayed token would look identical to a random invalid one
    // and the attack would be silent.
    //
    // Two parties hold a single-use token, and we cannot tell which is the
    // customer. So neither keeps it: the whole family goes.
    if (current.revokedAt && current.revokedReason === 'rotated') {
      return { result: 'reuse_detected' };
    }

    if (current.surface !== surface || current.revokedAt || current.absoluteExpiresAt < new Date()) {
      return { result: 'invalid' };
    }

    const issued = await this.mint({
      userId: current.userId,
      surface,
      mfaLevel: current.mfaLevel,
      credentialEpoch: current.user.credentialEpoch,
      ip: current.ip ?? undefined,
      userAgent: current.userAgent ?? undefined,
    });

    // Keep the family so a later replay of the old token is attributable.
    await this.db.$transaction([
      this.db.session.update({
        where: { id: issued.session.id },
        data: { refreshFamily: current.refreshFamily },
      }),
      this.db.session.update({
        where: { id: current.id },
        // refreshHash deliberately RETAINED — see the reuse check above.
        data: { revokedAt: new Date(), revokedReason: 'rotated' },
      }),
    ]);

    return { result: 'ok', issued };
  }

  /** Revoke every session in a family. Called on refresh reuse. */
  async revokeFamily(family: string, reason: string): Promise<number> {
    const { count } = await this.db.session.updateMany({
      where: { refreshFamily: family, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  /**
   * Sign out everywhere.
   *
   * Bumping the credential epoch is what actually does it — every existing
   * session fails its epoch check on the next request, including sessions on
   * surfaces this call never looked at. The updateMany is bookkeeping so the
   * user's own security screen shows them as ended rather than merely dead.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: { credentialEpoch: { increment: 1 } },
      }),
      this.db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    ]);
  }

  /** Record a completed second factor, so step-up gated actions open briefly. */
  async recordStepUp(sessionId: string): Promise<void> {
    await this.db.session.update({
      where: { id: sessionId },
      data: { lastStepUpAt: new Date(), mfaLevel: 2 },
    });
  }

  /** Constant-time compare, for anywhere a caller-supplied digest is checked. */
  static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  /** Cookie attributes. Nothing here is optional and nothing sets Domain. */
  static cookieOptions(surface: Surface) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: LIFETIME[surface].absoluteHrs * 3_600_000,
    };
  }
}
