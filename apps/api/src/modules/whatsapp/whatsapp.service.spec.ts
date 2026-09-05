/**
 * The bot against a real Postgres and the null client: a new number becomes
 * a customer with welcome credits, a photo becomes a request, the song flow
 * collects what it needs and asks, a redelivered message does nothing, and
 * a finished generation is sent back to the number that asked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { SIGNUP_PROMO_CREDITS } from '@anystudio/shared';
import { WhatsappService } from './whatsapp.service';
import { WhatsappClient } from './whatsapp.client';
import { AudioService } from '../audio/audio.service';
import { BillingService } from '../billing/billing.service';
import { GenerationHooks } from '../generation/generation.hooks';
import { GenerationService } from '../generation/generation.service';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { ProviderRegistry } from '../provider/provider.registry';
import { QueueService } from '../queue/queue.service';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('WhatsappService', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const media = new MediaService(db);
  // Media the customer sends is "downloaded" from the null client; ingest is stubbed to record a READY asset without storage.
  media.ingest = async (workspaceId, userId, bytes, mime) =>
    db.mediaAsset.create({
      data: {
        workspaceId,
        uploadedById: userId,
        kind: 'SOURCE',
        status: 'READY',
        key: `${workspaceId}/2026/09/uploads/${crypto.randomUUID()}.jpg`,
        mime,
        bytes: bytes.byteLength,
      },
    });
  media.readUrls = async (_w, keys) => Object.fromEntries(keys.map((k) => [k, `https://signed/${k}`]));
  const client = new WhatsappClient();
  client.download = async () => ({ bytes: new Uint8Array(2000), mime: 'image/jpeg' });
  const hooks = new GenerationHooks();
  const generations = new GenerationService(db, ledger, media, new QueueService(), hooks);
  process.env.APP_ENV = 'test';
  const registry = new ProviderRegistry();
  const svc = new WhatsappService(
    db,
    client,
    generations,
    hooks,
    ledger,
    media,
    new AudioService(db, ledger, media),
    null as unknown as BillingService,
    registry,
  );
  svc.onModuleInit(); // subscribe to finished generations, as Nest would
  const waId = () => `234${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  const last = () => client.sent.at(-1)!.message;

  beforeAll(async () => {
    await db.$connect();
    for (const c of [
      { code: 'image.storefront', credits: 10, label: 'Image' },
      { code: 'audio.music.preview', credits: 10, label: 'Preview' },
      { code: 'audio.music.unlock', credits: 30, label: 'Unlock' },
      { code: 'text.description', credits: 2, label: 'Copy' },
    ])
      await db.creditCost.upsert({ where: { code: c.code }, create: c, update: {} });
    await db.musicGenre.upsert({
      where: { key: 'afrobeats' },
      create: {
        key: 'afrobeats',
        name: 'Afrobeats',
        region: 'Nigeria',
        family: 'african',
        description: 'x',
        promptHints: 'log drum',
        languages: ['en'],
        sort: 1,
      },
      update: {},
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(() => {
    client.sent.length = 0;
  });

  it('a first "hi" creates a user, a workspace and the welcome credits, and answers with the menu', async () => {
    const id = waId();
    expect(await svc.handleInbound(id, 'Kemi Ade', 'wamid.1', { kind: 'text', text: 'hi' })).toBe('handled');
    const contact = await db.whatsappContact.findUniqueOrThrow({ where: { waId: id }, include: { user: true } });
    expect(contact.user?.phone).toBe(`+${id}`);
    expect(contact.user?.phoneVerifiedAt).toBeTruthy();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { workspaceId: contact.workspaceId! } });
    expect(await ledger.balance(wallet.id)).toBe(SIGNUP_PROMO_CREDITS);
    expect(last().kind).toBe('list');
    expect((last() as { text: string }).text).toContain('Hi Kemi');
    // The same message again is a duplicate; a second hello does not grant twice.
    expect(await svc.handleInbound(id, 'Kemi Ade', 'wamid.1', { kind: 'text', text: 'hi' })).toBe('duplicate');
    await svc.handleInbound(id, 'Kemi Ade', 'wamid.2', { kind: 'text', text: 'hello' });
    expect(await ledger.balance(wallet.id)).toBe(SIGNUP_PROMO_CREDITS);
  });

  it('a photo with a caption becomes a branded-image request on the WhatsApp channel, and the result comes back as pictures', async () => {
    const id = waId();
    await svc.handleInbound(id, null, 'wamid.p1', { kind: 'image', mediaId: 'm1', mime: 'image/jpeg', caption: 'on a marble counter' });
    const contact = await db.whatsappContact.findUniqueOrThrow({ where: { waId: id } });
    const row = await db.generation.findFirstOrThrow({ where: { workspaceId: contact.workspaceId! } });
    expect(row).toMatchObject({ capability: 'IMAGE_EDIT', channel: 'WHATSAPP', credits: 10 });
    expect((row.input as { prompt: string }).prompt).toBe('on a marble counter');
    expect((last() as { text: string }).text).toContain('credits held');

    await generations.succeed(row.id, {
      outputs: [
        { key: `${contact.workspaceId}/out.jpg`, role: 'image', mime: 'image/jpeg' },
        { key: `${contact.workspaceId}/story.jpg`, role: 'variant', size: 'story', mime: 'image/jpeg' },
      ],
    });
    await hooks.drain();
    const kinds = client.sent.map((s) => s.message.kind);
    expect(kinds.slice(-3)).toEqual(['image', 'image', 'buttons']);
    expect((client.sent.at(-3)!.message as { url: string }).url).toBe(`https://signed/${contact.workspaceId}/out.jpg`);

    // A photo without a caption asks what to do; a plain sentence after it is the scene.
    await svc.handleInbound(id, null, 'wamid.p2', { kind: 'image', mediaId: 'm2', mime: 'image/jpeg' });
    expect(last().kind).toBe('buttons');
    await svc.handleInbound(id, null, 'wamid.p3', { kind: 'text', text: 'in a garden at golden hour' });
    expect(await db.generation.count({ where: { workspaceId: contact.workspaceId!, capability: 'IMAGE_EDIT' } })).toBe(2);
  });

  it('the song flow collects genre, brief and voice, requests a preview, and offers the unlock when it arrives', async () => {
    const id = waId();
    await svc.handleInbound(id, 'Tolu', 'wamid.s0', { kind: 'text', text: 'hi' });
    await svc.handleInbound(id, 'Tolu', 'wamid.s1', { kind: 'choice', id: 'flow:song', title: 'A song' });
    expect(last().kind).toBe('list');
    await svc.handleInbound(id, 'Tolu', 'wamid.s2', { kind: 'choice', id: 'genre:afrobeats', title: 'Afrobeats' });
    await svc.handleInbound(id, 'Tolu', 'wamid.s3', { kind: 'text', text: 'my sister Kemi turning 30' });
    expect(last().kind).toBe('buttons');
    await svc.handleInbound(id, 'Tolu', 'wamid.s4', { kind: 'choice', id: 'vocal:female', title: 'Female voice' });
    const contact = await db.whatsappContact.findUniqueOrThrow({ where: { waId: id } });
    const row = await db.generation.findFirstOrThrow({ where: { workspaceId: contact.workspaceId!, capability: 'MUSIC' } });
    expect(row.input).toMatchObject({ genre: 'afrobeats', vocal: 'female', brief: 'my sister Kemi turning 30' });

    await generations.succeed(row.id, {
      outputs: [
        { key: `${contact.workspaceId}/preview.mp3`, role: 'preview', mime: 'audio/mpeg' },
        { key: `${contact.workspaceId}/vault/2026/09/gen/x/song.mp3`, role: 'audio', mime: 'audio/mpeg', locked: true },
        { key: '', role: 'text', mime: 'application/json', text: { title: 'Thirty and Shining' } },
      ],
    });
    await hooks.drain();
    expect(client.sent.at(-2)!.message.kind).toBe('audio');
    const offer = last() as { kind: string; text: string; buttons: Array<{ id: string }> };
    expect(offer.text).toContain('Thirty and Shining');
    expect(offer.buttons[0]!.id).toBe(`unlock:${row.id}`);
  });

  it('"stop" opts the number out and nothing is delivered until they write again', async () => {
    const id = waId();
    await svc.handleInbound(id, null, 'wamid.x1', { kind: 'text', text: 'hi' });
    expect(await svc.handleInbound(id, null, 'wamid.x2', { kind: 'text', text: 'STOP' })).toBe('opted_out');
    expect((await db.whatsappContact.findUniqueOrThrow({ where: { waId: id } })).optedOut).toBe(true);
    await svc.handleInbound(id, null, 'wamid.x3', { kind: 'text', text: 'menu' });
    expect((await db.whatsappContact.findUniqueOrThrow({ where: { waId: id } })).optedOut).toBe(false);
  });
});
