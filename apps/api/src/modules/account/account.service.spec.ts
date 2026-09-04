/**
 * Integration tests against a real Postgres (skipped without DATABASE_URL,
 * run on every pull request in CI). The properties that matter here are
 * database properties: which sessions survive a password change, whether a
 * last credential can be unlinked, whether a consent row is appended rather
 * than edited.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { authenticator } from 'otplib';
import { AccountService, describeUserAgent, maskEmail } from './account.service';
import { MemberService } from '../member/member.service';
import { SessionService } from '../auth/session.service';
import { MediaService } from '../media/media.service';
import { LogMailer, type Mail } from '../../utils/mail-service';
import { hashPassword } from '../../utils/crypto/password';
import type { AuthService } from '../auth/auth.service';
import type { SessionActor } from '../auth/policy';
import { AppError } from '../../../config/globals/errors';

describe('describeUserAgent', () => {
  it('names the browser and platform a person would recognise', () => {
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 13; SM-A5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(describeUserAgent(null)).toBeNull();
  });
});

describe('maskEmail', () => {
  it('keeps one character and the domain', () => {
    expect(maskEmail('adaeze@bimbofabrics.ng')).toBe('a***@bimbofabrics.ng');
  });
});

const url = process.env.DATABASE_URL;
const suite = url && process.env.APP_KEY ? describe : describe.skip;

/** A mailer that keeps what it sent, so a test can assert on the old inbox. */
class CapturingMailer extends LogMailer {
  sent: Mail[] = [];
  override async send(mail: Mail) { this.sent.push(mail); return super.send(mail); }
}

suite('AccountService', () => {
  const db = new PrismaClient();
  const sessions = new SessionService(db);
  const mailer = new CapturingMailer();
  const auth = {
    publicOrigin: () => 'https://app.test',
    listSessions: (userId: string) => db.session.findMany({ where: { userId, revokedAt: null }, select: { id: true, surface: true, userAgent: true, geoLabel: true, createdAt: true, lastSeenAt: true } }),
  } as unknown as AuthService;
  const service = new AccountService(db, sessions, auth, mailer, new MediaService(db));
  const req = { ip: '127.0.0.1', requestId: 'req_test', get: () => 'Mozilla/5.0 (Macintosh; Mac OS X) Chrome/120 Safari/537.36' } as unknown as Request;

  let userId: string;
  let workspaceId: string;
  let email: string;
  let current: SessionActor;
  let other: SessionActor;

  beforeAll(async () => { await db.$connect(); });
  afterAll(async () => { await db.$disconnect(); });

  async function actorFor(sessionId: string): Promise<SessionActor> {
    return { userId, sessionId, surface: 'APP', staffRole: null, workspaceRoles: new Map([[workspaceId, 'OWNER']]), mfaLevel: 0, lastStepUpAt: null, impersonating: false };
  }

  beforeEach(async () => {
    mailer.sent = [];
    email = `acct-${crypto.randomUUID()}@test.local`;
    const user = await db.user.create({ data: { email, name: 'Ada Test', passwordHash: await hashPassword('correct horse'), identities: { create: { provider: 'PASSWORD', providerUid: email } } } });
    userId = user.id;
    const ws = await db.workspace.create({ data: { type: 'PERSONAL', name: 'Ada', members: { create: { userId, role: 'OWNER' } }, wallet: { create: {} } } });
    workspaceId = ws.id;
    const a = await sessions.mint({ userId, surface: 'APP', mfaLevel: 0, credentialEpoch: 0, userAgent: 'laptop' });
    const b = await sessions.mint({ userId, surface: 'APP', mfaLevel: 0, credentialEpoch: 0, userAgent: 'phone' });
    current = await actorFor(a.session.id);
    other = await actorFor(b.session.id);
  });

  it('changing the password ends every other session and keeps this one', async () => {
    const r = await service.changePassword(current, { currentPassword: 'correct horse', newPassword: 'battery staple 9' }, req);
    expect(r.otherSessionsEnded).toBe(1);
    const [mine, theirs, user] = await Promise.all([
      db.session.findUniqueOrThrow({ where: { id: current.sessionId } }),
      db.session.findUniqueOrThrow({ where: { id: other.sessionId } }),
      db.user.findUniqueOrThrow({ where: { id: userId } }),
    ]);
    expect(mine.revokedAt).toBeNull();
    expect(mine.credentialEpoch).toBe(user.credentialEpoch);
    expect(theirs.revokedAt).not.toBeNull();
    expect(mailer.sent.map((m) => m.subject)).toContain('Your AnyStudio password was changed');
    const events = await db.authEvent.findMany({ where: { userId, type: 'PASSWORD_CHANGED' } });
    expect(events).toHaveLength(1);
  });

  it('refuses a password change without the current password, as a field error', async () => {
    await expect(service.changePassword(current, { currentPassword: 'wrong', newPassword: 'battery staple 9' }, req))
      .rejects.toMatchObject({ status: 400, details: { currentPassword: expect.any(String) } });
    const failed = await db.authEvent.count({ where: { userId, type: 'LOGIN_FAILED' } });
    expect(failed).toBe(1);
  });

  it('email change: link to the new address, notice to the old, nothing changes until confirmed', async () => {
    await service.requestEmailChange(current, { currentPassword: 'correct horse', email: `new-${crypto.randomUUID()}@test.local` }, req);
    expect(mailer.sent).toHaveLength(2);
    const confirm = mailer.sent.find((m) => m.subject.startsWith('Confirm'))!;
    const notice = mailer.sent.find((m) => m.to === email)!;
    expect(notice.subject).toMatch(/change the email/);
    const before = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(before.email).toBe(email);

    const token = /token=([A-Za-z0-9_-]+)/.exec(confirm.text)![1]!;
    const r = await service.confirmEmailChange(token, req);
    expect(r.status).toBe('changed');
    const after = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { identities: true } });
    expect(after.email).toBe(confirm.to);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.identities.find((i) => i.provider === 'PASSWORD')?.providerUid).toBe(confirm.to);
    // The old address is told, and the link is dead.
    expect(mailer.sent.at(-1)?.to).toBe(email);
    expect((await service.confirmEmailChange(token, req)).status).toBe('invalid_token');
  });

  it('an email already on another account still answers "sent" and sends nothing', async () => {
    const otherEmail = `taken-${crypto.randomUUID()}@test.local`;
    await db.user.create({ data: { email: otherEmail } });
    const r = await service.requestEmailChange(current, { currentPassword: 'correct horse', email: otherEmail }, req);
    expect(r.status).toBe('sent');
    expect(mailer.sent).toHaveLength(0);
  });

  it('two-step: enrol, confirm with a real code, get recovery codes once, and a recovery code works for disable', async () => {
    const { secret } = await service.enrolMfa(current, req);
    await expect(service.confirmMfa(current, '000000', req)).rejects.toMatchObject({ status: 400 });
    const r = await service.confirmMfa(current, authenticator.generate(secret), req);
    expect(r.recoveryCodes).toHaveLength(10);
    expect(r.recoveryCodes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const p = await service.profile(current);
    expect(p.mfa.enabled).toBe(true);
    expect(p.mfa.recoveryCodesLeft).toBe(10);

    await expect(service.enrolMfa(current, req)).rejects.toMatchObject({ status: 409 });

    const d = await service.disableMfa(current, { currentPassword: 'correct horse', code: r.recoveryCodes[3]! }, req);
    expect(d.status).toBe('disabled');
    expect(await db.mfaFactor.count({ where: { userId } })).toBe(0);
    expect(await db.recoveryCode.count({ where: { userId } })).toBe(0);
    const mine = await db.session.findUniqueOrThrow({ where: { id: current.sessionId } });
    expect(mine.revokedAt).toBeNull();
    expect(mine.mfaLevel).toBe(0);
  });

  it('the last sign-in method cannot be unlinked', async () => {
    const google = await db.identity.create({ data: { userId, provider: 'GOOGLE', providerUid: `g-${userId}` } });
    // With a password it can go.
    await service.unlinkIdentity(current, google.id, req);
    // Without one, and with only Google, it cannot.
    await db.user.update({ where: { id: userId }, data: { passwordHash: null } });
    const again = await db.identity.create({ data: { userId, provider: 'GOOGLE', providerUid: `g2-${userId}` } });
    await expect(service.unlinkIdentity(current, again.id, req)).rejects.toBeInstanceOf(AppError);
  });

  it('sessions: revoke one, revoke others, never this one by id', async () => {
    const list = await service.listSessions(current);
    expect(list.find((s) => s.current)?.id).toBe(current.sessionId);
    await expect(service.revokeSession(current, current.sessionId, req)).rejects.toMatchObject({ status: 409 });
    await service.revokeSession(current, other.sessionId, req);
    expect((await db.session.findUniqueOrThrow({ where: { id: other.sessionId } })).revokedAt).not.toBeNull();
    const r = await service.revokeOtherSessions(current, req);
    expect(r.count).toBe(0);
  });

  it('notifications: switches merge, marketing choices append consent rows with the wording', async () => {
    await service.updateNotifications(current, { switches: { weeklyDigest: true }, emailMarketing: { granted: true, wording: 'Email me tips and offers.' } }, req);
    await service.updateNotifications(current, { emailMarketing: { granted: false, wording: 'Email me tips and offers.' } }, req);
    const n = await service.notifications(current);
    expect(n.switches).toMatchObject({ weeklyDigest: true, generationDoneEmail: true });
    expect(n.emailMarketing.granted).toBe(false);
    expect(await db.consent.count({ where: { userId, channel: 'EMAIL_MARKETING' } })).toBe(2);
  });

  it('deletion: scheduled 30 days out, other sessions ended, refused while owning a shared workspace, cancellable', async () => {
    const mate = await db.user.create({ data: { email: `mate-${crypto.randomUUID()}@test.local` } });
    await db.workspaceMember.create({ data: { workspaceId, userId: mate.id, role: 'MEMBER' } });
    await expect(service.requestDeletion(current, { currentPassword: 'correct horse', confirm: 'DELETE' }, req)).rejects.toMatchObject({ status: 409 });
    await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: mate.id } } });

    const r = await service.requestDeletion(current, { currentPassword: 'correct horse', confirm: 'DELETE' }, req);
    expect(r.deleteOn.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
    expect((await db.session.findUniqueOrThrow({ where: { id: other.sessionId } })).revokedAt).not.toBeNull();
    expect((await db.session.findUniqueOrThrow({ where: { id: current.sessionId } })).revokedAt).toBeNull();
    expect((await service.profile(current)).deletion).not.toBeNull();
    await service.cancelDeletion(current, req);
    expect((await service.profile(current)).deletion).toBeNull();
  });

  it('export carries the person, their consents and their workspaces', async () => {
    const x = await service.exportData(current, req);
    expect(x.user.email).toBe(email);
    expect(x.workspaces.map((w) => w.id)).toContain(workspaceId);
    expect(Array.isArray(x.securityEvents)).toBe(true);
  });
});

suite('MemberService', () => {
  const db = new PrismaClient();
  const mailer = new CapturingMailer();
  const auth = { publicOrigin: () => 'https://app.test' } as unknown as AuthService;
  const service = new MemberService(db, mailer, auth);
  const req = { ip: '127.0.0.1', requestId: 'req_test', get: () => 'test' } as unknown as Request;

  let ownerId: string; let workspaceId: string;
  const actor = (userId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER'): SessionActor =>
    ({ userId, sessionId: 's', surface: 'APP', staffRole: null, workspaceRoles: new Map([[workspaceId, role]]), mfaLevel: 0, lastStepUpAt: null, impersonating: false });

  beforeAll(async () => { await db.$connect(); });
  afterAll(async () => { await db.$disconnect(); });
  beforeEach(async () => {
    mailer.sent = [];
    const owner = await db.user.create({ data: { email: `own-${crypto.randomUUID()}@test.local`, name: 'Owner' } });
    ownerId = owner.id;
    const ws = await db.workspace.create({ data: { type: 'BUSINESS', name: 'Shop', members: { create: { userId: ownerId, role: 'OWNER' } } } });
    workspaceId = ws.id;
  });

  it('invite → accept as the invited email → role change → transfer → old owner cannot be removed until then', async () => {
    const invitee = `kemi-${crypto.randomUUID()}@test.local`;
    const inv = await service.invite(actor(ownerId, 'OWNER'), workspaceId, { email: invitee, role: 'MEMBER' }, req);
    expect(inv.email).toBe(invitee);
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent[0]!.text)![1]!;

    // Someone else with the link gets nothing.
    const stranger = await db.user.create({ data: { email: `x-${crypto.randomUUID()}@test.local` } });
    expect((await service.accept(actor(stranger.id, 'MEMBER'), token, req)).status).toBe('wrong_account');

    const kemi = await db.user.create({ data: { email: invitee } });
    const joined = await service.accept(actor(kemi.id, 'MEMBER'), token, req);
    expect(joined.status).toBe('joined');
    expect((await service.list(workspaceId)).members).toHaveLength(2);
    expect((await service.accept(actor(kemi.id, 'MEMBER'), token, req)).status).toBe('invalid_token');

    // An admin cannot mint admins; the owner can.
    await service.setRole(actor(ownerId, 'OWNER'), workspaceId, kemi.id, 'ADMIN', req);
    const third = await db.user.create({ data: { email: `t-${crypto.randomUUID()}@test.local` } });
    await db.workspaceMember.create({ data: { workspaceId, userId: third.id, role: 'MEMBER' } });
    await expect(service.setRole(actor(kemi.id, 'ADMIN'), workspaceId, third.id, 'ADMIN', req)).rejects.toMatchObject({ status: 403 });

    await expect(service.remove(actor(kemi.id, 'ADMIN'), workspaceId, ownerId, req)).rejects.toMatchObject({ status: 409 });
    await service.transfer(actor(ownerId, 'OWNER'), workspaceId, kemi.id, req);
    const roles = Object.fromEntries((await service.list(workspaceId)).members.map((m) => [m.userId, m.role]));
    expect(roles[kemi.id]).toBe('OWNER');
    expect(roles[ownerId]).toBe('ADMIN');
    // The former owner can now leave.
    await service.remove(actor(ownerId, 'ADMIN'), workspaceId, ownerId, req);
    expect((await service.list(workspaceId)).members.map((m) => m.userId)).not.toContain(ownerId);
  });

  it('cancelling an invitation kills the link', async () => {
    const invitee = `c-${crypto.randomUUID()}@test.local`;
    const inv = await service.invite(actor(ownerId, 'OWNER'), workspaceId, { email: invitee, role: 'AUDITOR' }, req);
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent[0]!.text)![1]!;
    await service.cancelInvite(actor(ownerId, 'OWNER'), workspaceId, inv.id, req);
    const u = await db.user.create({ data: { email: invitee } });
    expect((await service.accept(actor(u.id, 'MEMBER'), token, req)).status).toBe('invalid_token');
    expect((await service.list(workspaceId)).invites).toHaveLength(0);
  });
});
