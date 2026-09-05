/**
 * Vendor artifacts → our storage.
 *
 * Every file a vendor produced is copied into R2 under the generation's own
 * prefix right away (vendor URLs expire in minutes), recorded as a
 * MediaAsset, and given a thumbnail so the library never has to load a
 * 4 MB original to draw a 200-pixel card. Text outputs are small and ride
 * inline on the row.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Generation } from '@prisma/client';
import type { GenerationOutput, ProviderArtifact } from '@anystudio/shared';
import { logger } from '../../config/logger';
import { MediaService } from '../modules/media/media.service';
import { fetchBytes } from '../modules/provider/adapters/http';

const exec = promisify(execFile);

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'application/json': 'json',
};

export async function storeArtifacts(media: MediaService, row: Generation, artifacts: ProviderArtifact[]): Promise<GenerationOutput[]> {
  const outputs: GenerationOutput[] = [];
  const counters: Record<string, number> = {};

  for (const a of artifacts) {
    if (a.text !== undefined) {
      outputs.push({ key: '', role: 'text', mime: a.mime, text: a.text });
      continue;
    }
    const bytes = a.bytes ?? (a.url ? (await fetchBytes(row.providerKey ?? 'vendor', a.url, 120_000)).bytes : undefined);
    if (!bytes) {
      logger.warn({ generationId: row.id, role: a.role }, 'artifact had neither bytes nor url; skipped');
      continue;
    }
    const n = (counters[a.role] = (counters[a.role] ?? 0) + 1);
    const ext = EXT[a.mime] ?? 'bin';
    const key = MediaService.key(row.workspaceId, `gen/${row.id}`, `${a.role}-${n}.${ext}`, row.createdAt);

    let width = a.width;
    let height = a.height;
    if (a.mime.startsWith('image/') && (!width || !height)) {
      try {
        const m = await sharp(bytes).metadata();
        width = m.width;
        height = m.height;
      } catch {
        /* dimensions are a nicety */
      }
    }

    await media.put(key, bytes, a.mime);
    await media.recordOutput({
      workspaceId: row.workspaceId,
      generationId: row.id,
      key,
      kind: 'OUTPUT',
      mime: a.mime,
      bytes: bytes.byteLength,
      width,
      height,
      durationMs: a.durationMs,
    });
    const output: GenerationOutput = {
      key,
      role: a.role,
      mime: a.mime,
      bytes: bytes.byteLength,
      width,
      height,
      durationMs: a.durationMs,
      ...(a.size ? { size: a.size } : {}),
    };
    outputs.push(output);

    const thumb = await thumbnail(bytes, a.mime).catch((err) => {
      logger.debug({ generationId: row.id, key, err: err instanceof Error ? err.message : err }, 'no thumbnail');
      return null;
    });
    if (thumb) {
      const thumbKey = MediaService.key(row.workspaceId, `gen/${row.id}`, `thumb-${a.role}-${n}.webp`, row.createdAt);
      await media.put(thumbKey, thumb, 'image/webp');
      await media.recordOutput({
        workspaceId: row.workspaceId,
        generationId: row.id,
        key: thumbKey,
        kind: 'DERIVED',
        mime: 'image/webp',
        bytes: thumb.byteLength,
        width: 512,
      });
      outputs.push({ key: thumbKey, role: 'thumb', mime: 'image/webp', bytes: thumb.byteLength });
    }
  }
  return outputs;
}

/** A 512-px WebP for the library. Images through sharp; videos through one ffmpeg frame grab. */
async function thumbnail(bytes: Uint8Array, mime: string): Promise<Buffer | null> {
  if (mime.startsWith('image/')) {
    return sharp(bytes).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  }
  if (mime.startsWith('video/')) {
    // A temp file, not stdin: seeking needs a seekable input.
    const dir = await mkdtemp(join(tmpdir(), 'thumb-'));
    try {
      const src = join(dir, 'in.mp4');
      await writeFile(src, bytes);
      const { stdout } = await exec(
        'ffmpeg',
        ['-v', 'error', '-ss', '0.5', '-i', src, '-frames:v', '1', '-vf', 'scale=512:-2', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      );
      return await sharp(stdout).webp({ quality: 78 }).toBuffer();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return null;
}
