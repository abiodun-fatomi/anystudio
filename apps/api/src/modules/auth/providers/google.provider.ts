/**
 * Sign in with Google — as an identity, not as an auth system.
 *
 * Google tells us who someone is. Everything after that is ours: the session
 * is minted by SessionService for exactly one surface, staff authority still
 * comes from a StaffGrant, and an admin session still needs a second factor.
 * Signing in with Google never skips any of that.
 *
 * The handshake is Authorization Code + PKCE with a state parameter and a
 * nonce. All three matter and none is optional:
 *   state    — the request came from us, not from a link someone was sent
 *   PKCE     — the code cannot be redeemed by whoever intercepts it
 *   nonce    — the id_token was minted for this attempt, not replayed
 *
 * They travel in one short-lived encrypted cookie rather than a database row,
 * so the flow adds no schema and no cleanup job. The cookie is set and read
 * on the same origin the browser is already on, which is why the callback is
 * proxied through the web app rather than living on the API's own hostname.
 */

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';
import type { Request } from 'express';
import type { Surface } from '@anystudio/shared';
import { encrypt, decrypt } from '../../../utils/crypto/encrypt';
import { logger } from '../../../../config/logger';
import { GOOGLE_CALLBACK_PATH } from '../../../utils/constant';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
/** Google's own tokeninfo endpoint verifies the id_token signature for us. */
const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';

/** The handshake is a redirect away and back; anything longer is a stale tab. */
const STATE_TTL_MS = 10 * 60_000;

export const OAUTH_COOKIE = '__Host-as_oauth';

/** Attributes for the short-lived handshake cookie. Deliberately not configurable. */
export const OAUTH_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  // 'lax' and not 'strict': the browser arrives back here from accounts.google.com,
  // and a strict cookie would not be sent on that navigation.
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 10 * 60_000,
};

export interface OAuthState {
  /** CSRF token, echoed by Google in the query string. */
  s: string;
  /** PKCE code_verifier. */
  v: string;
  /** Replay guard, echoed inside the id_token. */
  n: string;
  /** Surface the session will be minted for. */
  f: Surface;
  /** Where to send the browser afterwards, inside our own app. */
  r: string;
  /** Origin that started it — also the redirect_uri's origin. */
  o: string;
  /** Issued-at, ms. */
  t: number;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

const b64url = (b: Buffer): string => b.toString('base64url');

@Injectable()
export class GoogleProvider {
  constructor(private readonly db: PrismaClient) {}

  /** Configured only when both halves are present; a half-configured client fails loudly. */
  get configured(): boolean {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }

  /** Every environment's callback is on its own origin, so it is derived, never configured. */
  redirectUri(origin: string): string {
    return `${origin}${GOOGLE_CALLBACK_PATH}`;
  }

  /**
   * Build the URL to send the browser to, and the cookie that remembers why.
   *
   * `next` is where we return the person afterwards. It is stored as a path
   * and re-checked on the way back, so a crafted link cannot turn our own
   * callback into an open redirect.
   */
  begin(origin: string, surface: Surface, next: string): { url: string; cookie: string } {
    const state: OAuthState = {
      s: b64url(randomBytes(24)),
      v: b64url(randomBytes(32)),
      n: b64url(randomBytes(16)),
      f: surface,
      r: next.startsWith('/') && !next.startsWith('//') ? next : '/',
      o: origin,
      t: Date.now(),
    };

    const challenge = b64url(createHash('sha256').update(state.v).digest());
    const url = new URL(AUTHORIZE);
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID ?? '');
    url.searchParams.set('redirect_uri', this.redirectUri(origin));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state.s);
    url.searchParams.set('nonce', state.n);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Ask every time rather than silently reusing a stale grant, so a shared
    // laptop does not sign the previous person back in.
    url.searchParams.set('prompt', 'select_account');

    return { url: url.toString(), cookie: encrypt(JSON.stringify(state)) };
  }

  /** Read back the cookie, or null if it is missing, tampered with or stale. */
  readState(cookie: string | undefined): OAuthState | null {
    if (!cookie) return null;
    try {
      const state = JSON.parse(decrypt(cookie)) as OAuthState;
      if (Date.now() - state.t > STATE_TTL_MS) return null;
      return state;
    } catch {
      return null;
    }
  }

  /** Constant-time, because this compares a secret the caller supplied. */
  static matches(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  /**
   * Exchange the code and validate the identity token.
   *
   * The checks are the whole point of this method: an id_token that is not
   * Google's, not ours, expired, or not from this attempt is not an identity.
   */
  async exchange(code: string, state: OAuthState): Promise<GoogleProfile | null> {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: this.redirectUri(state.o),
        grant_type: 'authorization_code',
        code_verifier: state.v,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'google token exchange refused');
      return null;
    }
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) return null;

    // Verifying the signature ourselves would mean fetching and caching
    // Google's JWKS; their tokeninfo endpoint does it, and this runs once per
    // sign-in rather than once per request.
    const info = await fetch(`${TOKENINFO}?id_token=${encodeURIComponent(body.id_token)}`);
    if (!info.ok) return null;
    const claims = (await info.json()) as Record<string, string>;

    const okIssuer = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
    const okAudience = claims.aud === process.env.GOOGLE_CLIENT_ID;
    const okNonce = typeof claims.nonce === 'string' && GoogleProvider.matches(claims.nonce, state.n);
    const okExpiry = Number(claims.exp ?? 0) * 1000 > Date.now();
    if (!okIssuer || !okAudience || !okNonce || !okExpiry || !claims.sub || !claims.email) {
      logger.warn({ okIssuer, okAudience, okNonce, okExpiry }, 'google id_token rejected');
      return null;
    }

    return {
      sub: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified: claims.email_verified === 'true' || String(claims.email_verified) === 'true',
      name: claims.name ?? null,
      picture: claims.picture ?? null,
    };
  }

  /**
   * Turn a Google profile into one of our users.
   *
   * Three cases, and the middle one is where accounts get stolen if you are
   * careless:
   *
   *  1. We have seen this Google account before → that user.
   *  2. We have not, but the email matches an existing account → link them,
   *     but ONLY if Google says the address is verified. Without that check,
   *     anyone who can create a Google account claiming an address could take
   *     over the AnyStudio account that uses it.
   *  3. Neither → a new user, already verified, with no password. Absence of
   *     a password must never mean any password works: verifyPassword already
   *     refuses a null hash.
   *
   * A new user created here gets no workspace. The welcome flow asks for that
   * on first sign-in, and inventing one for someone who may be joining a
   * colleague's team would leave an empty studio behind forever.
   */
  async resolveUser(profile: GoogleProfile, req: Request): Promise<{ user: User; created: boolean } | null> {
    const identity = await this.db.identity.findUnique({
      where: { provider_providerUid: { provider: 'GOOGLE', providerUid: profile.sub } },
      include: { user: true },
    });
    if (identity) {
      await this.db.identity.update({ where: { id: identity.id }, data: { lastUsedAt: new Date() } });
      return { user: identity.user, created: false };
    }

    const existing = await this.db.user.findUnique({ where: { email: profile.email } });
    if (existing) {
      if (!profile.emailVerified) {
        logger.warn({ email: profile.email }, 'google sign-in refused: unverified address matches an account');
        return null;
      }
      await this.db.$transaction([
        this.db.identity.create({
          data: { userId: existing.id, provider: 'GOOGLE', providerUid: profile.sub, label: profile.email, lastUsedAt: new Date() },
        }),
        this.db.user.update({
          where: { id: existing.id },
          data: { emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
        }),
        this.db.authEvent.create({
          data: { userId: existing.id, type: 'LOGIN_SUCCEEDED', requestId: req.requestId, ip: req.ip,
            detail: { via: 'google', linked: true } },
        }),
      ]);
      return { user: existing, created: false };
    }

    if (!profile.emailVerified) return null;

    const user = await this.db.user.create({
      data: {
        email: profile.email,
        emailVerifiedAt: new Date(),
        name: profile.name,
        identities: { create: { provider: 'GOOGLE', providerUid: profile.sub, label: profile.email, lastUsedAt: new Date() } },
      },
    });
    await this.db.authEvent.create({
      data: { userId: user.id, type: 'SIGNED_UP', requestId: req.requestId, ip: req.ip, detail: { via: 'google' } },
    });
    return { user, created: true };
  }
}
