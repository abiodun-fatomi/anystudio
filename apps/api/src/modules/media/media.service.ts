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
import { PrismaClient, type MediaAsset, type MediaKind } from '@prisma/client';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { sniffMime } from './sniff';

/** Signed URLs live this long. Long enough to upload on 3G, short enough to be useless when leaked. */
const UPLOAD_TTL_SEC = 15 * 60;
const READ_TTL_SEC = 15 * 60;

const LIMITS = {
  image: { maxBytes: 25 * 1024 * 1024, mimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']) },
  video: { maxBytes: 250 * 1024 * 1024, mimes: new Set(['video/mp4', 'video/quicktime', 'video/webm']) },
  audio: { maxBytes: 30 * 1024 * 1024, mimes: new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/x-m4a']) },
};

export interface PresignedUpload {
  assetId: string;
  key: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSec: number;
}

@Injectable()
export class MediaService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly db: PrismaClient) {
    this.bucket = process.env.R2_BUCKET ?? 'anystudio-dev';
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '' },
    });
    if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID) {
      logger.warn('R2 is not configured: uploads and outputs will fail until R2_ENDPOINT and its keys are set');
    }
  }

  /** {workspaceId}/{yyyy}/{mm}/{scope}/{name} — sortable, per-tenant, lifecycle-friendly. */
  static key(workspaceId: string, scope: string, name: string, at = new Date()): string {
    const yyyy = at.getUTCFullYear();
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    return `${workspaceId}/${yyyy}/${mm}/${scope}/${name}`;
  }

  // ---- uploads ---------------------------------------------------------------

  /** Announce an upload: a PENDING row and a URL the browser PUTs the file to. */
  async presignUpload(workspaceId: string, userId: string, file: { filename: string; mime: string; bytes: number }): Promise<PresignedUpload> {
    const family = familyOf(file.mime);
    if (!family) throw new ValidationError({ mime: `Unsupported file type ${file.mime}` });
    if (file.bytes > LIMITS[family].maxBytes) throw new ValidationError({ bytes: `Too large: the limit for ${family} is ${LIMITS[family].maxBytes / 1024 / 1024} MB` });

    const asset = await this.db.mediaAsset.create({
      data: { workspaceId, uploadedById: userId, kind: 'SOURCE', filename: file.filename.slice(0, 200), key: 'pending' },
    });
    const key = MediaService.key(workspaceId, 'uploads', `${asset.id}.${extFor(file.mime)}`);
    await this.db.mediaAsset.update({ where: { id: asset.id }, data: { key } });

    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: file.mime, ContentLength: file.bytes }), { expiresIn: UPLOAD_TTL_SEC });
    logger.info({ workspaceId, assetId: asset.id, key, mime: file.mime, bytes: file.bytes }, 'upload presigned');
    return { assetId: asset.id, key, url, method: 'PUT', headers: { 'content-type': file.mime }, expiresInSec: UPLOAD_TTL_SEC };
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
    const mime = sniffMime(headBytes);
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
      sha256 = await this.hash(asset.key);
    }

    const ready = await this.db.mediaAsset.update({
      where: { id: assetId },
      data: { status: 'READY', mime: finalMime, bytes: finalBytes, width, height, sha256 },
    });
    logger.info({ workspaceId, assetId, key: asset.key, mime: finalMime, bytes: finalBytes, width, height }, 'upload verified');
    return ready;
  }

  // ---- reads -----------------------------------------------------------------

  /** A short-lived URL for a key the workspace owns. Membership is the caller's job; ownership is checked here. */
  async readUrl(workspaceId: string, key: string): Promise<string> {
    if (!key.startsWith(`${workspaceId}/`)) throw new ForbiddenError();
    return this.signRead(key);
  }

  /** Many at once; a key the workspace does not own is left out, never an error for the whole batch. */
  async readUrls(workspaceId: string, keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      [...new Set(keys)].filter((k) => k.startsWith(`${workspaceId}/`)).map(async (k) => { out[k] = await this.signRead(k); }),
    );
    return out;
  }

  /** Unchecked signing for the worker, which has already loaded the row. */
  async signRead(key: string, ttlSec = READ_TTL_SEC): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }

  async getBytes(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async put(key: string, bytes: Uint8Array | Buffer, mime: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mime }));
  }

  /** Record an object the pipeline produced. */
  async recordOutput(input: { workspaceId: string; generationId: string; key: string; kind: MediaKind; mime: string; bytes: number; width?: number; height?: number; durationMs?: number }): Promise<MediaAsset> {
    return this.db.mediaAsset.upsert({
      where: { key: input.key },
      create: { ...input, status: 'READY' },
      update: { mime: input.mime, bytes: input.bytes, width: input.width, height: input.height, durationMs: input.durationMs, status: 'READY' },
    });
  }

  /** A READY source the workspace owns, or a clear refusal. */
  async requireReady(workspaceId: string, key: string): Promise<MediaAsset> {
    const asset = await this.db.mediaAsset.findUnique({ where: { key } });
    if (!asset || asset.workspaceId !== workspaceId || asset.deletedAt) throw new NotFoundError('source file');
    if (asset.status !== 'READY') throw new ValidationError({ sourceKey: 'That upload has not finished being checked.' });
    return asset;
  }

  async list(workspaceId: string, opts: { kind?: MediaKind; take?: number; cursor?: string } = {}): Promise<MediaAsset[]> {
    return this.db.mediaAsset.findMany({
      where: { workspaceId, deletedAt: null, status: 'READY', ...(opts.kind ? { kind: opts.kind } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.take ?? 50,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    });
  }

  async softDelete(workspaceId: string, assetId: string): Promise<void> {
    const { count } = await this.db.mediaAsset.updateMany({ where: { id: assetId, workspaceId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (count === 0) throw new NotFoundError('file');
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
}

function familyOf(mime: string): keyof typeof LIMITS | null {
  for (const [family, l] of Object.entries(LIMITS)) if (l.mimes.has(mime)) return family as keyof typeof LIMITS;
  return null;
}

function extFor(mime: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg' } as Record<string, string>)[mime] ?? 'bin';
}
