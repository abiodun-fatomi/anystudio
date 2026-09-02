/**
 * A workspace as its members see it.
 *
 * Small for now: the profile the welcome screen collects. Members, brand kit
 * and settings land here as they are built, each behind the role that owns
 * them — policy lives in the decorators, not in the handler bodies.
 */

import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { RequireWorkspaceRole } from '../../common/guards';
import { NotFoundError } from '../../common/errors/app-error';

/**
 * The welcome-screen answers. Every field optional: the whole point of the
 * screen is that it can be skipped, and a partial answer is still useful.
 */
const ProfileSchema = z.object({
  /** What they sell — "Ankara fabrics", "skincare", "phone accessories". */
  sells: z.string().trim().max(120).optional(),
  /** Where they sell today. Drives which publishing connectors we suggest first. */
  channels: z.array(z.enum(['whatsapp', 'instagram', 'tiktok', 'facebook', 'jiji', 'shop', 'market'])).max(7).optional(),
  /** How they want to sound. Feeds the copywriting prompt directly. */
  tone: z.enum(['warm', 'direct', 'playful', 'premium']).optional(),
}).strict();

export type WorkspaceProfile = z.infer<typeof ProfileSchema>;

@Controller('workspaces/:workspaceId')
export class WorkspacesController {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Read the workspace, including its profile.
   *
   * WHAT     Name, type, currency, region, and the welcome answers.
   * WHO      Any member.
   * COSTS    Nothing.
   * WRITES   Nothing.
   */
  @Get()
  @RequireWorkspaceRole('AUDITOR')
  async get(@Param('workspaceId') workspaceId: string) {
    const ws = await this.db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, type: true, name: true, currency: true, region: true, profile: true, createdAt: true },
    });
    if (!ws) throw new NotFoundError('workspace');
    return ws;
  }

  /**
   * Save the welcome answers, or update them later from settings.
   *
   * WHAT     Merges the supplied fields into the profile. Omitted fields are
   *          left alone; a field sent as null is cleared.
   * WHO      OWNER or ADMIN of the workspace.
   * COSTS    Nothing.
   * WRITES   Workspace.profile.
   */
  @Patch('profile')
  @RequireWorkspaceRole('ADMIN')
  async patchProfile(@Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    const patch = ProfileSchema.parse(body ?? {});
    const current = await this.db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { profile: true },
    });
    if (!current) throw new NotFoundError('workspace');
    const merged = { ...((current.profile as WorkspaceProfile | null) ?? {}), ...patch };
    const ws = await this.db.workspace.update({
      where: { id: workspaceId },
      data: { profile: merged },
      select: { id: true, profile: true },
    });
    return ws;
  }
}
