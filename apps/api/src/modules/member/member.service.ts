/**
 * Who is in a workspace, and as what.
 *
 * ONE OWNER, ALWAYS
 * -----------------
 * Every workspace has exactly one OWNER. Ownership moves by transfer, never
 * by grant, and the owner cannot leave, be removed or be demoted: the
 * workspace would be left with credits nobody can spend and a bill nobody
 * answers for. Deleting the account is refused for the same reason while
 * others remain (see AccountService.requestDeletion).
 *
 * INVITES ARE TOKENS
 * ------------------
 * An invitation is an AuthToken (WORKSPACE_INVITE) keyed to the email it
 * went to. Accepting it requires being signed in as that email: an invite
 * forwarded to someone else is a link that does nothing for them.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient, type WorkspaceRole } from '@prisma/client';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { Mailer } from '../../utils/mail-service';
import { workspaceInvite } from '../../assets/email-templates';
import { authLog } from '../auth/auth.log';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/policy';
import { GRANTABLE_ROLES, type GrantableRole, type InviteDto } from './member.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_MEMBERS: Record<string, number> = { PERSONAL: 5, BUSINESS: 25, ORGANIZATION: 500 };
const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

@Injectable()
export class MemberService {
  constructor(private readonly db: PrismaClient, private readonly mailer: Mailer, private readonly auth: AuthService) {}

  /** Members and open invitations, in one read. */
  async list(workspaceId: string) {
    const [members, invites] = await Promise.all([
      this.db.workspaceMember.findMany({
        where: { workspaceId }, orderBy: { createdAt: 'asc' },
        select: { userId: true, role: true, createdAt: true, user: { select: { name: true, email: true, avatarKey: true, lastLoginAt: true } } },
      }),
      this.db.authToken.findMany({
        where: { purpose: 'WORKSPACE_INVITE', consumedAt: null, expiresAt: { gt: new Date() }, payload: { path: ['workspaceId'], equals: workspaceId } },
        orderBy: { createdAt: 'desc' }, select: { id: true, email: true, payload: true, expiresAt: true, createdAt: true },
      }),
    ]);
    return {
      members: members.map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.createdAt, name: m.user.name, email: m.user.email, lastLoginAt: m.user.lastLoginAt })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, role: (i.payload as { role?: string } | null)?.role ?? 'MEMBER', expiresAt: i.expiresAt, createdAt: i.createdAt })),
    };
  }

  /**
   * Invite by email. Re-inviting the same address retires the earlier link.
   * Someone who already has an account is added the same way — through the
   * link — so a typo'd address never silently grants access to a stranger.
   */
  async invite(actor: Actor, workspaceId: string, dto: InviteDto, req: Request) {
    const email = dto.email.trim().toLowerCase();
    const ws = await this.workspace(workspaceId);
    this.assertCanGrant(actor, workspaceId, dto.role);
    const existing = await this.db.workspaceMember.findFirst({ where: { workspaceId, user: { email } } });
    if (existing) throw new ConflictError('That person is already in this workspace.');
    const count = await this.db.workspaceMember.count({ where: { workspaceId } });
    const open = await this.db.authToken.count({ where: { purpose: 'WORKSPACE_INVITE', consumedAt: null, expiresAt: { gt: new Date() }, payload: { path: ['workspaceId'], equals: workspaceId } } });
    const cap = MAX_MEMBERS[ws.type] ?? 5;
    if (count + open >= cap) throw new ConflictError(`This workspace can have ${cap} people. Remove someone or cancel an invitation first.`);

    await this.db.authToken.updateMany({ where: { purpose: 'WORKSPACE_INVITE', email, consumedAt: null, payload: { path: ['workspaceId'], equals: workspaceId } }, data: { consumedAt: new Date() } });
    const token = randomBytes(32).toString('base64url');
    const row = await this.db.authToken.create({
      data: { purpose: 'WORKSPACE_INVITE', email, tokenHash: sha256(token), payload: { workspaceId, role: dto.role, invitedById: actor.userId }, expiresAt: new Date(Date.now() + INVITE_TTL_MS), createdIp: req.ip },
    });
    const inviter = await this.db.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const link = `${this.auth.publicOrigin(req)}/invite?token=${token}`;
    await this.mailer.send(workspaceInvite(email, inviter?.name ?? null, ws.name, dto.role, link))
      .catch((err: unknown) => logger.error({ err, workspaceId }, 'invite mail failed'));
    authLog('member.invite', 'succeeded', { userId: actor.userId, workspaceId, role: dto.role }, req);
    return { id: row.id, email, role: dto.role, expiresAt: row.expiresAt };
  }

  async cancelInvite(actor: Actor, workspaceId: string, inviteId: string, req: Request): Promise<{ status: 'cancelled' }> {
    const { count } = await this.db.authToken.updateMany({ where: { id: inviteId, purpose: 'WORKSPACE_INVITE', consumedAt: null, payload: { path: ['workspaceId'], equals: workspaceId } }, data: { consumedAt: new Date() } });
    if (!count) throw new NotFoundError('invitation');
    authLog('member.invite', 'succeeded', { userId: actor.userId, workspaceId, cancelled: inviteId }, req);
    return { status: 'cancelled' };
  }

  /** Someone signed in with the invited email opened the link. */
  async accept(actor: Actor, token: string, req: Request) {
    const row = await this.db.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.purpose !== 'WORKSPACE_INVITE' || row.consumedAt || row.expiresAt < new Date()) {
      authLog('member.accept', 'refused', { userId: actor.userId, reason: 'invalid_token' }, req);
      return { status: 'invalid_token' as const };
    }
    const user = await this.db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true } });
    if (!user.email || user.email.toLowerCase() !== (row.email ?? '').toLowerCase()) {
      authLog('member.accept', 'refused', { userId: actor.userId, reason: 'wrong_account' }, req);
      return { status: 'wrong_account' as const, invitedEmail: row.email };
    }
    const { workspaceId, role } = (row.payload as { workspaceId?: string; role?: GrantableRole } | null) ?? {};
    if (!workspaceId || !role || !GRANTABLE_ROLES.includes(role)) return { status: 'invalid_token' as const };
    const ws = await this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, name: true, type: true } });
    if (!ws) return { status: 'invalid_token' as const };
    await this.db.$transaction([
      this.db.authToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
      this.db.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
        create: { workspaceId, userId: actor.userId, role, invitedById: (row.payload as { invitedById?: string }).invitedById },
        update: {},
      }),
    ]);
    authLog('member.accept', 'succeeded', { userId: actor.userId, workspaceId, role }, req);
    return { status: 'joined' as const, workspace: ws, role };
  }

  /** Change a member's role. Owners are transferred, not edited. */
  async setRole(actor: Actor, workspaceId: string, userId: string, role: GrantableRole, req: Request) {
    const m = await this.member(workspaceId, userId);
    if (m.role === 'OWNER') throw new ConflictError('The owner\'s role changes by transferring ownership.');
    if (userId === actor.userId) throw new ConflictError('Ask another admin to change your own role.');
    this.assertCanGrant(actor, workspaceId, role);
    const row = await this.db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role }, select: { userId: true, role: true } });
    authLog('member.role', 'succeeded', { userId: actor.userId, workspaceId, target: userId, role }, req);
    return row;
  }

  /** Remove someone, or leave (userId === actor). The owner can do neither. */
  async remove(actor: Actor, workspaceId: string, userId: string, req: Request): Promise<{ status: 'removed' }> {
    const m = await this.member(workspaceId, userId);
    if (m.role === 'OWNER') throw new ConflictError('The owner cannot be removed. Transfer ownership first.');
    const self = userId === actor.userId;
    if (!self) {
      const mine = actor.workspaceRoles.get(workspaceId);
      if (mine !== 'OWNER' && mine !== 'ADMIN') throw new ForbiddenError('Only an admin can remove people.');
      if (m.role === 'ADMIN' && mine !== 'OWNER') throw new ForbiddenError('Only the owner can remove an admin.');
    }
    await this.db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
    authLog('member.remove', 'succeeded', { userId: actor.userId, workspaceId, target: userId, left: self }, req);
    return { status: 'removed' };
  }

  /** Hand the workspace to another member. The old owner becomes an admin — they do not vanish. */
  async transfer(actor: Actor, workspaceId: string, toUserId: string, req: Request) {
    if (actor.workspaceRoles.get(workspaceId) !== 'OWNER') throw new ForbiddenError('Only the owner can transfer ownership.');
    if (toUserId === actor.userId) throw new ConflictError('You already own this workspace.');
    await this.member(workspaceId, toUserId);
    await this.db.$transaction([
      this.db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: actor.userId } }, data: { role: 'ADMIN' } }),
      this.db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: toUserId } }, data: { role: 'OWNER' } }),
    ]);
    authLog('member.transfer', 'succeeded', { userId: actor.userId, workspaceId, to: toUserId }, req);
    return { status: 'transferred' as const, ownerId: toUserId };
  }

  // ----------------------------------------------------------------- private

  /** An ADMIN may hand out anything below ADMIN; only the OWNER makes admins. */
  private assertCanGrant(actor: Actor, workspaceId: string, role: WorkspaceRole): void {
    const mine = actor.workspaceRoles.get(workspaceId);
    if (mine !== 'OWNER' && mine !== 'ADMIN') throw new ForbiddenError('Only an admin can invite people.');
    if (role === 'ADMIN' && mine !== 'OWNER') throw new ForbiddenError('Only the owner can make someone an admin.');
  }

  private async workspace(id: string) {
    const ws = await this.db.workspace.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true, type: true } });
    if (!ws) throw new NotFoundError('workspace');
    return ws;
  }

  private async member(workspaceId: string, userId: string) {
    const m = await this.db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!m) throw new NotFoundError('member');
    return m;
  }
}
