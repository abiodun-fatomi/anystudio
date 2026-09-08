/**
 * Audio: the catalogues the studio picks from, and the one action that is
 * peculiar to songs — unlocking the rest after the preview.
 *
 * Unlock is a purchase on an existing row: debit the unlock price with a
 * key tied to the generation (so a double tap pays once), copy the track
 * out of the vault to a key the API will sign, and rewrite the output. If
 * the copy fails after the debit, the debit is refunded on the same key —
 * a seller is never charged for a song they cannot hear.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type Generation, type VoiceProfile } from '@prisma/client';
import type { Request } from 'express';
import {
  DUB_LANGUAGES,
  DUB_SOURCE_LANGUAGES,
  DUB_VENDOR_KEYS,
  MUSIC_UNLOCK_COST_CODE,
  VOICE_SAMPLE,
  dubLanguagesAvailable,
  type GenerationOutput,
} from '@anystudio/shared';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import type { Actor } from '../auth/policy';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { ProviderRegistry } from '../provider/provider.registry';
import { isVoiceLab } from '../provider/adapters/voice-lab';
import type { CloneVoiceDto } from './audio.dto';
import { runFfmpeg, runFfprobe } from '../../../config/ffmpeg';

/** The vendor that keeps cloned voices. One, on purpose: a clone cannot follow a seller from one vendor to another. */
export const CLONE_PROVIDER_KEY = 'elevenlabs:tts';
/** How many of their own voices a workspace may keep. Vendor slots are finite and shared by every customer. */
export const CLONES_PER_WORKSPACE = 2;

export interface VoiceView {
  key: string;
  name: string;
  language: string;
  accent: string | null;
  gender: string | null;
  tags: string[];
  sampleUrl: string | null;
  provider: string;
  kind: 'PRESET' | 'CLONE';
  /** True when the voice belongs to the workspace asked about. */
  mine: boolean;
  createdAt: string | null;
}

@Injectable()
export class AudioService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly media: MediaService,
    private readonly registry: ProviderRegistry,
  ) {}

  /** Every active genre, grouped for the picker. */
  async genres() {
    const rows = await this.db.musicGenre.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    return rows.map((g) => ({
      key: g.key,
      name: g.name,
      region: g.region,
      family: g.family,
      description: g.description,
      languages: g.languages,
      bpm: g.bpmMin && g.bpmMax ? [g.bpmMin, g.bpmMax] : null,
    }));
  }

  /** Every active preset voice whose vendor is configured here — a voice nobody can serve is not offered. */
  async voices(available: (providerKey: string) => boolean): Promise<VoiceView[]> {
    const rows = await this.db.voiceProfile.findMany({ where: { active: true, kind: 'PRESET' }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    return rows.filter((v) => available(v.providerKey)).map((v) => this.voiceView(v, null));
  }

  /** The presets plus the workspace's own voices, its own first. */
  async voicesFor(workspaceId: string, available: (providerKey: string) => boolean): Promise<VoiceView[]> {
    const rows = await this.db.voiceProfile.findMany({
      where: { active: true, OR: [{ kind: 'PRESET' }, { kind: 'CLONE', workspaceId }] },
      orderBy: [{ kind: 'desc' }, { sort: 'asc' }, { name: 'asc' }],
    });
    const mine = rows.filter((v) => v.kind === 'CLONE');
    const urls = await this.media
      .readUrls(
        workspaceId,
        mine.map((v) => v.sampleKey).filter((k): k is string => Boolean(k)),
      )
      .catch(() => ({}) as Record<string, string>);
    return rows.filter((v) => available(v.providerKey)).map((v) => this.voiceView(v, workspaceId, v.sampleKey ? (urls[v.sampleKey] ?? null) : null));
  }

  /** Whether "your own voice" can be made here at all: the clone vendor must be configured. */
  cloningAvailable(): boolean {
    return isVoiceLab(this.registry.get(CLONE_PROVIDER_KEY));
  }

  /**
   * Make the workspace's own voice from a recording. The sample is
   * transcoded to MP3 first — a browser's recorder produces WebM/Opus,
   * which is also how its length is checked — and the consent is written
   * on the row with who gave it, because a clone of a voice is the one
   * asset here a person could be harmed by.
   */
  async cloneVoice(actor: Actor, workspaceId: string, dto: CloneVoiceDto, req: Request): Promise<VoiceView> {
    const lab = this.registry.get(CLONE_PROVIDER_KEY);
    if (!isVoiceLab(lab)) throw new ConflictError('Your own voice is not available in this environment: no voice vendor is configured.');
    const existing = await this.db.voiceProfile.count({ where: { workspaceId, kind: 'CLONE', active: true } });
    if (existing >= CLONES_PER_WORKSPACE)
      throw new ConflictError(`This workspace already has ${CLONES_PER_WORKSPACE} voices of its own. Remove one to record another.`);

    const asset = await this.media.requireReady(workspaceId, dto.sampleKey);
    const mime = asset.mime ?? '';
    if (!mime.startsWith('audio/') && mime !== 'video/webm' && mime !== 'video/mp4')
      throw new ValidationError({ sampleKey: 'The sample has to be a recording — MP3, M4A, WAV, OGG or what the microphone here records.' });

    const original = await this.media.getBytes(dto.sampleKey);
    const { mp3, seconds } = await toMp3(original, mime);
    if (seconds < VOICE_SAMPLE.minSec)
      throw new ValidationError({ sampleKey: `That is ${Math.round(seconds)} seconds; we need at least ${VOICE_SAMPLE.minSec}. Read a paragraph or two.` });
    if (seconds > VOICE_SAMPLE.maxSec)
      throw new ValidationError({
        sampleKey: `That is ${Math.round(seconds)} seconds; ${VOICE_SAMPLE.maxSec} is the most we can use. Trim it, or record a shorter one.`,
      });

    const name = dto.name?.trim() || 'My voice';
    const language = dto.language ?? 'en';
    const key = `mine:${randomBytes(8).toString('hex')}`;
    const { providerVoiceId } = await lab
      .cloneVoice({
        name: `anystudio ${workspaceId.slice(0, 8)} ${name}`.slice(0, 100),
        samples: [{ bytes: mp3, mime: 'audio/mpeg', filename: 'sample.mp3' }],
        description: `Workspace ${workspaceId}; consent by user ${actor.userId} on ${new Date().toISOString().slice(0, 10)}`,
        labels: { language, use: 'anystudio' },
      })
      .catch((err: unknown) => {
        logger.error({ err, workspaceId, userId: actor.userId, seconds }, 'voice clone failed at the vendor');
        authLog('audio.voice', 'failed', { userId: actor.userId, workspaceId, reason: err instanceof Error ? err.message : String(err) }, req);
        throw new ConflictError('The voice could not be made just now. Try again in a minute.');
      });

    const row = await this.db.voiceProfile.create({
      data: {
        key,
        providerKey: CLONE_PROVIDER_KEY,
        providerVoiceId,
        name,
        language,
        accent: null,
        gender: null,
        tags: ['your voice'],
        sampleUrl: null,
        active: true,
        sort: 0,
        kind: 'CLONE',
        workspaceId,
        sampleKey: dto.sampleKey,
        consentAt: new Date(),
        createdById: actor.userId,
      },
    });
    logger.info({ workspaceId, userId: actor.userId, voiceKey: key, seconds: Math.round(seconds) }, 'voice cloned');
    authLog('audio.voice', 'succeeded', { userId: actor.userId, workspaceId, voiceKey: key, seconds: Math.round(seconds) }, req);
    const url = await this.media.readUrl(workspaceId, dto.sampleKey).catch(() => null);
    return this.voiceView(row, workspaceId, url);
  }

  /** Forget a voice: at the vendor first, then here. The recording stays in the library until the seller deletes it. */
  async deleteVoice(actor: Actor, workspaceId: string, key: string, req: Request): Promise<{ deleted: true }> {
    const row = await this.db.voiceProfile.findFirst({ where: { key, workspaceId, kind: 'CLONE' } });
    if (!row) throw new NotFoundError('voice');
    const lab = this.registry.get(row.providerKey);
    if (isVoiceLab(lab)) {
      await lab.deleteVoice(row.providerVoiceId).catch((err: unknown) => {
        // Ours goes regardless: a row nobody can pick is safer than a vendor voice nobody can find.
        logger.error({ err, workspaceId, voiceKey: key }, 'vendor would not delete the voice; removing ours anyway — check the vendor console');
      });
    }
    await this.db.voiceProfile.delete({ where: { key } });
    authLog('audio.voice', 'succeeded', { userId: actor.userId, workspaceId, voiceKey: key, action: 'delete' }, req);
    return { deleted: true };
  }

  private voiceView(v: VoiceProfile, workspaceId: string | null, sampleUrl: string | null = null): VoiceView {
    return {
      key: v.key,
      name: v.name,
      language: v.language,
      accent: v.accent,
      gender: v.gender,
      tags: v.tags,
      sampleUrl: v.kind === 'CLONE' ? sampleUrl : v.sampleUrl,
      provider: v.providerKey.split(':')[0] ?? v.providerKey,
      kind: v.kind,
      mine: v.kind === 'CLONE' && workspaceId !== null && v.workspaceId === workspaceId,
      createdAt: v.kind === 'CLONE' ? v.createdAt.toISOString() : null,
    };
  }

  /**
   * Dub targets, grouped by region, with the source languages a seller may
   * name. A stub-only environment gets the whole list so the tool can be
   * exercised; a real one gets what its vendors can do.
   */
  dubLanguages(available: (providerKey: string) => boolean) {
    const stubbed = available('stub:any') && !available(DUB_VENDOR_KEYS.elevenlabs) && !available(DUB_VENDOR_KEYS.heygen);
    const rows = stubbed ? [...DUB_LANGUAGES] : dubLanguagesAvailable(available);
    return {
      languages: rows.map((l) => ({ code: l.code, name: l.name, region: l.region, lipsync: Boolean(l.heygen) || stubbed })),
      sources: DUB_SOURCE_LANGUAGES,
      missing: 'Yoruba, Igbo, Hausa and Pidgin are not offered by any dubbing vendor yet.',
    };
  }

  /** What unlocking costs, for the button. */
  async unlockPrice(): Promise<{ costCode: string; credits: number; label: string }> {
    const c = await this.db.creditCost.findUnique({ where: { code: MUSIC_UNLOCK_COST_CODE } });
    if (!c) throw new NotFoundError('unlock price');
    return { costCode: c.code, credits: c.credits, label: c.label };
  }

  async unlock(actor: Actor, workspaceId: string, generationId: string, req: Request) {
    const row = await this.db.generation.findFirst({ where: { id: generationId, workspaceId, deletedAt: null } });
    if (!row) throw new NotFoundError('song');
    if (row.capability !== 'MUSIC') throw new ConflictError('Only songs are unlocked.');
    if (row.status !== 'SUCCEEDED') throw new ConflictError('The song is not finished yet.');
    const outputs = (row.outputs as GenerationOutput[] | null) ?? [];
    const locked = outputs.find((o) => o.role === 'audio' && o.locked);
    if (!locked) {
      const open = outputs.find((o) => o.role === 'audio');
      if (open) return { status: 'already_unlocked' as const, generation: await this.view(row) };
      throw new ConflictError('This song has no full track to unlock.');
    }

    const [wallet, price] = await Promise.all([this.db.wallet.findUniqueOrThrow({ where: { workspaceId }, select: { id: true } }), this.unlockPrice()]);
    const key = `unlock:${row.id}`;
    const entry = await this.ledger.debit({ walletId: wallet.id, amount: price.credits, idempotencyKey: key, referenceId: row.id, reason: price.label });

    const publicKey = MediaService.key(workspaceId, `gen/${row.id}`, `song.${locked.key.split('.').pop() ?? 'mp3'}`, row.createdAt);
    try {
      await this.media.copy(locked.key, publicKey);
      await this.media.recordOutput({
        workspaceId,
        generationId: row.id,
        key: publicKey,
        kind: 'OUTPUT',
        mime: locked.mime,
        bytes: locked.bytes ?? 0,
        durationMs: locked.durationMs,
      });
    } catch (err) {
      logger.error({ err, generationId: row.id, from: locked.key, to: publicKey }, 'unlock: copy out of the vault failed; refunding');
      await this.ledger
        .refund({ walletId: wallet.id, amount: price.credits, idempotencyKey: key, referenceId: row.id, reason: 'Unlock failed' })
        .catch((e) => logger.error({ err: e, generationId: row.id }, 'unlock: refund also failed — needs a person'));
      throw new ConflictError('The song could not be unlocked just now. Nothing was charged — try again in a moment.');
    }

    const next = outputs.map((o) => (o === locked ? { ...o, key: publicKey, locked: false } : o));
    const updated = await this.db.generation.update({
      where: { id: row.id },
      data: {
        outputs: next as unknown as Prisma.InputJsonArray,
        input: { ...(row.input as object), unlockedAt: new Date().toISOString(), unlockLedgerEntryId: entry.id },
      },
    });
    authLog('audio.unlock', 'succeeded', { userId: actor.userId, workspaceId, generationId: row.id, credits: price.credits, ledgerEntryId: entry.id }, req);
    return { status: 'unlocked' as const, generation: await this.view(updated), credits: price.credits };
  }

  private async view(row: Generation) {
    const outputs = ((row.outputs as GenerationOutput[] | null) ?? []).map((o) => (o.locked ? { ...o, key: '' } : o));
    const urls = await this.media.readUrls(row.workspaceId, outputs.map((o) => o.key).filter(Boolean)).catch(() => ({}) as Record<string, string>);
    return {
      id: row.id,
      status: row.status,
      outputs: outputs.map((o) => ({ ...o, url: o.key ? (urls[o.key] ?? null) : null })),
      unlockedAt: (row.input as { unlockedAt?: string }).unlockedAt ?? null,
    };
  }
}

/** Any recording → 44.1 kHz mono MP3, and how long it is. */
async function toMp3(bytes: Uint8Array, mime: string): Promise<{ mp3: Uint8Array; seconds: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  try {
    const ext = mime.includes('webm')
      ? 'webm'
      : mime.includes('mp4') || mime.includes('m4a')
        ? 'm4a'
        : mime.includes('wav')
          ? 'wav'
          : mime.includes('ogg')
            ? 'ogg'
            : 'mp3';
    const src = join(dir, `sample.${ext}`);
    const out = join(dir, 'sample.mp3');
    await writeFile(src, bytes);
    try {
      await runFfmpeg('voice-sample', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', out], {
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, mime }, 'voice sample could not be decoded');
      throw new ValidationError({ sampleKey: 'That recording could not be read. Try recording again, or upload an MP3.' });
    }
    const stdout = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out]);
    return { mp3: new Uint8Array(await readFile(out)), seconds: parseFloat(stdout.trim()) || 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
