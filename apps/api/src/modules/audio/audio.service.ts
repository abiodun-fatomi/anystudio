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
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type Generation } from '@prisma/client';
import type { Request } from 'express';
import { MUSIC_UNLOCK_COST_CODE, type GenerationOutput } from '@anystudio/shared';
import { ConflictError, NotFoundError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import type { Actor } from '../auth/policy';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';

@Injectable()
export class AudioService {
  constructor(private readonly db: PrismaClient, private readonly ledger: LedgerService, private readonly media: MediaService) {}

  /** Every active genre, grouped for the picker. */
  async genres() {
    const rows = await this.db.musicGenre.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    return rows.map((g) => ({ key: g.key, name: g.name, region: g.region, family: g.family, description: g.description, languages: g.languages, bpm: g.bpmMin && g.bpmMax ? [g.bpmMin, g.bpmMax] : null }));
  }

  /** Every active voice whose vendor is configured here — a voice nobody can serve is not offered. */
  async voices(available: (providerKey: string) => boolean) {
    const rows = await this.db.voiceProfile.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    return rows.filter((v) => available(v.providerKey)).map((v) => ({ key: v.key, name: v.name, language: v.language, accent: v.accent, gender: v.gender, tags: v.tags, sampleUrl: v.sampleUrl, provider: v.providerKey.split(':')[0] }));
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

    const [wallet, price] = await Promise.all([
      this.db.wallet.findUniqueOrThrow({ where: { workspaceId }, select: { id: true } }),
      this.unlockPrice(),
    ]);
    const key = `unlock:${row.id}`;
    const entry = await this.ledger.debit({ walletId: wallet.id, amount: price.credits, idempotencyKey: key, referenceId: row.id, reason: price.label });

    const publicKey = MediaService.key(workspaceId, `gen/${row.id}`, `song.${locked.key.split('.').pop() ?? 'mp3'}`, row.createdAt);
    try {
      await this.media.copy(locked.key, publicKey);
      await this.media.recordOutput({ workspaceId, generationId: row.id, key: publicKey, kind: 'OUTPUT', mime: locked.mime, bytes: locked.bytes ?? 0, durationMs: locked.durationMs });
    } catch (err) {
      logger.error({ err, generationId: row.id, from: locked.key, to: publicKey }, 'unlock: copy out of the vault failed; refunding');
      await this.ledger.refund({ walletId: wallet.id, amount: price.credits, idempotencyKey: key, referenceId: row.id, reason: 'Unlock failed' }).catch((e) => logger.error({ err: e, generationId: row.id }, 'unlock: refund also failed — needs a person'));
      throw new ConflictError('The song could not be unlocked just now. Nothing was charged — try again in a moment.');
    }

    const next = outputs.map((o) => (o === locked ? { ...o, key: publicKey, locked: false } : o));
    const updated = await this.db.generation.update({
      where: { id: row.id },
      data: { outputs: next as unknown as Prisma.InputJsonArray, input: { ...(row.input as object), unlockedAt: new Date().toISOString(), unlockLedgerEntryId: entry.id } },
    });
    authLog('audio.unlock', 'succeeded', { userId: actor.userId, workspaceId, generationId: row.id, credits: price.credits, ledgerEntryId: entry.id }, req);
    return { status: 'unlocked' as const, generation: await this.view(updated), credits: price.credits };
  }

  private async view(row: Generation) {
    const outputs = ((row.outputs as GenerationOutput[] | null) ?? []).map((o) => (o.locked ? { ...o, key: '' } : o));
    const urls = await this.media.readUrls(row.workspaceId, outputs.map((o) => o.key).filter(Boolean)).catch(() => ({}) as Record<string, string>);
    return { id: row.id, status: row.status, outputs: outputs.map((o) => ({ ...o, url: o.key ? (urls[o.key] ?? null) : null })), unlockedAt: (row.input as { unlockedAt?: string }).unlockedAt ?? null };
  }
}
