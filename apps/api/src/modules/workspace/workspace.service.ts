/**
 * A workspace as its members see it. Small for now: identity and the profile
 * the welcome screen collects. Members, brand kit and settings land here as
 * they are built.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import type { Request } from 'express';
import { authLog } from '../auth/auth.log';
import { Helpers } from '../../utils/helpers';
import type { WorkspaceDeleteDto, WorkspaceProfileDto, WorkspaceUpdateDto } from './workspace.dto';

@Injectable()
export class WorkspaceService {
  constructor(private readonly db: PrismaClient) {}

  /** Name, type, currency, region, and the welcome answers. */
  async get(workspaceId: string) {
    const ws = await this.db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, type: true, name: true, currency: true, region: true, profile: true, createdAt: true },
    });
    if (!ws) throw new NotFoundError('workspace');
    return Helpers.successResponse(200, 'OK', ws);
  }

  /**
   * Merge the supplied fields into the profile. Omitted fields are left
   * alone, so the welcome screen and a later settings page can each send
   * only what they own.
   */
  async patchProfile(workspaceId: string, patch: WorkspaceProfileDto) {
    const current = await this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { profile: true } });
    if (!current) throw new NotFoundError('workspace');
    const merged = { ...((current.profile as WorkspaceProfileDto | null) ?? {}), ...patch };
    const ws = await this.db.workspace.update({ where: { id: workspaceId }, data: { profile: merged }, select: { id: true, profile: true } });
    return Helpers.successResponse(200, 'Profile saved', ws);
  }

  /** Rename. Small on purpose: region and currency are support actions. */
  async update(workspaceId: string, dto: WorkspaceUpdateDto, actorId: string, req: Request) {
    const current = await this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true } });
    if (!current) throw new NotFoundError('workspace');
    const ws = await this.db.workspace.update({ where: { id: workspaceId }, data: { name: dto.name?.trim() }, select: { id: true, name: true } });
    authLog('workspace.update', 'succeeded', { userId: actorId, workspaceId, fields: Object.keys(dto) }, req);
    return Helpers.successResponse(200, 'Saved', ws);
  }

  /**
   * Soft-delete. The rows stay (the ledger must balance and the audit trail
   * must read), but the workspace disappears from every member's list and
   * nothing in it can be spent or generated. Refused for a person's only
   * workspace — deleting the account is the honest version of that.
   */
  async remove(workspaceId: string, dto: WorkspaceDeleteDto, actorId: string, req: Request) {
    const ws = await this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, name: true } });
    if (!ws) throw new NotFoundError('workspace');
    if (dto.confirmName.trim() !== ws.name) throw new ValidationError({ confirmName: 'Type the workspace name exactly as it is shown.' });
    const others = await this.db.workspaceMember.count({ where: { userId: actorId, workspaceId: { not: workspaceId }, workspace: { deletedAt: null } } });
    if (others === 0) throw new ConflictError('This is your only workspace. To close everything, delete your account instead.');
    const live = await this.db.generation.count({ where: { workspaceId, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (live > 0) throw new ConflictError(`${live} generation${live === 1 ? ' is' : 's are'} still running. Wait for them, or cancel them, first.`);
    await this.db.workspace.update({ where: { id: workspaceId }, data: { deletedAt: new Date() } });
    authLog('workspace.delete', 'succeeded', { userId: actorId, workspaceId }, req);
    return Helpers.successResponse(200, 'Workspace deleted', { id: workspaceId, deleted: true });
  }
}
