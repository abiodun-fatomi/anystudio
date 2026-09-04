/**
 * The brand kit: one per workspace, applied to everything the workspace
 * makes. Read by the worker's pipelines; edited from the Brand screen.
 *
 * The logo is a storage key, and it has to be a READY object this
 * workspace uploaded — a key from somewhere else would let one workspace
 * put another's file on its images.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type BrandKit } from '@prisma/client';
import { MediaService } from '../media/media.service';
import { logger } from '../../../config/logger';
import type { BrandKitDto } from './brand.dto';

@Injectable()
export class BrandService {
  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
  ) {}

  /** The kit, or an empty one — a workspace that never saved one still has defaults. */
  async get(workspaceId: string): Promise<BrandKit | { workspaceId: string; empty: true }> {
    const kit = await this.db.brandKit.findUnique({ where: { workspaceId } });
    return kit ?? { workspaceId, empty: true };
  }

  /** Merge-patch. Nulls clear a field; omitted fields are untouched. */
  async patch(workspaceId: string, dto: BrandKitDto): Promise<BrandKit> {
    if (dto.logoKey) await this.media.requireReady(workspaceId, dto.logoKey);
    const data: Prisma.BrandKitUncheckedUpdateInput = {};
    if (dto.businessName !== undefined) data.businessName = dto.businessName;
    if (dto.logoKey !== undefined) data.logoKey = dto.logoKey;
    if (dto.palette !== undefined) data.palette = dto.palette;
    if (dto.fontDisplay !== undefined) data.fontDisplay = dto.fontDisplay;
    if (dto.fontBody !== undefined) data.fontBody = dto.fontBody;
    if (dto.tone !== undefined) data.tone = dto.tone;
    if (dto.watermark !== undefined) data.watermark = dto.watermark as Prisma.InputJsonObject;
    if (dto.showPrice !== undefined) data.showPrice = dto.showPrice;
    if (dto.defaultSizes !== undefined) data.defaultSizes = dto.defaultSizes;

    const kit = await this.db.brandKit.upsert({
      where: { workspaceId },
      create: { ...(data as Omit<Prisma.BrandKitUncheckedCreateInput, 'workspaceId'>), workspaceId },
      update: data,
    });
    logger.info({ workspaceId, fields: Object.keys(data) }, 'brand kit saved');
    return kit;
  }
}
