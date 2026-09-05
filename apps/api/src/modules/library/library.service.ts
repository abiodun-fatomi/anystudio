/**
 * The library: everything a workspace has made, findable again.
 *
 * A library item IS a succeeded generation. There is no second table to
 * drift out of step: the title, product key and search text live on the
 * generation row (written at request time and again at completion), and
 * the library is a query over them. Search is Postgres full text with
 * prefix matching over a 'simple' dictionary, because product names here
 * are Yoruba, French and brand names as often as English.
 *
 * Deleting hides the row and its files from every list; the objects are
 * removed later by the lifecycle job, so a deletion in a bad hour is
 * reversible by support for a while.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type Generation, type ProviderCapability } from '@prisma/client';
import type { Response } from 'express';
import archiver from 'archiver';
import { logger } from '../../../config/logger';
import { NotFoundError } from '../../../config/globals/errors';
import { MediaService } from '../media/media.service';
import type { LibraryItemPatchDto, LibraryQueryDto, LibraryType } from './library.dto';

interface OutputRow { key: string; role: string; mime: string; bytes?: number; width?: number; height?: number; durationMs?: number; size?: string; text?: unknown }

/** Which capabilities count as which kind of thing, for the type filter and the insights breakdown. */
export const TYPE_OF: Record<ProviderCapability, Exclude<LibraryType, 'all'>> = {
  IMAGE_GENERATE: 'image', IMAGE_EDIT: 'image', BACKGROUND_REMOVE: 'image', BACKGROUND_REPLACE: 'image', RELIGHT: 'image', UPSCALE: 'image',
  IMAGE_TO_VIDEO: 'video', VIDEO_STITCH: 'video', DUB: 'video', LIPSYNC: 'video',
  TEXT_GENERATE: 'copy',
  VOICEOVER: 'audio', MUSIC: 'audio',
};
const CAPS_BY_TYPE = (t: Exclude<LibraryType, 'all'>): ProviderCapability[] => (Object.keys(TYPE_OF) as ProviderCapability[]).filter((c) => TYPE_OF[c] === t);

@Injectable()
export class LibraryService {
  constructor(private readonly db: PrismaClient, private readonly media: MediaService) {}

  /** One page, newest first. Filters and search are applied in SQL; the rows come back through Prisma. */
  async list(workspaceId: string, q: LibraryQueryDto) {
    const take = q.take ?? 24;
    const ids = await this.searchIds(workspaceId, q, take + 1);
    const more = ids.length > take;
    const page = ids.slice(0, take);
    const rows = page.length ? await this.db.generation.findMany({ where: { id: { in: page } } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = page.map((id) => byId.get(id)).filter((r): r is Generation => Boolean(r));
    const items = await this.hydrate(workspaceId, ordered);
    return { items, nextCursor: more ? (page[page.length - 1] ?? null) : null };
  }

  /** The catalogue view: one row per product, with how many things exist for it and the newest picture. */
  async products(workspaceId: string) {
    const rows = await this.db.$queryRaw<Array<{ productKey: string; title: string | null; count: number; lastAt: Date; lastId: string }>>`
      SELECT g."productKey", max(g."title") AS "title", count(*)::int AS "count", max(g."createdAt") AS "lastAt",
             (array_agg(g.id ORDER BY g."createdAt" DESC))[1] AS "lastId"
      FROM generations g
      WHERE g."workspaceId" = ${workspaceId}::uuid AND g."deletedAt" IS NULL AND g.status = 'SUCCEEDED' AND g.kind <> 'CHILD' AND g."productKey" IS NOT NULL
      GROUP BY g."productKey" ORDER BY max(g."createdAt") DESC LIMIT 200`;
    const lastIds = rows.map((r) => r.lastId);
    const last = lastIds.length ? await this.db.generation.findMany({ where: { id: { in: lastIds } }, select: { id: true, outputs: true, input: true } }) : [];
    const thumbKeys = new Map(last.map((g) => [g.id, thumbKeyOf(g.outputs as OutputRow[] | null, g.input as Record<string, unknown>)]));
    const urls = await this.media.readUrls(workspaceId, [...new Set([...thumbKeys.values()].filter((k): k is string => Boolean(k)))]).catch(() => ({}) as Record<string, string>);
    return rows.map((r) => ({ productKey: r.productKey, title: r.title, count: r.count, lastAt: r.lastAt, thumbUrl: (thumbKeys.get(r.lastId) && urls[thumbKeys.get(r.lastId)!]) ?? null }));
  }

  async get(workspaceId: string, id: string) {
    const row = await this.db.generation.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!row) throw new NotFoundError('library item');
    const [item] = await this.hydrate(workspaceId, [row], true);
    return item!;
  }

  async patch(workspaceId: string, id: string, dto: LibraryItemPatchDto) {
    const row = await this.db.generation.findFirst({ where: { id, workspaceId, deletedAt: null }, select: { id: true } });
    if (!row) throw new NotFoundError('library item');
    const data: Prisma.GenerationUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title?.trim() || null;
    if (dto.favourite !== undefined) data.favourite = dto.favourite;
    if (dto.productKey !== undefined) data.productKey = dto.productKey?.trim() || null;
    const updated = await this.db.generation.update({ where: { id }, data });
    const [item] = await this.hydrate(workspaceId, [updated]);
    return item!;
  }

  /** Hide it and its files. The objects go later; the row stays for the ledger. */
  async remove(workspaceId: string, id: string): Promise<{ deleted: true }> {
    const row = await this.db.generation.findFirst({ where: { id, workspaceId, deletedAt: null }, select: { id: true } });
    if (!row) throw new NotFoundError('library item');
    await this.db.$transaction([
      this.db.generation.update({ where: { id }, data: { deletedAt: new Date() } }),
      this.db.mediaAsset.updateMany({ where: { generationId: id, deletedAt: null }, data: { deletedAt: new Date() } }),
    ]);
    logger.info({ workspaceId, generationId: id }, 'library item deleted');
    return { deleted: true };
  }

  /**
   * Every output as one zip, streamed — never buffered, because a 30-second
   * ad is tens of megabytes and the API has a memory ceiling. Text outputs
   * become a .txt / .json in the same archive.
   */
  async download(workspaceId: string, id: string, res: Response): Promise<void> {
    const row = await this.db.generation.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!row) throw new NotFoundError('library item');
    const outputs = ((row.outputs as OutputRow[] | null) ?? []).filter((o) => o.role !== 'thumb' && o.role !== 'mask');
    const base = filenameBase(row);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${base}.zip"`);
    const zip = archiver('zip', { zlib: { level: 1 } });
    zip.on('warning', (err) => logger.warn({ err, generationId: id }, 'zip warning'));
    zip.on('error', (err) => { logger.error({ err, generationId: id }, 'zip failed'); res.destroy(err); });
    zip.pipe(res);
    let n = 0;
    for (const o of outputs) {
      if (o.role === 'text') {
        const text = typeof o.text === 'string' ? o.text : JSON.stringify(o.text, null, 2);
        zip.append(text, { name: `${base}-${typeof o.text === 'string' ? 'copy.txt' : 'copy.json'}` });
        continue;
      }
      if (!o.key) continue;
      const ext = o.key.split('.').pop() ?? 'bin';
      const name = `${base}-${o.size ?? o.role}${outputs.filter((x) => x.role === o.role && x.size === o.size).length > 1 ? `-${++n}` : ''}.${ext}`;
      try {
        zip.append(await this.media.getBytes(o.key), { name });
      } catch (err) {
        logger.warn({ err, key: o.key, generationId: id }, 'output missing from storage; skipped in zip');
      }
    }
    await zip.finalize();
  }

  // ----------------------------------------------------------------- private

  /**
   * The id page, in SQL, so search and filters use the indexes. Cursor is the
   * last id of the previous page; ordering is (createdAt DESC, id DESC).
   */
  private async searchIds(workspaceId: string, q: LibraryQueryDto, limit: number): Promise<string[]> {
    const where: Prisma.Sql[] = [
      Prisma.sql`g."workspaceId" = ${workspaceId}::uuid`,
      Prisma.sql`g."deletedAt" IS NULL`,
      Prisma.sql`g.status = 'SUCCEEDED'`,
      Prisma.sql`g.kind <> 'CHILD'`,
      // A shot plan is scaffolding for an ad, not a thing the seller made.
      Prisma.sql`coalesce(g.input->>'task', '') <> 'shot_plan'`,
    ];
    const type = q.type ?? 'all';
    if (type !== 'all') {
      const caps = CAPS_BY_TYPE(type);
      where.push(Prisma.sql`g.capability::text IN (${Prisma.join(caps)})`);
    }
    if (q.product) where.push(Prisma.sql`g."productKey" = ${q.product}`);
    if (q.favourite) where.push(Prisma.sql`g.favourite = true`);
    if (q.from) where.push(Prisma.sql`g."createdAt" >= ${new Date(q.from)}`);
    if (q.to) where.push(Prisma.sql`g."createdAt" < ${new Date(q.to)}`);
    const tsquery = toTsQuery(q.q);
    if (tsquery) where.push(Prisma.sql`to_tsvector('simple', coalesce(g."searchText", '') || ' ' || coalesce(g.title, '')) @@ to_tsquery('simple', ${tsquery})`);
    if (q.cursor) {
      where.push(Prisma.sql`(g."createdAt", g.id) < (SELECT c."createdAt", c.id FROM generations c WHERE c.id = ${q.cursor}::uuid)`);
    }
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT g.id FROM generations g WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY g."createdAt" DESC, g.id DESC LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /** Rows → items with signed URLs for the thumbnail and the preview. */
  private async hydrate(workspaceId: string, rows: Generation[], full = false) {
    const wanted = new Set<string>();
    const per = rows.map((g) => {
      const outputs = ((g.outputs as OutputRow[] | null) ?? []);
      const input = g.input as Record<string, unknown>;
      const thumb = thumbKeyOf(outputs, input);
      const preview = outputs.find((o) => o.role === 'image' || o.role === 'video')?.key ?? null;
      if (thumb) wanted.add(thumb);
      if (preview) wanted.add(preview);
      if (full) for (const o of outputs) if (o.key) wanted.add(o.key);
      if (full && typeof input.sourceKey === 'string') wanted.add(input.sourceKey);
      return { g, outputs, input, thumb, preview };
    });
    const urls = wanted.size ? await this.media.readUrls(workspaceId, [...wanted]).catch(() => ({}) as Record<string, string>) : {};
    return per.map(({ g, outputs, input, thumb, preview }) => ({
      id: g.id,
      type: TYPE_OF[g.capability],
      capability: g.capability,
      kind: g.kind,
      title: g.title ?? (typeof input.productName === 'string' ? input.productName : null),
      productKey: g.productKey,
      favourite: g.favourite,
      credits: g.credits,
      createdAt: g.createdAt,
      finishedAt: g.finishedAt,
      thumbUrl: thumb ? (urls[thumb] ?? null) : null,
      previewUrl: preview ? (urls[preview] ?? null) : null,
      previewMime: outputs.find((o) => o.key === preview)?.mime ?? null,
      sourceKey: typeof input.sourceKey === 'string' ? input.sourceKey : null,
      sourceUrl: full && typeof input.sourceKey === 'string' ? (urls[input.sourceKey] ?? null) : null,
      text: outputs.find((o) => o.role === 'text')?.text ?? null,
      outputs: outputs.filter((o) => o.role !== 'thumb' && o.role !== 'mask').map((o) => ({ key: o.key, role: o.role, mime: o.mime, size: o.size, width: o.width, height: o.height, durationMs: o.durationMs, bytes: o.bytes, url: full ? (urls[o.key] ?? null) : null })),
      params: full ? input : undefined,
    }));
  }
}

function thumbKeyOf(outputs: OutputRow[] | null, input: Record<string, unknown>): string | null {
  const o = outputs ?? [];
  return o.find((x) => x.role === 'thumb')?.key ?? o.find((x) => x.role === 'image')?.key ?? (typeof input.sourceKey === 'string' ? input.sourceKey : null);
}

/** "ankara wrap" → 'ankara:* & wrap:*'. Prefix matching, every word required; punctuation dropped. */
export function toTsQuery(q: string | undefined): string | null {
  if (!q) return null;
  const words = q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 2).slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

function filenameBase(g: Generation): string {
  const t = (g.title ?? TYPE_OF[g.capability]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'anystudio';
  return `${t}-${g.id.slice(0, 8)}`;
}
