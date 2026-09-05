import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { LibraryService, toTsQuery } from './library.service';
import { InsightsService } from '../insights/insights.service';
import { libraryFields } from '../generation/generation.service';
import { MediaService } from '../media/media.service';
import { LedgerService } from '../ledger/ledger.service';

describe('search query', () => {
  it('turns words into a prefix AND query and drops punctuation', () => {
    expect(toTsQuery('Ankara wrap, red')).toBe('ankara:* & wrap:* & red:*');
    expect(toTsQuery('a')).toBeNull();
    expect(toTsQuery(undefined)).toBeNull();
    expect(toTsQuery('Adíre')).toBe('adire:*');
  });
});

describe('library fields', () => {
  it('derives a title, a product key and search text from the params', () => {
    const f = libraryFields({ productName: 'Ankara Wrap Dress', prompt: 'on a beach', details: 'cotton', price: '₦12,000' });
    expect(f.title).toBe('Ankara Wrap Dress');
    expect(f.productKey).toBe('ankara-wrap-dress');
    expect(f.searchText).toContain('cotton');
  });
  it('uses the prompt when there is no product name, and the explicit key when given', () => {
    const f = libraryFields({ prompt: 'a bottle of palm oil on a wooden table in morning light for the market', productKey: 'SKU-9' });
    expect(f.title).toBe('a bottle of palm oil on a wooden');
    expect(f.productKey).toBe('SKU-9');
  });
});

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('LibraryService + InsightsService', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const media = new MediaService(db);
  const library = new LibraryService(db, media);
  const insights = new InsightsService(db, ledger);
  let workspaceId: string;
  let userId: string;
  let walletId: string;

  beforeAll(async () => {
    await db.$connect();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    const user = await db.user.create({ data: { email: `lib-${crypto.randomUUID()}@test.local` } });
    userId = user.id;
    const ws = await db.workspace.create({
      data: { type: 'BUSINESS', name: 'Shop', members: { create: { userId, role: 'OWNER' } }, wallet: { create: {} } },
      include: { wallet: true },
    });
    workspaceId = ws.id;
    walletId = ws.wallet!.id;
    await ledger.grant({ walletId, amount: 500, idempotencyKey: `grant-${workspaceId}` });
    const mk = (over: Record<string, unknown>) =>
      db.generation.create({
        data: {
          workspaceId,
          requestedById: userId,
          capability: 'IMAGE_EDIT',
          costCode: 'image.storefront',
          credits: 10,
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          input: {},
          outputs: [{ key: `k-${crypto.randomUUID()}.webp`, role: 'image', mime: 'image/webp' }],
          ...over,
        } as never,
      });
    await mk({ ...libraryFields({ productName: 'Ankara Wrap Dress', prompt: 'studio white' }), createdAt: new Date(Date.now() - 3 * 86400_000) });
    await mk({
      ...libraryFields({ productName: 'Ankara Wrap Dress', prompt: 'on a beach' }),
      favourite: true,
      createdAt: new Date(Date.now() - 2 * 86400_000),
    });
    await mk({
      ...libraryFields({ productName: 'Palm oil 5L' }),
      capability: 'TEXT_GENERATE',
      costCode: 'text.description',
      credits: 2,
      outputs: [{ key: '', role: 'text', mime: 'application/json', text: { description: { long: 'Pure red palm oil from Ondo' } } }],
      searchText: 'Palm oil 5L Pure red palm oil from Ondo',
    });
    await mk({
      ...libraryFields({ productName: 'Palm oil 5L' }),
      capability: 'IMAGE_TO_VIDEO',
      costCode: 'video.reel',
      credits: 120,
      outputs: [{ key: 'v.mp4', role: 'video', mime: 'video/mp4' }],
    });
    await mk({ capability: 'TEXT_GENERATE', input: { task: 'shot_plan' }, costCode: 'video.shot', credits: 0 });
    await mk({ status: 'FAILED', failureKind: 'PROVIDER_DOWN', finishedAt: null });
    await mk({ kind: 'CHILD', costCode: 'video.shot', credits: 0 });
    await ledger.debit({ walletId, amount: 132, idempotencyKey: `spend-${workspaceId}` });
  });

  it('lists only things the seller made: no children, no shot plans, no failures; newest first', async () => {
    const { items, nextCursor } = await library.list(workspaceId, {});
    expect(items).toHaveLength(4);
    expect(nextCursor).toBeNull();
    expect(items.map((i) => i.type)).toEqual(['video', 'copy', 'image', 'image']);
    expect(items[1]!.text).toMatchObject({ description: { long: expect.stringContaining('palm') } });
  });

  it('filters by type, product and favourite', async () => {
    expect((await library.list(workspaceId, { type: 'image' })).items).toHaveLength(2);
    expect((await library.list(workspaceId, { type: 'copy' })).items).toHaveLength(1);
    expect((await library.list(workspaceId, { product: 'ankara-wrap-dress' })).items).toHaveLength(2);
    expect((await library.list(workspaceId, { favourite: true })).items).toHaveLength(1);
  });

  it('searches titles, prompts and the copy that came back, by prefix', async () => {
    expect((await library.list(workspaceId, { q: 'ank' })).items).toHaveLength(2);
    expect((await library.list(workspaceId, { q: 'beach' })).items).toHaveLength(1);
    expect((await library.list(workspaceId, { q: 'ondo' })).items).toHaveLength(1);
    expect((await library.list(workspaceId, { q: 'ankara beach' })).items).toHaveLength(1);
    expect((await library.list(workspaceId, { q: 'zebra' })).items).toHaveLength(0);
  });

  it('pages with a cursor without repeating or skipping', async () => {
    const a = await library.list(workspaceId, { take: 3 });
    expect(a.items).toHaveLength(3);
    expect(a.nextCursor).toBe(a.items[2]!.id);
    const b = await library.list(workspaceId, { take: 3, cursor: a.nextCursor! });
    expect(b.items).toHaveLength(1);
    expect(b.nextCursor).toBeNull();
    expect(new Set([...a.items, ...b.items].map((i) => i.id)).size).toBe(4);
  });

  it('groups a catalogue by product', async () => {
    const p = await library.products(workspaceId);
    expect(p.map((x) => [x.productKey, x.count])).toEqual(
      expect.arrayContaining([
        ['ankara-wrap-dress', 2],
        ['palm-oil-5l', 2],
      ]),
    );
  });

  it('rename, star, delete — and a deleted item leaves every list', async () => {
    const { items } = await library.list(workspaceId, { type: 'video' });
    const v = items[0]!;
    const renamed = await library.patch(workspaceId, v.id, { title: 'Palm oil reel', favourite: true });
    expect(renamed.title).toBe('Palm oil reel');
    expect(renamed.favourite).toBe(true);
    await library.remove(workspaceId, v.id);
    expect((await library.list(workspaceId, {})).items.map((i) => i.id)).not.toContain(v.id);
    await expect(library.get(workspaceId, v.id)).rejects.toMatchObject({ status: 404 });
  });

  it('insights: totals, a full daily series, credits by type, and a runway from the last two weeks', async () => {
    const o = await insights.overview(workspaceId, { days: 30 });
    expect(o.series).toHaveLength(30);
    expect(o.series.reduce((s, d) => s + d.made, 0)).toBe(4);
    expect(o.series.reduce((s, d) => s + d.failed, 0)).toBe(1);
    expect(o.totals.made).toBe(4);
    expect(o.totals.failed).toBe(1);
    expect(o.totals.successRate).toBe(80);
    expect(o.byType.video).toMatchObject({ count: 1, credits: 120 });
    expect(o.byType.image).toMatchObject({ count: 2, credits: 20 });
    expect(o.balance.credits).toBe(368);
    expect(o.balance.dailySpend).toBeCloseTo(132 / 14, 1);
    expect(o.balance.runwayDays).toBe(Math.floor(368 / (132 / 14)));
    expect(o.library).toMatchObject({ total: 4, images: 2, videos: 1, copy: 1 });
    expect(o.topProducts[0]).toMatchObject({ count: 2 });
  });
});
