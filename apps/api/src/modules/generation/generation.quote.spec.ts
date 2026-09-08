import type { MediaAsset } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { LedgerService } from '../ledger/ledger.service';
import type { MediaService } from '../media/media.service';
import type { QueueService } from '../queue/queue.service';
import type { GenerationHooks } from './generation.hooks';
import { GenerationService } from './generation.service';

const SOURCE_KEY = '22222222-2222-2222-2222-222222222222/2026/09/uploads/source.mp4';

function source(durationMs: number): MediaAsset {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    workspaceId: '22222222-2222-2222-2222-222222222222',
    uploadedById: null,
    generationId: null,
    kind: 'SOURCE',
    status: 'READY',
    key: SOURCE_KEY,
    mime: 'video/mp4',
    bytes: 1_000,
    width: null,
    height: null,
    durationMs,
    sha256: null,
    filename: 'source.mp4',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    deletedAt: null,
  };
}

function quoteService(durationMs: number, credits = 240) {
  const row = source(durationMs);
  const db = {
    creditCost: { findUnique: vi.fn().mockResolvedValue({ code: 'video.translate_lipsync', credits, label: 'Translate with matching lips' }) },
    wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'wallet' }) },
  };
  const media = {
    requireReady: vi.fn().mockResolvedValue(row),
    ensureDuration: vi.fn().mockResolvedValue(row),
  };
  const ledger = { balance: vi.fn().mockResolvedValue(10_000) };
  return {
    service: new GenerationService(
      db as never,
      ledger as unknown as LedgerService,
      media as unknown as MediaService,
      {} as QueueService,
      {} as GenerationHooks,
    ),
    db,
    media,
  };
}

describe('generation duration quotes', () => {
  it('quotes a lip-synced dub from the stored source duration', async () => {
    const { service, media } = quoteService(61_000);

    await expect(
      service.quote('22222222-2222-2222-2222-222222222222', 'DUB', {
        sourceKey: SOURCE_KEY,
        lipsync: true,
        quality: 'speed',
      }),
    ).resolves.toMatchObject({
      costCode: 'video.translate_lipsync',
      credits: 720,
      label: 'Translate with matching lips × 3',
      balance: 10_000,
      balanceAfter: 9_280,
    });
    expect(media.requireReady).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222', SOURCE_KEY);
    expect(media.ensureDuration).toHaveBeenCalledOnce();
  });

  it('rejects an over-limit source before presenting a purchasable quote', async () => {
    const { service, db } = quoteService(300_001);

    await expect(
      service.quote('22222222-2222-2222-2222-222222222222', 'DUB', {
        sourceKey: SOURCE_KEY,
        lipsync: true,
        quality: 'speed',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.wallet.findUnique).not.toHaveBeenCalled();
  });
});
