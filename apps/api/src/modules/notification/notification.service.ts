/**
 * The bell. Personal notifications are written by the things that happen
 * to a person — a generation finishing, credits landing, someone joining —
 * and platform messages are written once by staff for an audience. Reading
 * merges the two, newest first, and the unread count is what the bell
 * shows.
 *
 * Writers never throw into the caller: a notification that fails to write
 * is logged, and the generation or payment it was about is unaffected.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient, type Generation, type NotificationKind, type WorkspaceType } from '@prisma/client';
import { logger } from '../../../config/logger';
import { GenerationHooks } from '../generation/generation.hooks';
import { customerMessage } from '../generation/generation.service';

export interface NotificationItem {
  id: string;
  kind: NotificationKind | 'PLATFORM';
  title: string;
  body: string | null;
  href: string | null;
  refId: string | null;
  read: boolean;
  createdAt: Date;
}

const CAPABILITY_WORD: Record<string, string> = {
  IMAGE_EDIT: 'product photo',
  IMAGE_GENERATE: 'flyer',
  BACKGROUND_REMOVE: 'cut-out',
  BACKGROUND_REPLACE: 'new background',
  RELIGHT: 'relit photo',
  UPSCALE: 'enhanced photo',
  IMAGE_TO_VIDEO: 'video',
  VIDEO_STITCH: 'ad',
  TEXT_GENERATE: 'listing copy',
  VOICEOVER: 'voiceover',
  MUSIC: 'song',
  DUB: 'translated video',
  LIPSYNC: 'lip-synced video',
};

@Injectable()
export class NotificationService implements OnModuleInit {
  constructor(
    private readonly db: PrismaClient,
    private readonly hooks: GenerationHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.onFinished((row) => this.onGenerationFinished(row));
  }

  /** The web studio's own results: a line in the bell as well as the card, for the person who asked. */
  async onGenerationFinished(row: Generation): Promise<void> {
    if (row.channel !== 'WEB' || row.kind === 'CHILD') return;
    if ((row.input as { task?: string } | null)?.task === 'field') return; // a caption rewrite is not news
    const word = CAPABILITY_WORD[row.capability] ?? 'generation';
    const title = row.title ? `${row.title}` : `Your ${word}`;
    if (row.status === 'SUCCEEDED') {
      await this.notify(row.requestedById, {
        workspaceId: row.workspaceId,
        kind: 'GENERATION_DONE',
        title: `${title} is ready`,
        body: `Your ${word} finished. Open it in the studio or find it in the library.`,
        href: `/library?open=${row.id}`,
        refId: row.id,
      });
    } else if (row.status === 'FAILED') {
      await this.notify(row.requestedById, {
        workspaceId: row.workspaceId,
        kind: 'GENERATION_FAILED',
        title: `${title} did not work`,
        body: `${customerMessage(row) ?? 'Something went wrong.'} ${row.credits ? `${row.credits} credits are back.` : ''}`.trim(),
        href: '/studio',
        refId: row.id,
      });
    }
  }

  /** Write one. Never throws into the caller. */
  async notify(
    userId: string,
    n: { workspaceId?: string | null; kind: NotificationKind; title: string; body?: string | null; href?: string | null; refId?: string | null },
  ): Promise<void> {
    try {
      // The same thing announced twice (a webhook and a return-URL settle) is one line, not two.
      if (n.refId) {
        const dup = await this.db.notification.findFirst({ where: { userId, kind: n.kind, refId: n.refId }, select: { id: true } });
        if (dup) return;
      }
      await this.db.notification.create({
        data: {
          userId,
          workspaceId: n.workspaceId ?? null,
          kind: n.kind,
          title: n.title.slice(0, 160),
          body: n.body?.slice(0, 600) ?? null,
          href: n.href ?? null,
          refId: n.refId ?? null,
        },
      });
    } catch (err) {
      logger.warn({ err, userId, kind: n.kind }, 'could not write a notification');
    }
  }

  /** Everyone in a workspace, minus the person who did the thing. */
  async notifyWorkspace(
    workspaceId: string,
    exceptUserId: string | null,
    n: { kind: NotificationKind; title: string; body?: string | null; href?: string | null; refId?: string | null },
  ): Promise<void> {
    const members = await this.db.workspaceMember.findMany({
      where: { workspaceId, ...(exceptUserId ? { userId: { not: exceptUserId } } : {}) },
      select: { userId: true },
    });
    for (const m of members) await this.notify(m.userId, { ...n, workspaceId, refId: n.refId ? `${n.refId}:${m.userId}` : null });
  }

  /** Personal rows and live platform messages for this person, merged, newest first. */
  async list(
    userId: string,
    opts: { take?: number; cursor?: string; unreadOnly?: boolean } = {},
  ): Promise<{ items: NotificationItem[]; nextCursor: string | null; unread: number }> {
    const take = Math.min(100, Math.max(1, opts.take ?? 30));
    const [personal, platform, unread] = await Promise.all([
      this.db.notification.findMany({
        where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}), ...(opts.cursor ? { createdAt: { lt: new Date(opts.cursor) } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: take + 1,
      }),
      this.platformFor(userId, opts.cursor ? new Date(opts.cursor) : null),
      this.unreadCount(userId),
    ]);
    const items: NotificationItem[] = [
      ...personal.map((n) => ({
        id: n.id,
        kind: n.kind as NotificationItem['kind'],
        title: n.title,
        body: n.body,
        href: n.href,
        refId: n.refId,
        read: Boolean(n.readAt),
        createdAt: n.createdAt,
      })),
      ...platform.filter((p) => !opts.unreadOnly || !p.read),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const page = items.slice(0, take);
    return { items: page, nextCursor: items.length > take ? page[page.length - 1]!.createdAt.toISOString() : null, unread };
  }

  async unreadCount(userId: string): Promise<number> {
    const [personal, platform] = await Promise.all([
      this.db.notification.count({ where: { userId, readAt: null } }),
      this.platformFor(userId, null).then((p) => p.filter((x) => !x.read).length),
    ]);
    return personal + platform;
  }

  /** Mark some, or everything, read. Platform message ids are prefixed `pm:`. */
  async markRead(userId: string, ids: string[] | 'all'): Promise<{ unread: number }> {
    if (ids === 'all') {
      await this.db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
      const live = await this.platformFor(userId, null);
      for (const p of live.filter((x) => !x.read))
        await this.db.platformMessageRead.upsert({
          where: { messageId_userId: { messageId: p.id.slice(3), userId } },
          create: { messageId: p.id.slice(3), userId },
          update: {},
        });
    } else {
      const personal = ids.filter((i) => !i.startsWith('pm:'));
      const platform = ids.filter((i) => i.startsWith('pm:')).map((i) => i.slice(3));
      if (personal.length) await this.db.notification.updateMany({ where: { userId, id: { in: personal }, readAt: null }, data: { readAt: new Date() } });
      for (const messageId of platform)
        await this.db.platformMessageRead
          .upsert({ where: { messageId_userId: { messageId, userId } }, create: { messageId, userId }, update: {} })
          .catch(() => undefined);
    }
    return { unread: await this.unreadCount(userId) };
  }

  /** Live platform messages this person is in the audience for, with whether they have read each. */
  private async platformFor(userId: string, before: Date | null): Promise<NotificationItem[]> {
    const now = new Date();
    const types = await this.db.workspaceMember.findMany({ where: { userId }, select: { workspace: { select: { type: true } } } });
    const mine = new Set<WorkspaceType>(types.map((t) => t.workspace.type));
    const rows = await this.db.platformMessage.findMany({
      where: { publishedAt: { not: null, lte: now, ...(before ? { lt: before } : {}) }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      include: { reads: { where: { userId }, select: { readAt: true } } },
    });
    return rows
      .filter((m) => m.audience === 'ALL' || mine.has(m.audience as WorkspaceType))
      .map((m) => ({
        id: `pm:${m.id}`,
        kind: 'PLATFORM' as const,
        title: m.title,
        body: m.body,
        href: m.href,
        refId: null,
        read: m.reads.length > 0,
        createdAt: m.publishedAt ?? m.createdAt,
      }));
  }

  // ---- staff: platform messages -------------------------------------------

  async platformMessages() {
    return this.db.platformMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { reads: true } } } });
  }

  async createPlatformMessage(
    createdById: string,
    dto: { title: string; body: string; href?: string; audience?: 'ALL' | 'PERSONAL' | 'BUSINESS' | 'ORGANIZATION'; publish?: boolean; expiresAt?: string },
  ) {
    return this.db.platformMessage.create({
      data: {
        title: dto.title.trim(),
        body: dto.body.trim(),
        href: dto.href?.trim() || null,
        audience: dto.audience ?? 'ALL',
        publishedAt: dto.publish ? new Date() : null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdById,
      },
    });
  }

  async updatePlatformMessage(
    id: string,
    dto: {
      title?: string;
      body?: string;
      href?: string | null;
      audience?: 'ALL' | 'PERSONAL' | 'BUSINESS' | 'ORGANIZATION';
      published?: boolean;
      expiresAt?: string | null;
    },
  ) {
    const data: Prisma.PlatformMessageUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.body !== undefined) data.body = dto.body.trim();
    if (dto.href !== undefined) data.href = dto.href?.trim() || null;
    if (dto.audience !== undefined) data.audience = dto.audience;
    if (dto.published !== undefined) data.publishedAt = dto.published ? new Date() : null;
    if (dto.expiresAt !== undefined) data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    return this.db.platformMessage.update({ where: { id }, data });
  }

  async deletePlatformMessage(id: string) {
    await this.db.platformMessage.delete({ where: { id } });
    return { deleted: true };
  }
}
