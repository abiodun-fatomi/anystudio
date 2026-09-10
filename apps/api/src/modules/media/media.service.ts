/**
 * Media: what customers upload and what the pipeline produces, in R2.
 *
 * BYTES NEVER PASS THROUGH THE API
 * --------------------------------
 * The browser uploads straight to storage against a presigned URL and reads
 * straight from storage against another. The API only mints URLs and keeps
 * the rows. A 20 MB phone photo through a Render instance would be the
 * slowest and most expensive path available, and the least reliable on a
 * Nigerian mobile connection.
 *
 * A FILE NAME IS A CLAIM, NOT A FACT
 * ----------------------------------
 * `complete()` reads the object the customer actually uploaded: its type from
 * the first bytes, its size from storage, its dimensions from the pixels.
 * Anything that is not what it said it was is REJECTED and never reaches a
 * vendor. Images are then re-encoded through sharp, which applies the EXIF
 * rotation phones rely on and drops every other tag — including GPS, which
 * no seller intends to publish with a product photo.
 *
 * KEYS, NEVER URLS
 * ----------------
 * Everything downstream carries the object key. URLs are minted at the edge,
 * signed, and expire in minutes.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type MediaAsset, type MediaKind } from '@prisma/client';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UnsafeUrlError, safeFetch } from '../../utils/safe-fetch';
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { runFfprobe } from '../../../config/ffmpeg';
import { sniffMime } from './sniff';

/** Signed URLs live this long. Long enough to upload on 3G, short enough to be useless when leaked. */
const UPLOAD_TTL_SEC = 15 * 60;
const READ_TTL_SEC = 15 * 60;
const COPY_TIMEOUT_MS = 60_000;
const PROBE_READ_TTL_SEC = 2 * 60;
const MAX_DATABASE_INT = 2_147_483_647;
const MEDIA_STORAGE_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

export function missingMediaStorageEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return MEDIA_STORAGE_ENV.filter((key) => !env[key]?.trim());
}

const LIMITS = {
  image: { maxBytes: 25 * 1024 * 1024, mimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']) },
  video: { maxBytes: 250 * 1024 * 1024, mimes: new Set(['video/mp4', 'video/quicktime', 'video/webm']) },
  // audio/webm is what a browser's recorder produces; the sniffer files it as video/webm, which is the same container.
  audio: { maxBytes: 30 * 1024 * 1024, mimes: new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/x-m4a', 'audio/webm']) },
};

export interface PresignedUpload {
  assetId: string;
  key: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSec: number;
}

type ReadableAsset = Pick<MediaAsset, 'kind' | 'key'> & { generation?: { outputs: Prisma.JsonValue } | null };

/**
 * A produced object is customer-owned only once the generation itself points
 * at it as an unlocked output. This also closes historical crash leftovers
 * made by the old unlock order (copy + READY asset before generation update).
 */
export function customerReadable(asset: ReadableAsset): boolean {
  if (asset.kind === 'SOURCE') return true;
  const outputs = asset.generation?.outputs;
  if (!Array.isArray(outputs)) return false;
  return outputs.some(
    (output) => output !== null && typeof output === 'object' && !Array.isArray(output) && output.key === asset.key && output.locked !== true,
  );
}

@Injectable()
export class MediaService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly db: PrismaClient) {
    const missing = missingMediaStorageEnv();
    if (process.env.NODE_ENV === 'production' && missing.length) {
      // A worker without storage still writes a healthy heartbeat, then every
      // paid generation fails at its first read/write. R2_BUCKET is included
      // because its local default must never become a production destination.
      throw new Error(`Media storage is not configured: missing ${missing.join(', ')}`);
    }
    this.bucket = process.env.R2_BUCKET ?? 'anystudio-dev';
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
    });
    if (missing.length) {
      logger.warn({ missing }, 'R2 is not configured: uploads and outputs will fail until every media storage variable is set');
    }
  }

  /** {workspaceId}/{yyyy}/{mm}/{scope}/{name} — sortable, per-tenant, lifecycle-friendly. */
  static key(workspaceId: string, scope: string, name: string, at = new Date()): string {
    const yyyy = at.getUTCFullYear();
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    return `${workspaceId}/${yyyy}/${mm}/${scope}/${name}`;
  }

  /**
   * Pipeline scratch space for one generation. These keys are deliberately
   * separate from customer outputs: a parent may need them across worker
   * restarts, but they can be retired as soon as that parent is terminal.
   */
  static generationWorkPrefix(workspaceId: string, generationId: string, at: Date): string {
    return MediaService.key(workspaceId, `gen/${generationId}/work`, '', at);
  }

  // ---- uploads ---------------------------------------------------------------

  /** Announce an upload: a PENDING row and a URL the browser PUTs the file to. */
  async presignUpload(workspaceId: string, userId: string, file: { filename: string; mime: string; bytes: number }): Promise<PresignedUpload> {
    const mime = baseMime(file.mime);
    const family = familyOf(mime);
    if (!family) throw new ValidationError({ mime: `Unsupported file type ${file.mime}` });
    if (file.bytes > LIMITS[family].maxBytes)
      throw new ValidationError({ bytes: `Too large: the limit for ${family} is ${LIMITS[family].maxBytes / 1024 / 1024} MB` });

    // The announced type is kept on the row: the bytes decide the truth, but a
    // WebM with only an audio track looks exactly like a video one to a sniffer.
    const asset = await this.db.mediaAsset.create({
      data: { workspaceId, uploadedById: userId, kind: 'SOURCE', filename: file.filename.slice(0, 200), key: 'pending', mime },
    });
    const key = MediaService.key(workspaceId, 'uploads', `${asset.id}.${extFor(mime)}`);
    await this.db.mediaAsset.update({ where: { id: asset.id }, data: { key } });

    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: file.bytes }), {
      expiresIn: UPLOAD_TTL_SEC,
    });
    logger.info({ workspaceId, assetId: asset.id, key, mime, announced: file.mime, bytes: file.bytes }, 'upload presigned');
    // The header must match what the URL was signed for, so it is the bare type, not what the browser announced.
    return { assetId: asset.id, key, url, method: 'PUT', headers: { 'content-type': mime }, expiresInSec: UPLOAD_TTL_SEC };
  }

  /**
   * Bytes the server already holds — fetched from a URL an organization
   * gave us, or downloaded from WhatsApp — stored and verified exactly as a
   * browser upload would be. Same limits, same sniffing, same row.
   */
  async ingest(workspaceId: string, userId: string | null, bytes: Uint8Array, announcedMime: string, filename: string): Promise<MediaAsset> {
    const claimedMime = baseMime(announcedMime);
    const family = familyOf(claimedMime);
    if (!family) throw new ValidationError({ mime: `Unsupported file type ${announcedMime}` });
    if (bytes.byteLength > LIMITS[family].maxBytes)
      throw new ValidationError({ bytes: `Too large: the limit for ${family} is ${LIMITS[family].maxBytes / 1024 / 1024} MB` });
    const asset = await this.db.mediaAsset.create({
      data: { workspaceId, uploadedById: userId, kind: 'SOURCE', filename: filename.slice(0, 200), key: 'pending' },
    });
    const key = MediaService.key(workspaceId, 'uploads', `${asset.id}.${extFor(claimedMime)}`);
    await this.db.mediaAsset.update({ where: { id: asset.id }, data: { key } });
    await this.put(key, bytes, claimedMime);
    logger.info({ workspaceId, assetId: asset.id, key, mime: claimedMime, bytes: bytes.byteLength }, 'server-side upload stored');
    return this.complete(workspaceId, asset.id);
  }

  /**
   * Fetch a public URL on the caller's behalf, within limits: HTTPS only, no
   * private hosts, a size ceiling read from the headers before the body, and
   * a short timeout. An organization's product images live at URLs; making
   * them download and re-upload would be the API's worst step.
   */
  async ingestUrl(workspaceId: string, userId: string | null, url: string): Promise<MediaAsset> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new ValidationError({ url: 'That is not a valid URL.' });
    }
    if (target.protocol !== 'https:') throw new ValidationError({ url: 'Only https URLs are fetched.' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // Resolved and checked at every hop: no private addresses, no rebinding, no redirect into the network.
      const res = await safeFetch(target, { signal: controller.signal, headers: { accept: 'image/*,video/*,audio/*' } });
      if (!res.ok) throw new ValidationError({ url: `The URL answered ${res.status}.` });
      const mime = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      const family = familyOf(mime);
      if (!family) throw new ValidationError({ url: `The URL serves ${mime || 'an unknown type'}, not an image, video or audio file.` });
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > LIMITS[family].maxBytes)
        throw new ValidationError({ url: `Too large: the limit for ${family} is ${LIMITS[family].maxBytes / 1024 / 1024} MB` });
      const buf = new Uint8Array(await res.arrayBuffer());
      const name = target.pathname.split('/').pop() || `download.${extFor(mime)}`;
      return await this.ingest(workspaceId, userId, buf, mime, name);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      if (err instanceof UnsafeUrlError) throw new ValidationError({ url: err.message });
      throw new ValidationError({ url: `Could not fetch that URL: ${err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : err}` });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The browser says the PUT finished. Verify the object, normalise images,
   * record what it really is, and promote or reject the row.
   */
  async complete(workspaceId: string, assetId: string): Promise<MediaAsset> {
    const asset = await this.db.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.workspaceId !== workspaceId) throw new NotFoundError('upload');
    if (asset.status === 'READY') return asset;

    let head: { ContentLength?: number };
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: asset.key }));
    } catch {
      throw new ValidationError({ upload: 'The file has not arrived in storage yet. Finish the upload, then try again.' });
    }
    const bytes = head.ContentLength ?? 0;
    const headBytes = await this.range(asset.key, 0, 4095);
    const sniffed = sniffMime(headBytes);
    // A browser's voice recording is a WebM with no video track; the container
    // is identical, so the announced type breaks the tie — and only that tie.
    const mime = sniffed === 'video/webm' && asset.mime === 'audio/webm' ? 'audio/webm' : sniffed;
    const family = mime ? familyOf(mime) : null;

    const reject = async (reason: string): Promise<never> => {
      await this.db.mediaAsset.update({ where: { id: assetId }, data: { status: 'REJECTED', bytes, mime: mime ?? undefined } });
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: asset.key })).catch(() => undefined);
      logger.warn({ workspaceId, assetId, key: asset.key, mime, bytes, reason }, 'upload rejected');
      throw new ValidationError({ upload: reason });
    };

    if (!mime || !family) return reject('That file is not an image, video or audio file we can use.');
    if (bytes > LIMITS[family].maxBytes) return reject(`Too large: the limit is ${LIMITS[family].maxBytes / 1024 / 1024} MB.`);

    let width: number | undefined;
    let height: number | undefined;
    let finalBytes = bytes;
    let finalMime = mime;
    let sha256: string;
    let durationMs: number | undefined;

    if (family === 'image') {
      // Re-encode: applies EXIF orientation, strips every tag, guarantees a decodable file.
      const original = await this.getBytes(asset.key);
      let normalised: Buffer;
      let meta: Metadata;
      try {
        const img = sharp(original, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate();
        meta = await img.metadata();
        normalised = mime === 'image/png' || meta.hasAlpha ? await img.png().toBuffer() : await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      } catch (err) {
        logger.warn({ assetId, err: err instanceof Error ? err.message : err }, 'image could not be decoded');
        return reject('That image could not be read. Try exporting it again as a JPEG or PNG.');
      }
      finalMime = mime === 'image/png' || meta.hasAlpha ? 'image/png' : 'image/jpeg';
      const rotated = (meta.orientation ?? 1) >= 5;
      width = rotated ? meta.height : meta.width;
      height = rotated ? meta.width : meta.height;
      await this.put(asset.key, normalised, finalMime);
      finalBytes = normalised.length;
      sha256 = createHash('sha256').update(normalised).digest('hex');
    } else {
      // Probe the object the customer actually uploaded, not its file name or
      // the browser's claim. Besides making duration-based prices possible,
      // this refuses corrupt audio/video before it can become a paid job.
      try {
        durationMs = await this.probeDuration(asset.key);
      } catch {
        return reject('That audio or video could not be read. Try exporting it again as MP4, MOV, MP3 or M4A.');
      }
      sha256 = await this.hash(asset.key);
    }

    const ready = await this.db.mediaAsset.update({
      where: { id: assetId },
      data: { status: 'READY', mime: finalMime, bytes: finalBytes, width, height, durationMs, sha256 },
    });
    logger.info({ workspaceId, assetId, key: asset.key, mime: finalMime, bytes: finalBytes, width, height, durationMs }, 'upload verified');
    return ready;
  }

  /**
   * Backfill verified duration for a READY asset uploaded before duration was
   * recorded. Concurrent quotes may both probe, but the conditional update
   * makes the stored value immutable once one wins.
   */
  async ensureDuration(asset: MediaAsset): Promise<MediaAsset> {
    if (asset.durationMs && asset.durationMs > 0) return asset;
    if (!asset.mime || !['audio', 'video'].includes(familyOf(asset.mime) ?? '')) {
      throw new ValidationError({ sourceKey: 'Choose an audio or video file.' });
    }
    const durationMs = await this.probeDuration(asset.key).catch(() => {
      throw new ValidationError({ sourceKey: 'That audio or video could not be read. Try exporting it again.' });
    });
    await this.db.mediaAsset.updateMany({
      where: { id: asset.id, OR: [{ durationMs: null }, { durationMs: { lte: 0 } }] },
      data: { durationMs },
    });
    return { ...asset, durationMs };
  }

  // ---- reads -----------------------------------------------------------------

  /** A short-lived URL for a READY, recorded key the workspace owns. */
  async readUrl(workspaceId: string, key: string, ttlSec = READ_TTL_SEC): Promise<string> {
    // `readUrls()` already excluded the vault, but this single-key route is
    // also customer-facing. Without the same guard a caller who learned a
    // predictable vault key could mint a URL for an output they had not
    // unlocked yet.
    if (!key.startsWith(`${workspaceId}/`) || MediaService.isVault(key)) throw new ForbiddenError();
    // Prefix ownership alone is not enough. Unlock copies to a public-looking
    // key before the database update; if that flow crashes, an unrecorded R2
    // object must not become readable merely because its name can be guessed.
    const asset = await this.db.mediaAsset.findUnique({
      where: { key },
      include: { generation: { select: { outputs: true } } },
    });
    if (!asset || asset.workspaceId !== workspaceId || asset.status !== 'READY' || asset.deletedAt || !customerReadable(asset)) {
      throw new NotFoundError('media');
    }
    return this.signRead(key, ttlSec);
  }

  /** Many at once; a key the workspace does not own is left out, never an error for the whole batch. */
  async readUrls(workspaceId: string, keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const requested = [...new Set(keys)].filter((key) => key.startsWith(`${workspaceId}/`) && !MediaService.isVault(key));
    if (requested.length === 0) return out;
    const assets = await this.db.mediaAsset.findMany({
      where: { workspaceId, key: { in: requested }, status: 'READY', deletedAt: null, NOT: { key: { startsWith: `${workspaceId}/vault/` } } },
      include: { generation: { select: { outputs: true } } },
    });
    await Promise.all(
      // The vault holds what has not been paid for. No customer-facing path
      // signs it; unlocking copies and records a READY asset outside it.
      assets.filter(customerReadable).map(async ({ key }) => {
        out[key] = await this.signRead(key);
      }),
    );
    return out;
  }

  /** Keys under `<workspace>/vault/` are never signed for a customer. */
  static isVault(key: string): boolean {
    return /^[^/]+\/vault\//.test(key);
  }

  static vaultKey(workspaceId: string, scope: string, name: string, at = new Date()): string {
    const yyyy = at.getUTCFullYear();
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    return `${workspaceId}/vault/${yyyy}/${mm}/${scope}/${name}`;
  }

  /** Server-side copy, for taking a paid-for file out of the vault. */
  async copy(fromKey: string, toKey: string): Promise<void> {
    await this.s3.send(
      new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`, Key: toKey }),
      { abortSignal: AbortSignal.timeout(COPY_TIMEOUT_MS) },
    );
  }

  /** Unchecked signing for the worker, which has already loaded the row. */
  async signRead(key: string, ttlSec = READ_TTL_SEC): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }

  /**
   * A presigned PUT for an object that is not a media asset — a CV under
   * careers/, say. The caller owns the key and the rules; this only signs.
   */
  async presignRaw(key: string, mime: string, bytes: number, ttlSec = UPLOAD_TTL_SEC): Promise<{ url: string; expiresInSec: number }> {
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: bytes }), {
      expiresIn: ttlSec,
    });
    return { url, expiresInSec: ttlSec };
  }

  /** Size and type of an object, or null when it is not there. */
  async head(key: string): Promise<{ bytes: number; mime: string | null } | null> {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: h.ContentLength ?? 0, mime: h.ContentType ?? null };
    } catch {
      return null;
    }
  }

  async getBytes(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async put(key: string, bytes: Uint8Array | Buffer, mime: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mime }));
  }

  /**
   * Store a pipeline intermediate behind a durable MediaAsset row.
   *
   * The PENDING row is committed before the object upload. If the process
   * disappears at any point, generation failure/workspace retention still
   * has a concrete key to delete. A retry uses the same deterministic key and
   * safely overwrites the object instead of creating another orphan.
   */
  async putGenerationWork(input: {
    workspaceId: string;
    generationId: string;
    createdAt: Date;
    name: string;
    bytes: Uint8Array | Buffer;
    mime: string;
    durationMs?: number;
  }): Promise<string> {
    const key = `${MediaService.generationWorkPrefix(input.workspaceId, input.generationId, input.createdAt)}${input.name}`;
    const asset = await this.db.mediaAsset.upsert({
      where: { key },
      create: {
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        kind: 'DERIVED',
        status: 'PENDING',
        key,
        mime: input.mime,
        bytes: input.bytes.byteLength,
        durationMs: input.durationMs,
      },
      update: {
        status: 'PENDING',
        mime: input.mime,
        bytes: input.bytes.byteLength,
        durationMs: input.durationMs,
        deletedAt: null,
      },
    });
    try {
      await this.put(key, input.bytes, input.mime);
      await this.db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'READY' } });
      return key;
    } catch (err) {
      // Keep the row as a deletion target even when the PUT result is
      // ambiguous. DeleteObject is idempotent, so retention can safely try it.
      await this.db.mediaAsset
        .updateMany({ where: { id: asset.id }, data: { status: 'REJECTED', deletedAt: new Date() } })
        .catch((dbErr) => logger.error({ err: dbErr, key }, 'could not retire failed work upload'));
      throw err;
    }
  }

  /** Mark only scratch objects for deletion; thumbnails and final outputs stay. */
  async retireGenerationWork(input: { workspaceId: string; generationId: string; createdAt: Date }, tx?: Prisma.TransactionClient): Promise<number> {
    const db = tx ?? this.db;
    const { count } = await db.mediaAsset.updateMany({
      where: {
        generationId: input.generationId,
        key: { startsWith: MediaService.generationWorkPrefix(input.workspaceId, input.generationId, input.createdAt) },
        status: { not: 'PURGED' },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    return count;
  }

  /**
   * Best-effort immediate deletion after a generation becomes terminal.
   * Failed storage calls leave their retired rows for the retention sweep.
   */
  async purgeGenerationWork(input: { workspaceId: string; generationId: string; createdAt: Date }): Promise<number> {
    const prefix = MediaService.generationWorkPrefix(input.workspaceId, input.generationId, input.createdAt);
    const assets = await this.db.mediaAsset.findMany({
      where: { generationId: input.generationId, key: { startsWith: prefix }, status: { not: 'PURGED' }, deletedAt: { not: null } },
      select: { id: true, key: true },
    });
    let purged = 0;
    for (const asset of assets) {
      if (!(await this.deleteObject(asset.key))) continue;
      const { count } = await this.db.mediaAsset.updateMany({
        where: { id: asset.id, status: { not: 'PURGED' } },
        data: { status: 'PURGED', deletedAt: new Date() },
      });
      purged += count;
    }
    return purged;
  }

  /** Record an object the pipeline produced. */
  async recordOutput(
    input: {
      workspaceId: string;
      generationId: string;
      key: string;
      kind: MediaKind;
      mime: string;
      bytes: number;
      width?: number;
      height?: number;
      durationMs?: number;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<MediaAsset> {
    const db = tx ?? this.db;
    return db.mediaAsset.upsert({
      where: { key: input.key },
      create: { ...input, status: 'READY' },
      update: { mime: input.mime, bytes: input.bytes, width: input.width, height: input.height, durationMs: input.durationMs, status: 'READY' },
    });
  }

  /** A READY source the workspace owns, or a clear refusal. */
  async requireReady(workspaceId: string, key: string): Promise<MediaAsset> {
    // Customer-supplied keys pass through here before they become generation
    // or publishing inputs. A vaulted output exists and is READY, but is not
    // customer-owned until AudioService copies it out after the unlock debit.
    if (MediaService.isVault(key)) throw new NotFoundError('source file');
    const asset = await this.db.mediaAsset.findUnique({ where: { key }, include: { generation: { select: { outputs: true } } } });
    if (!asset || asset.workspaceId !== workspaceId || asset.deletedAt || !customerReadable(asset)) throw new NotFoundError('source file');
    if (asset.status !== 'READY') throw new ValidationError({ sourceKey: 'That upload has not finished being checked.' });
    return asset;
  }

  async list(workspaceId: string, opts: { kind?: MediaKind; take?: number; cursor?: string } = {}): Promise<MediaAsset[]> {
    const rows = await this.db.mediaAsset.findMany({
      // A locked asset's predictable storage key is itself sensitive: callers
      // must not be able to feed it into another feature that signs raw keys.
      where: {
        workspaceId,
        deletedAt: null,
        status: 'READY',
        NOT: { key: { startsWith: `${workspaceId}/vault/` } },
        ...(opts.kind ? { kind: opts.kind } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.take ?? 50,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      include: { generation: { select: { outputs: true } } },
    });
    return rows.filter(customerReadable).map(({ generation: _generation, ...asset }) => asset);
  }

  async softDelete(workspaceId: string, assetId: string): Promise<void> {
    const { count } = await this.db.mediaAsset.updateMany({ where: { id: assetId, workspaceId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (count === 0) throw new NotFoundError('file');
  }

  /**
   * Remove an object from storage. True when it is gone (or never was);
   * false when storage refused, so the caller leaves the row for next time.
   */
  async deleteObject(key: string): Promise<boolean> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      logger.warn({ err, key }, 'storage delete failed');
      return false;
    }
  }

  private async range(key: string, from: number, to: number): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${from}-${to}` }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  private async hash(key: string): Promise<string> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const h = createHash('sha256');
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) h.update(chunk);
    return h.digest('hex');
  }

  /** ffprobe reads the container header over a short-lived internal URL. */
  private async probeDuration(key: string): Promise<number> {
    const url = await this.signRead(key, PROBE_READ_TTL_SEC);
    const stdout = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration:stream=duration', '-of', 'json', url]);
    const durationMs = durationMsFromFfprobe(stdout);
    if (durationMs === null) throw new Error('ffprobe returned no finite positive duration');
    return durationMs;
  }
}

/** Parse the longest declared stream/container duration without trusting NaN or overflow. */
export function durationMsFromFfprobe(stdout: string): number | null {
  let parsed: { format?: { duration?: unknown }; streams?: Array<{ duration?: unknown }> };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return null;
  }
  const candidates = [parsed.format?.duration, ...(parsed.streams ?? []).map((stream) => stream.duration)]
    .map((value) => (typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length === 0) return null;
  const durationMs = Math.ceil(Math.max(...candidates) * 1000);
  return Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= MAX_DATABASE_INT ? durationMs : null;
}

/**
 * A browser's recorder announces "audio/webm;codecs=opus"; a phone's camera
 * adds its own parameters too. The type is what matters, so the parameters
 * are dropped before anything is compared.
 */
export function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

function familyOf(mime: string): keyof typeof LIMITS | null {
  const m = baseMime(mime);
  for (const [family, l] of Object.entries(LIMITS)) if (l.mimes.has(m)) return family as keyof typeof LIMITS;
  return null;
}

function extFor(mime: string): string {
  return (
    (
      {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/heic': 'heic',
        'image/gif': 'gif',
        'video/mp4': 'mp4',
        'video/quicktime': 'mov',
        'video/webm': 'webm',
        'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/wav': 'wav',
        'audio/ogg': 'ogg',
        'audio/webm': 'webm',
      } as Record<string, string>
    )[mime] ?? 'bin'
  );
}
