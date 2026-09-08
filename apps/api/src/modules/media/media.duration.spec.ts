import type { MediaAsset } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFfprobe } from '../../../config/ffmpeg';
import { durationMsFromFfprobe, MediaService } from './media.service';

vi.mock('../../../config/ffmpeg', () => ({ runFfprobe: vi.fn() }));

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset =>
  ({
    id: '11111111-1111-1111-1111-111111111111',
    workspaceId: '22222222-2222-2222-2222-222222222222',
    uploadedById: null,
    generationId: null,
    kind: 'SOURCE',
    status: 'READY',
    key: '22222222-2222-2222-2222-222222222222/2026/09/uploads/source.mp4',
    mime: 'video/mp4',
    bytes: 1_000,
    width: null,
    height: null,
    durationMs: null,
    sha256: null,
    filename: 'source.mp4',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }) as MediaAsset;

describe('verified media duration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists the probed duration when an upload is completed', async () => {
    const pending = asset({ status: 'PENDING' });
    const update = vi.fn().mockImplementation(({ data }: { data: Partial<MediaAsset> }) => Promise.resolve({ ...pending, ...data }));
    const media = new MediaService({ mediaAsset: { findUnique: vi.fn().mockResolvedValue(pending), update } } as never);
    const internals = media as unknown as {
      s3: { send: (command: unknown) => Promise<unknown> };
      range: (key: string, from: number, to: number) => Promise<Buffer>;
      hash: (key: string) => Promise<string>;
      probeDuration: (key: string) => Promise<number>;
    };
    internals.s3 = { send: vi.fn().mockResolvedValue({ ContentLength: 1_000 }) };
    vi.spyOn(internals, 'range').mockResolvedValue(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
    vi.spyOn(internals, 'hash').mockResolvedValue('verified-hash');
    vi.spyOn(internals, 'probeDuration').mockResolvedValue(74_250);

    await expect(media.complete(pending.workspaceId, pending.id)).resolves.toMatchObject({ status: 'READY', durationMs: 74_250 });
    expect(update).toHaveBeenCalledWith({
      where: { id: pending.id },
      data: {
        status: 'READY',
        mime: 'video/mp4',
        bytes: 1_000,
        width: undefined,
        height: undefined,
        durationMs: 74_250,
        sha256: 'verified-hash',
      },
    });
  });

  it('uses the longest finite duration and rounds up to avoid underbilling', () => {
    expect(durationMsFromFfprobe(JSON.stringify({ streams: [{ duration: '60.0001' }, { duration: '59.9' }], format: { duration: '60.0000' } }))).toBe(60_001);
  });

  it.each([
    ['', null],
    ['not json', null],
    [JSON.stringify({ format: { duration: 'N/A' }, streams: [] }), null],
    [JSON.stringify({ format: { duration: '-1' } }), null],
    [JSON.stringify({ format: { duration: String(Number.MAX_SAFE_INTEGER) } }), null],
  ])('rejects an unusable ffprobe result', (stdout, expected) => {
    expect(durationMsFromFfprobe(stdout)).toBe(expected);
  });

  it('does not probe an asset whose verified duration is already stored', async () => {
    const updateMany = vi.fn();
    const media = new MediaService({ mediaAsset: { updateMany } } as never);
    const signRead = vi.spyOn(media, 'signRead');
    const ready = asset({ durationMs: 90_000 });

    await expect(media.ensureDuration(ready)).resolves.toBe(ready);
    expect(signRead).not.toHaveBeenCalled();
    expect(runFfprobe).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('lazily probes and persists duration for a legacy READY asset', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const media = new MediaService({ mediaAsset: { updateMany } } as never);
    vi.spyOn(media, 'signRead').mockResolvedValue('https://storage.example/source.mp4?signature=secret');
    vi.mocked(runFfprobe).mockResolvedValue(JSON.stringify({ streams: [{ duration: '74.25' }], format: { duration: '74.25' } }));

    await expect(media.ensureDuration(asset())).resolves.toMatchObject({ durationMs: 74_250 });
    expect(runFfprobe).toHaveBeenCalledWith([
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=duration',
      '-of',
      'json',
      'https://storage.example/source.mp4?signature=secret',
    ]);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: '11111111-1111-1111-1111-111111111111',
        OR: [{ durationMs: null }, { durationMs: { lte: 0 } }],
      },
      data: { durationMs: 74_250 },
    });
  });

  it('fails closed when a legacy file cannot be measured', async () => {
    const updateMany = vi.fn();
    const media = new MediaService({ mediaAsset: { updateMany } } as never);
    vi.spyOn(media, 'signRead').mockResolvedValue('https://storage.example/source.mp4');
    vi.mocked(runFfprobe).mockResolvedValue(JSON.stringify({ format: { duration: 'N/A' } }));

    await expect(media.ensureDuration(asset())).rejects.toMatchObject({ status: 400 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
