/**
 * A workspace as its members see it. Small for now: identity and the profile
 * the welcome screen collects. Members, brand kit and settings land here as
 * they are built.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../../config/globals/errors';
import { Helpers } from '../../utils/helpers';
import type { WorkspaceProfileDto } from './workspace.dto';

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
}
