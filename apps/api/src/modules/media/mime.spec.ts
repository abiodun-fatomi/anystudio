import { describe, expect, it, vi } from 'vitest';
import { baseMime, customerReadable, MediaService, missingMediaStorageEnv } from './media.service';

describe('media storage configuration', () => {
  it('lists every missing variable for production boot validation', () => {
    expect(
      missingMediaStorageEnv({
        R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
        R2_BUCKET: 'bucket',
        R2_ACCESS_KEY_ID: 'key',
      }),
    ).toEqual(['R2_SECRET_ACCESS_KEY']);
    expect(
      missingMediaStorageEnv({
        R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
        R2_BUCKET: 'bucket',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toEqual([]);
  });
});

describe('what a browser announces', () => {
  it('drops the codec parameters a recorder adds', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('audio/mp4; codecs="mp4a.40.2"')).toBe('audio/mp4');
    expect(baseMime('video/webm;codecs=vp9,opus')).toBe('video/webm');
  });

  it('leaves a plain type alone, and lowercases a shouted one', () => {
    expect(baseMime('image/jpeg')).toBe('image/jpeg');
    expect(baseMime('IMAGE/PNG')).toBe('image/png');
    expect(baseMime(' audio/mpeg ')).toBe('audio/mpeg');
  });
});

describe('vault keys', () => {
  it('recognises locked media while leaving ordinary workspace media readable', () => {
    expect(MediaService.isVault('11111111-1111-1111-1111-111111111111/vault/2026/09/song/full.mp3')).toBe(true);
    expect(MediaService.isVault('11111111-1111-1111-1111-111111111111/2026/09/song/full.mp3')).toBe(false);
  });

  it('refuses to mint either a read URL or a reusable input for locked media', async () => {
    const findUnique = vi.fn();
    const media = new MediaService({ mediaAsset: { findUnique } } as never);
    const signRead = vi.spyOn(media, 'signRead').mockResolvedValue('https://signed.example/file');
    const workspaceId = '11111111-1111-1111-1111-111111111111';
    const key = `${workspaceId}/vault/2026/09/gen/22222222-2222-2222-2222-222222222222/song.mp3`;

    await expect(media.readUrl(workspaceId, key)).rejects.toMatchObject({ status: 403 });
    await expect(media.requireReady(workspaceId, key)).rejects.toMatchObject({ status: 404 });
    expect(signRead).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('omits vault assets from the customer media list', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const media = new MediaService({ mediaAsset: { findMany } } as never);
    const workspaceId = '11111111-1111-1111-1111-111111111111';

    await media.list(workspaceId);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: { key: { startsWith: `${workspaceId}/vault/` } } }),
      }),
    );
  });

  it('does not sign guessed or unrecorded workspace keys', async () => {
    const workspaceId = '11111111-1111-1111-1111-111111111111';
    const key = `${workspaceId}/2026/09/gen/song.mp3`;
    const findUnique = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn().mockResolvedValue([{ key, kind: 'SOURCE', generation: null }]);
    const media = new MediaService({ mediaAsset: { findUnique, findMany } } as never);
    const signRead = vi.spyOn(media, 'signRead').mockResolvedValue('https://signed.example/file');

    await expect(media.readUrl(workspaceId, key)).rejects.toMatchObject({ status: 404 });
    expect(signRead).not.toHaveBeenCalled();

    await expect(media.readUrls(workspaceId, [key, `${workspaceId}/vault/2026/09/gen/song.mp3`])).resolves.toEqual({
      [key]: 'https://signed.example/file',
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId, key: { in: [key] }, status: 'READY', deletedAt: null }),
      }),
    );
  });

  it('does not expose a historical READY output unless the generation committed it as unlocked', async () => {
    const workspaceId = '11111111-1111-1111-1111-111111111111';
    const key = `${workspaceId}/2026/09/gen/22222222-2222-2222-2222-222222222222/song.mp3`;
    const orphan = {
      key,
      kind: 'OUTPUT' as const,
      workspaceId,
      status: 'READY',
      deletedAt: null,
      generation: {
        outputs: [{ role: 'audio', key: `${workspaceId}/vault/2026/09/gen/22222222-2222-2222-2222-222222222222/song.mp3`, locked: true }],
      },
    };
    const findUnique = vi.fn().mockResolvedValue(orphan);
    const findMany = vi.fn().mockResolvedValue([orphan]);
    const media = new MediaService({ mediaAsset: { findUnique, findMany } } as never);
    const signRead = vi.spyOn(media, 'signRead').mockResolvedValue('https://signed.example/file');

    expect(customerReadable(orphan)).toBe(false);
    await expect(media.readUrl(workspaceId, key)).rejects.toMatchObject({ status: 404 });
    await expect(media.requireReady(workspaceId, key)).rejects.toMatchObject({ status: 404 });
    await expect(media.readUrls(workspaceId, [key])).resolves.toEqual({});
    expect(signRead).not.toHaveBeenCalled();
  });
});

describe('generation work objects', () => {
  const workspaceId = '11111111-1111-1111-1111-111111111111';
  const generationId = '22222222-2222-2222-2222-222222222222';
  const createdAt = new Date('2026-09-07T00:00:00Z');

  it('records the deletion target before uploading the object', async () => {
    const order: string[] = [];
    const update = vi.fn(async () => {
      order.push('ready');
      return {};
    });
    const db = {
      mediaAsset: {
        upsert: vi.fn(async () => {
          order.push('pending');
          return { id: 'asset-1' };
        }),
        update,
        updateMany: vi.fn(),
      },
    };
    const media = new MediaService(db as never);
    vi.spyOn(media, 'put').mockImplementation(async () => {
      order.push('put');
    });

    const key = await media.putGenerationWork({
      workspaceId,
      generationId,
      createdAt,
      name: 'voice.mp3',
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'audio/mpeg',
    });

    expect(key).toBe(`${workspaceId}/2026/09/gen/${generationId}/work/voice.mp3`);
    expect(order).toEqual(['pending', 'put', 'ready']);
    expect(db.mediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ generationId, kind: 'DERIVED', status: 'PENDING', key }),
      }),
    );
  });

  it('purges only the tracked work prefix and leaves a refused delete for retention', async () => {
    const prefix = MediaService.generationWorkPrefix(workspaceId, generationId, createdAt);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      mediaAsset: {
        findMany: vi.fn(async () => [
          { id: 'gone', key: `${prefix}gone.mp3` },
          { id: 'retry', key: `${prefix}retry.mp4` },
        ]),
        updateMany,
      },
    };
    const media = new MediaService(db as never);
    vi.spyOn(media, 'deleteObject').mockImplementation(async (key) => !key.endsWith('retry.mp4'));

    await expect(media.purgeGenerationWork({ workspaceId, generationId, createdAt })).resolves.toBe(1);
    expect(db.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ generationId, key: { startsWith: prefix } }) }),
    );
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'gone', status: { not: 'PURGED' } } }));
  });
});
