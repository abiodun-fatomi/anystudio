/**
 * The account: who a person is, how they prove it, and what happens when
 * they want out.
 *
 * Three rules run through every method here:
 *
 *   1. CHANGING A CREDENTIAL COSTS A CREDENTIAL. A session cookie is what an
 *      attacker on a shared laptop already has, so email, password, two-step
 *      and deletion all re-prove the current password (or a fresh code, for
 *      accounts that never had a password). See `reauth`.
 *
 *   2. THE OLD CHANNEL HEARS ABOUT IT. Every change is announced to the
 *      address the person had BEFORE the change, because that is the inbox
 *      the real owner still reads when the account has been taken over.
 *
 *   3. NOTHING HERE IS DESTROYED AT REQUEST TIME. Deletion is a date thirty
 *      days out; sessions and factors are rows with a revokedAt. Most
 *      requests to destroy things are made in a bad hour.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type AuthEventType, type ConsentChannel, type Surface, type User } from '@prisma/client';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { Mailer } from '../../utils/mail-service';
import { hashPassword, verifyPassword } from '../../utils/crypto/password';
import { decrypt, encrypt } from '../../utils/crypto/encrypt';
import { enrolmentUri, newSeed, verifyCode } from '../../utils/crypto/totp';
import { deletionScheduled, emailChangeConfirm, emailChangeNotice, securityNotice } from '../../assets/email-templates';
import { authLog } from '../auth/auth.log';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import type { Actor, SessionActor } from '../auth/policy';
import { MediaService } from '../media/media.service';
import {
  NOTIFICATION_DEFAULTS, type ChangeEmailDto, type ChangePasswordDto, type DeleteAccountDto, type DisableMfaDto,
  type NotificationSwitches, type NotificationsDto, type ProfileDto, type ReauthDto,
} from './account.dto';

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60_000;
export const DELETION_GRACE_DAYS = 30;
const RECOVERY_CODE_COUNT = 10;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

/** `a***@domain` — enough for a person to recognise their own address in an event log, useless to anyone else. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly db: PrismaClient,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly mailer: Mailer,
    private readonly media: MediaService,
  ) {}

  // ---------------------------------------------------------------- profile

  /** Everything the settings screens need in one read. */
  async profile(actor: Actor) {
    const user = await this.user(actor.userId);
    const [factors, identities, recovery] = await Promise.all([
      this.db.mfaFactor.findMany({ where: { userId: user.id, confirmedAt: { not: null } }, select: { id: true, type: true, label: true, confirmedAt: true, lastUsedAt: true } }),
      this.db.identity.findMany({ where: { userId: user.id }, select: { id: true, provider: true, label: true, lastUsedAt: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
      this.db.recoveryCode.count({ where: { userId: user.id, usedAt: null } }),
    ]);
    const pendingChange = await this.db.authToken.findFirst({
      where: { userId: user.id, purpose: 'EMAIL_CHANGE', consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }, select: { payload: true, expiresAt: true },
    });
    const avatarUrl = user.avatarKey ? await this.media.signRead(user.avatarKey, 60 * 60).catch(() => null) : null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      phone: user.phone,
      phoneVerifiedAt: user.phoneVerifiedAt,
      phoneIsWhatsApp: user.phoneIsWhatsApp,
      avatarKey: user.avatarKey,
      avatarUrl,
      locale: user.locale,
      timezone: user.timezone,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      hasPassword: Boolean(user.passwordHash),
      mfa: { enabled: factors.length > 0, factors, recoveryCodesLeft: recovery },
      identities: identities.map((i) => ({ ...i, providerUid: undefined })),
      pendingEmail: pendingChange ? { email: (pendingChange.payload as { newEmail?: string } | null)?.newEmail ?? null, expiresAt: pendingChange.expiresAt } : null,
      deletion: user.deleteRequestedAt ? { requestedAt: user.deleteRequestedAt, deleteOn: this.deleteOn(user.deleteRequestedAt) } : null,
    };
  }

  async updateProfile(actor: Actor, dto: ProfileDto, req: Request) {
    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.locale !== undefined) data.locale = dto.locale;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.avatarKey !== undefined) {
      if (dto.avatarKey === null) data.avatarKey = null;
      else {
        // The picture is a media asset in one of the person's own workspaces —
        // the same READY check the studio applies to a source photo.
        const asset = await this.db.mediaAsset.findUnique({ where: { key: dto.avatarKey }, select: { workspaceId: true } });
        if (!asset || !actor.workspaceRoles.has(asset.workspaceId)) throw new NotFoundError('picture');
        await this.media.requireReady(asset.workspaceId, dto.avatarKey);
        data.avatarKey = dto.avatarKey;
      }
    }
    const user = await this.db.user.update({ where: { id: actor.userId }, data, select: { id: true, name: true, avatarKey: true, locale: true, timezone: true } });
    authLog('account.profile', 'succeeded', { userId: actor.userId, fields: Object.keys(data) }, req);
    return user;
  }

  // ------------------------------------------------------------ email change

  /**
   * Start an email change. Two emails go out: a confirmation link to the new
   * address (nothing changes until it is opened) and a notice to the old one
   * (so the real owner learns about it while they can still act).
   *
   * Always answers 'sent'. Whether the new address already belongs to
   * another account is not something a signed-in user gets to learn by
   * typing addresses into this form.
   */
  async requestEmailChange(actor: SessionActor, dto: ChangeEmailDto, req: Request): Promise<{ status: 'sent' }> {
    const user = await this.user(actor.userId);
    await this.reauth(actor, user, dto, req);
    const newEmail = dto.email.trim().toLowerCase();
    if (user.email && user.email.toLowerCase() === newEmail) throw new ValidationError({ email: 'That is already your email.' });

    const taken = await this.db.user.findUnique({ where: { email: newEmail }, select: { id: true } });
    if (taken) {
      authLog('account.email_change', 'refused', { userId: user.id, reason: 'email_taken' }, req);
      return { status: 'sent' };
    }

    await this.db.authToken.updateMany({ where: { userId: user.id, purpose: 'EMAIL_CHANGE', consumedAt: null }, data: { consumedAt: new Date() } });
    const token = randomBytes(32).toString('base64url');
    await this.db.authToken.create({
      data: { purpose: 'EMAIL_CHANGE', userId: user.id, email: newEmail, tokenHash: sha256(token), payload: { newEmail }, expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS), createdIp: req.ip },
    });

    const origin = this.auth.publicOrigin(req);
    await this.send(emailChangeConfirm(newEmail, user.name, `${origin}/email-change?token=${token}`), 'EMAIL_CHANGE');
    if (user.email) await this.send(emailChangeNotice(user.email, user.name, newEmail, `${origin}/settings/security`), 'EMAIL_CHANGE_NOTICE');
    await this.event(user.id, 'EMAIL_CHANGE_REQUESTED', actor.surface, req, { to: maskEmail(newEmail) });
    authLog('account.email_change', 'succeeded', { userId: user.id, stage: 'requested' }, req);
    return { status: 'sent' };
  }

  /** The link in the new inbox was opened. Public: the person may be on a different device. */
  async confirmEmailChange(token: string, req: Request): Promise<{ status: 'changed' | 'invalid_token' }> {
    const row = await this.db.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.purpose !== 'EMAIL_CHANGE' || !row.userId || row.consumedAt || row.expiresAt < new Date()) {
      authLog('account.email_change', 'refused', { reason: 'invalid_token' }, req);
      return { status: 'invalid_token' };
    }
    const newEmail = (row.payload as { newEmail?: string } | null)?.newEmail;
    if (!newEmail) return { status: 'invalid_token' };
    const taken = await this.db.user.findUnique({ where: { email: newEmail }, select: { id: true } });
    if (taken && taken.id !== row.userId) {
      authLog('account.email_change', 'refused', { userId: row.userId, reason: 'email_taken_meanwhile' }, req);
      return { status: 'invalid_token' };
    }
    const user = await this.user(row.userId);
    await this.db.$transaction([
      this.db.authToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
      this.db.user.update({ where: { id: user.id }, data: { email: newEmail, emailVerifiedAt: new Date() } }),
      // The password identity is keyed by the address it was created with.
      this.db.identity.updateMany({ where: { userId: user.id, provider: 'PASSWORD' }, data: { providerUid: newEmail } }),
    ]);
    await this.event(user.id, 'EMAIL_CHANGED', null, req, { from: user.email ? maskEmail(user.email) : null, to: maskEmail(newEmail) });
    if (user.email) await this.send(securityNotice(user.email, user.name, 'email_changed', new Date(), this.where(req), `${this.auth.publicOrigin(req)}/settings/security`), 'SECURITY_NOTICE');
    authLog('account.email_change', 'succeeded', { userId: user.id, stage: 'confirmed' }, req);
    return { status: 'changed' };
  }

  // --------------------------------------------------------------- password

  /**
   * Change (or, for a Google-only account, set) the password.
   *
   * Every OTHER session ends; this one carries on with the new credential
   * epoch, because a person who just changed their password on this laptop
   * does not need to be thrown out of it to prove the point.
   */
  async changePassword(actor: SessionActor, dto: ChangePasswordDto, req: Request): Promise<{ status: 'changed'; otherSessionsEnded: number }> {
    const user = await this.user(actor.userId);
    await this.reauth(actor, user, dto, req);
    if (user.passwordHash && dto.currentPassword === dto.newPassword) throw new ValidationError({ newPassword: 'That is the password you already have.' });

    const passwordHash = await hashPassword(dto.newPassword);
    const ended = await this.db.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: user.id }, data: { passwordHash, credentialEpoch: { increment: 1 } }, select: { credentialEpoch: true, email: true } });
      if (!user.passwordHash && u.email) {
        await tx.identity.upsert({
          where: { provider_providerUid: { provider: 'PASSWORD', providerUid: u.email } },
          create: { userId: user.id, provider: 'PASSWORD', providerUid: u.email },
          update: {},
        });
      }
      await tx.session.update({ where: { id: actor.sessionId }, data: { credentialEpoch: u.credentialEpoch } });
      const { count } = await tx.session.updateMany({ where: { userId: user.id, id: { not: actor.sessionId }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'password_changed' } });
      return count;
    });
    await this.event(user.id, 'PASSWORD_CHANGED', actor.surface, req, { otherSessionsEnded: ended, set: !user.passwordHash });
    if (user.email) await this.send(securityNotice(user.email, user.name, 'password_changed', new Date(), this.where(req), `${this.auth.publicOrigin(req)}/settings/security`), 'SECURITY_NOTICE');
    authLog('account.password', 'succeeded', { userId: user.id, otherSessionsEnded: ended }, req);
    return { status: 'changed', otherSessionsEnded: ended };
  }

  // -------------------------------------------------------------------- MFA

  /** Step one: a seed the authenticator app scans. Nothing counts until `confirmMfa`. */
  async enrolMfa(actor: Actor, req: Request): Promise<{ factorId: string; secret: string; uri: string }> {
    const user = await this.user(actor.userId);
    const existing = await this.db.mfaFactor.findFirst({ where: { userId: user.id, type: 'TOTP', confirmedAt: { not: null } } });
    if (existing) throw new ConflictError('Two-step sign-in is already on. Turn it off first to set up a new app.');
    await this.db.mfaFactor.deleteMany({ where: { userId: user.id, type: 'TOTP', confirmedAt: null } });
    const seed = newSeed();
    const factor = await this.db.mfaFactor.create({ data: { userId: user.id, type: 'TOTP', secretEnc: encrypt(seed), label: 'Authenticator app' } });
    authLog('account.mfa', 'succeeded', { userId: user.id, stage: 'enrol_started' }, req);
    return { factorId: factor.id, secret: seed, uri: enrolmentUri(seed, user.email ?? user.phone ?? user.id) };
  }

  /** Step two: the first code proves the app holds the seed. Recovery codes are shown once, here. */
  async confirmMfa(actor: SessionActor, code: string, req: Request): Promise<{ status: 'enabled'; recoveryCodes: string[] }> {
    const user = await this.user(actor.userId);
    const factor = await this.db.mfaFactor.findFirst({ where: { userId: user.id, type: 'TOTP', confirmedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!factor?.secretEnc) throw new ConflictError('Start two-step setup first.');
    if (!verifyCode(decrypt(factor.secretEnc), code)) {
      await this.event(user.id, 'MFA_FAILED', actor.surface, req, { stage: 'enrol' });
      authLog('account.mfa', 'refused', { userId: user.id, reason: 'bad_code', stage: 'enrol' }, req);
      throw new ValidationError({ code: 'That code did not match. Check the app and try the newest one.' });
    }
    const codes = await this.db.$transaction(async (tx) => {
      await tx.mfaFactor.update({ where: { id: factor.id }, data: { confirmedAt: new Date(), lastUsedAt: new Date() } });
      return this.issueRecoveryCodes(tx, user.id);
    });
    await this.sessions.recordStepUp(actor.sessionId);
    await this.event(user.id, 'MFA_ENROLLED', actor.surface, req, { type: 'TOTP' });
    if (user.email) await this.send(securityNotice(user.email, user.name, 'mfa_enabled', new Date(), this.where(req), `${this.auth.publicOrigin(req)}/settings/security`), 'SECURITY_NOTICE');
    authLog('account.mfa', 'succeeded', { userId: user.id, stage: 'enabled' }, req);
    return { status: 'enabled', recoveryCodes: codes };
  }

  /**
   * Turn two-step off. Needs the password (if any) AND a current code or a
   * recovery code: this is the one change that makes every later change
   * easier, so it costs both.
   */
  async disableMfa(actor: SessionActor, dto: DisableMfaDto, req: Request): Promise<{ status: 'disabled' }> {
    const user = await this.user(actor.userId);
    if (user.passwordHash) await this.reauth(actor, user, { currentPassword: dto.currentPassword }, req);
    if (!dto.code) throw new ValidationError({ code: 'Enter a code from your app, or a recovery code.' });
    if (!(await this.verifyAnyFactor(user.id, dto.code))) {
      await this.event(user.id, 'MFA_FAILED', actor.surface, req, { stage: 'disable' });
      throw new ValidationError({ code: 'That code did not match.' });
    }
    await this.db.$transaction(async (tx) => {
      await tx.mfaFactor.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      const u = await tx.user.update({ where: { id: user.id }, data: { credentialEpoch: { increment: 1 } }, select: { credentialEpoch: true } });
      await tx.session.update({ where: { id: actor.sessionId }, data: { credentialEpoch: u.credentialEpoch, mfaLevel: 0, lastStepUpAt: null } });
      await tx.session.updateMany({ where: { userId: user.id, id: { not: actor.sessionId }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'mfa_removed' } });
    });
    await this.event(user.id, 'MFA_REMOVED', actor.surface, req);
    if (user.email) await this.send(securityNotice(user.email, user.name, 'mfa_disabled', new Date(), this.where(req), `${this.auth.publicOrigin(req)}/settings/security`), 'SECURITY_NOTICE');
    authLog('account.mfa', 'succeeded', { userId: user.id, stage: 'disabled' }, req);
    return { status: 'disabled' };
  }

  /** A fresh set; the old set stops working the moment these exist. */
  async regenerateRecoveryCodes(actor: SessionActor, code: string, req: Request): Promise<{ recoveryCodes: string[] }> {
    const user = await this.user(actor.userId);
    if (!(await this.verifyAnyFactor(user.id, code))) {
      await this.event(user.id, 'MFA_FAILED', actor.surface, req, { stage: 'recovery_codes' });
      throw new ValidationError({ code: 'That code did not match.' });
    }
    const codes = await this.db.$transaction((tx) => this.issueRecoveryCodes(tx, user.id));
    await this.event(user.id, 'RECOVERY_CODES_REGENERATED', actor.surface, req);
    if (user.email) await this.send(securityNotice(user.email, user.name, 'recovery_codes', new Date(), this.where(req), `${this.auth.publicOrigin(req)}/settings/security`), 'SECURITY_NOTICE');
    authLog('account.recovery_codes', 'succeeded', { userId: user.id }, req);
    return { recoveryCodes: codes };
  }

  // ---------------------------------------------------------------- sessions

  async listSessions(actor: SessionActor) {
    const rows = await this.auth.listSessions(actor.userId);
    return rows.map((s) => ({ ...s, current: s.id === actor.sessionId, device: describeUserAgent(s.userAgent) }));
  }

  async revokeSession(actor: SessionActor, id: string, req: Request): Promise<{ status: 'revoked' }> {
    const s = await this.db.session.findFirst({ where: { id, userId: actor.userId, revokedAt: null }, select: { id: true, surface: true } });
    if (!s) throw new NotFoundError('session');
    if (s.id === actor.sessionId) throw new ConflictError('That is this session. Use Sign out for it.');
    await this.db.session.update({ where: { id }, data: { revokedAt: new Date(), revokedReason: 'user_revoked' } });
    await this.event(actor.userId, 'SESSION_REVOKED', actor.surface, req, { sessionId: id, sessionSurface: s.surface });
    authLog('account.sessions', 'succeeded', { userId: actor.userId, revoked: 1 }, req);
    return { status: 'revoked' };
  }

  /** Every session but this one. The epoch is not bumped: this session must survive. */
  async revokeOtherSessions(actor: SessionActor, req: Request): Promise<{ status: 'revoked'; count: number }> {
    const { count } = await this.db.session.updateMany({ where: { userId: actor.userId, id: { not: actor.sessionId }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'user_revoked_others' } });
    await this.event(actor.userId, 'SESSION_REVOKED', actor.surface, req, { others: count });
    authLog('account.sessions', 'succeeded', { userId: actor.userId, revoked: count }, req);
    return { status: 'revoked', count };
  }

  // -------------------------------------------------------------- identities

  /**
   * Unlink a sign-in method. Refused when it is the last one: an account
   * with no way in is an account whose credits are gone.
   */
  async unlinkIdentity(actor: Actor, id: string, req: Request): Promise<{ status: 'unlinked' }> {
    const user = await this.user(actor.userId);
    const identity = await this.db.identity.findFirst({ where: { id, userId: user.id } });
    if (!identity) throw new NotFoundError('sign-in method');
    if (identity.provider === 'PASSWORD') throw new ConflictError('A password is removed by signing in with something else and asking support — not here.');
    const others = await this.db.identity.count({ where: { userId: user.id, id: { not: id }, provider: { not: 'PASSWORD' } } });
    if (!user.passwordHash && others === 0) throw new ConflictError('That is the only way into this account. Set a password first, then unlink it.');
    await this.db.identity.delete({ where: { id } });
    await this.event(user.id, 'IDENTITY_UNLINKED', actor.surface, req, { provider: identity.provider });
    authLog('account.identity', 'succeeded', { userId: user.id, provider: identity.provider }, req);
    return { status: 'unlinked' };
  }

  // ---------------------------------------------------------------- activity

  /** The person's own security log: the last fifty things that touched their account. */
  async activity(actor: Actor) {
    const rows = await this.db.authEvent.findMany({
      where: { userId: actor.userId }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, type: true, surface: true, ip: true, userAgent: true, detail: true, createdAt: true },
    });
    return rows.map((r) => ({ ...r, device: describeUserAgent(r.userAgent) }));
  }

  // ----------------------------------------------------------- notifications

  async notifications(actor: Actor) {
    const user = await this.user(actor.userId);
    const [email, whatsapp] = await Promise.all([this.latestConsent(user.id, 'EMAIL_MARKETING'), this.latestConsent(user.id, 'WHATSAPP_MARKETING')]);
    return { switches: this.switches(user), emailMarketing: email, whatsappMarketing: whatsapp };
  }

  /**
   * Switches are a JSON merge; marketing choices are append-only Consent
   * rows carrying the exact sentence shown, because "we think they agreed"
   * is not a defence when a regulator asks.
   */
  async updateNotifications(actor: Actor, dto: NotificationsDto, req: Request) {
    const user = await this.user(actor.userId);
    const consents: Prisma.ConsentCreateManyInput[] = [];
    const stamp = { userId: user.id, sourceUrl: dto.sourceUrl, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 400) };
    if (dto.emailMarketing) consents.push({ ...stamp, channel: 'EMAIL_MARKETING', granted: dto.emailMarketing.granted, wording: dto.emailMarketing.wording });
    if (dto.whatsappMarketing) consents.push({ ...stamp, channel: 'WHATSAPP_MARKETING', granted: dto.whatsappMarketing.granted, wording: dto.whatsappMarketing.wording });
    const prefs = { ...((user.prefs as Record<string, unknown> | null) ?? {}) };
    if (dto.switches) prefs.notifications = { ...this.switches(user), ...dto.switches };
    await this.db.$transaction(async (tx) => {
      if (dto.switches) await tx.user.update({ where: { id: user.id }, data: { prefs: prefs as Prisma.InputJsonObject } });
      if (consents.length) await tx.consent.createMany({ data: consents });
    });
    authLog('account.notifications', 'succeeded', { userId: user.id, switches: Object.keys(dto.switches ?? {}), consents: consents.map((c) => `${c.channel}=${c.granted}`) }, req);
    return this.notifications(actor);
  }

  // ------------------------------------------------------------------ export

  /**
   * Everything we hold about the person, as one JSON document. Keys of
   * files rather than the files themselves: the library is where those are
   * downloaded, and a 2 GB response is not a feature.
   */
  async exportData(actor: Actor, req: Request) {
    const userId = actor.userId;
    const workspaceIds = [...actor.workspaceRoles.keys()];
    const [user, identities, consents, events, workspaces, generations, media, ledger] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true, phone: true, phoneIsWhatsApp: true, locale: true, timezone: true, prefs: true, createdAt: true, lastLoginAt: true } }),
      this.db.identity.findMany({ where: { userId }, select: { provider: true, label: true, createdAt: true, lastUsedAt: true } }),
      this.db.consent.findMany({ where: { userId }, select: { channel: true, granted: true, wording: true, sourceUrl: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
      this.db.authEvent.findMany({ where: { userId }, select: { type: true, surface: true, ip: true, userAgent: true, detail: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
      this.db.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, type: true, name: true, currency: true, region: true, profile: true, createdAt: true, brandKit: true } }),
      this.db.generation.findMany({ where: { workspaceId: { in: workspaceIds }, requestedById: userId }, select: { id: true, workspaceId: true, capability: true, status: true, input: true, outputs: true, credits: true, createdAt: true, finishedAt: true }, orderBy: { createdAt: 'asc' } }),
      this.db.mediaAsset.findMany({ where: { workspaceId: { in: workspaceIds }, deletedAt: null }, select: { workspaceId: true, kind: true, key: true, mime: true, bytes: true, filename: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
      this.db.ledgerEntry.findMany({ where: { wallet: { workspaceId: { in: workspaceIds } } }, select: { walletId: true, kind: true, delta: true, balanceAfter: true, reason: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    authLog('account.export', 'succeeded', { userId, generations: generations.length, media: media.length }, req);
    return { exportedAt: new Date().toISOString(), user, identities, consents, securityEvents: events, workspaces, generations, media, ledger };
  }

  // ---------------------------------------------------------------- deletion

  /**
   * Ask for the account to go. Thirty days later a sweeper anonymises it;
   * until then signing in and pressing "Keep my account" undoes this.
   * Refused while the person is the only owner of a workspace with other
   * people in it — those people would lose their work with no warning.
   */
  async requestDeletion(actor: SessionActor, dto: DeleteAccountDto, req: Request) {
    const user = await this.user(actor.userId);
    await this.reauth(actor, user, dto, req);
    const owned = await this.db.workspaceMember.findMany({ where: { userId: user.id, role: 'OWNER' }, select: { workspaceId: true, workspace: { select: { name: true, deletedAt: true } } } });
    for (const o of owned) {
      if (o.workspace.deletedAt) continue;
      const others = await this.db.workspaceMember.count({ where: { workspaceId: o.workspaceId, userId: { not: user.id } } });
      if (others > 0) throw new ConflictError(`You own "${o.workspace.name}", which has other people in it. Transfer ownership or remove them first.`);
    }
    const now = new Date();
    await this.db.$transaction([
      this.db.user.update({ where: { id: user.id }, data: { deleteRequestedAt: now } }),
      this.db.session.updateMany({ where: { userId: user.id, id: { not: actor.sessionId }, revokedAt: null }, data: { revokedAt: now, revokedReason: 'deletion_requested' } }),
    ]);
    await this.event(user.id, 'ACCOUNT_DELETION_REQUESTED', actor.surface, req, { deleteOn: this.deleteOn(now).toISOString() });
    if (user.email) await this.send(deletionScheduled(user.email, user.name, this.deleteOn(now), `${this.auth.publicOrigin(req)}/settings/data`), 'DELETION_SCHEDULED');
    authLog('account.delete', 'succeeded', { userId: user.id, stage: 'requested' }, req);
    return { status: 'scheduled' as const, deleteOn: this.deleteOn(now) };
  }

  async cancelDeletion(actor: Actor, req: Request): Promise<{ status: 'kept' }> {
    const user = await this.user(actor.userId);
    if (!user.deleteRequestedAt) return { status: 'kept' };
    await this.db.user.update({ where: { id: user.id }, data: { deleteRequestedAt: null } });
    await this.event(user.id, 'ACCOUNT_DELETION_CANCELLED', actor.surface, req);
    authLog('account.delete', 'succeeded', { userId: user.id, stage: 'cancelled' }, req);
    return { status: 'kept' };
  }

  // ----------------------------------------------------------------- private

  /**
   * Re-prove the current credential. Password accounts prove the password;
   * password-less accounts with two-step prove a code; an account with
   * neither (Google only, no two-step) has nothing stronger than its session
   * to offer, and is let through — the notice to the old email is the
   * safety net there.
   */
  private async reauth(actor: SessionActor, user: User, dto: ReauthDto, req: Request): Promise<void> {
    if (user.passwordHash) {
      if (!dto.currentPassword) throw new ValidationError({ currentPassword: 'Enter your current password.' });
      if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
        await this.event(user.id, 'LOGIN_FAILED', actor.surface, req, { reason: 'reauth' });
        authLog('account.reauth', 'refused', { userId: user.id, reason: 'bad_password' }, req);
        throw new ValidationError({ currentPassword: 'That is not your current password.' });
      }
      return;
    }
    const factor = await this.db.mfaFactor.findFirst({ where: { userId: user.id, confirmedAt: { not: null } }, select: { id: true } });
    if (factor) {
      if (!dto.code) throw new ValidationError({ code: 'Enter a code from your authenticator app.' });
      if (!(await this.verifyAnyFactor(user.id, dto.code))) {
        await this.event(user.id, 'MFA_FAILED', actor.surface, req, { stage: 'reauth' });
        authLog('account.reauth', 'refused', { userId: user.id, reason: 'bad_code' }, req);
        throw new ValidationError({ code: 'That code did not match.' });
      }
      return;
    }
    authLog('account.reauth', 'succeeded', { userId: user.id, reason: 'no_credential_to_prove' }, req);
  }

  /** A TOTP code from the confirmed factor, or an unused recovery code (consumed on match). */
  private async verifyAnyFactor(userId: string, code: string): Promise<boolean> {
    const clean = code.replace(/[\s-]/g, '').toUpperCase();
    const factor = await this.db.mfaFactor.findFirst({ where: { userId, type: 'TOTP', confirmedAt: { not: null } } });
    if (factor?.secretEnc && verifyCode(decrypt(factor.secretEnc), clean)) {
      await this.db.mfaFactor.update({ where: { id: factor.id }, data: { lastUsedAt: new Date() } });
      return true;
    }
    if (clean.length === 8) {
      const hit = await this.db.recoveryCode.findFirst({ where: { userId, usedAt: null, codeHash: sha256(clean) } });
      if (hit) {
        await this.db.recoveryCode.update({ where: { id: hit.id }, data: { usedAt: new Date() } });
        logger.warn({ userId }, 'a recovery code was used');
        return true;
      }
    }
    return false;
  }

  /** Ten codes of eight characters from an unambiguous alphabet, shown once, stored hashed. */
  private async issueRecoveryCodes(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join(''));
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(c) })) });
    return codes.map((c) => `${c.slice(0, 4)}-${c.slice(4)}`);
  }

  private async user(id: string): Promise<User> {
    const u = await this.db.user.findUnique({ where: { id } });
    if (!u || u.status === 'DELETED') throw new NotFoundError('account');
    return u;
  }

  private switches(user: User): NotificationSwitches {
    const stored = ((user.prefs as { notifications?: Partial<NotificationSwitches> } | null)?.notifications) ?? {};
    return { ...NOTIFICATION_DEFAULTS, ...stored };
  }

  private async latestConsent(userId: string, channel: ConsentChannel) {
    const row = await this.db.consent.findFirst({ where: { userId, channel }, orderBy: { createdAt: 'desc' }, select: { granted: true, wording: true, createdAt: true } });
    return row ? { granted: row.granted, wording: row.wording, at: row.createdAt } : { granted: false, wording: null, at: null };
  }

  deleteOn(requestedAt: Date): Date {
    return new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60_000);
  }

  private where(req: Request): string | null {
    const ua = describeUserAgent(req.get('user-agent') ?? null);
    return [ua, req.ip].filter(Boolean).join(' · ') || null;
  }

  private async send(mail: Parameters<Mailer['send']>[0], purpose: string): Promise<void> {
    await this.mailer.send(mail).catch((err: unknown) => logger.error({ err, purpose, to: maskEmail(mail.to) }, 'account mail failed'));
  }

  private async event(userId: string, type: AuthEventType, surface: Surface | null, req: Request, detail?: Record<string, unknown>): Promise<void> {
    await this.db.authEvent.create({
      data: { userId, type, surface, requestId: req.requestId, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 400), detail: detail ? (detail as Prisma.InputJsonObject) : undefined },
    }).catch((e) => logger.warn({ err: e, type }, 'auth event write failed'));
  }
}

/** "Chrome on Android", from a user-agent string. Good enough for a person to recognise their own phone. */
export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'a browser';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}
