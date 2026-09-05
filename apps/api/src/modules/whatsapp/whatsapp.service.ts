/**
 * The WhatsApp bot: the studio, for someone who lives in WhatsApp.
 *
 * A phone number is the account. The first message from a new number
 * creates a user, a personal workspace and the welcome credits — the same
 * grant the web sign-up gets, keyed to the same idempotency key, because a
 * phone WhatsApp has verified is at least as good as an email we have.
 *
 * The conversation is a small state machine kept on the contact row
 * (`state`: which flow, which step, what has been collected). Every flow
 * ends in the same place the web studio's does — GenerationService.request
 * — and the result comes back through GenerationHooks to `deliver`, which
 * sends the picture, the song's preview, the voiceover or the caption to
 * the same number. The Frobits loop is here too: the preview first, then a
 * button that pays for the rest.
 *
 * Meta retries webhooks; a message id we have seen is a no-op. Meta also
 * sends statuses (sent/delivered/read) on the same hook; they are ignored.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient, type Generation, type WhatsappContact } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNUP_PROMO_CREDITS, signupGrantKey, type GenerationOutput } from '@anystudio/shared';
import { AppError, InsufficientCreditsError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import type { Actor } from '../auth/policy';
import { AudioService } from '../audio/audio.service';
import { BillingService } from '../billing/billing.service';
import { GenerationHooks } from '../generation/generation.hooks';
import { GenerationService, customerMessage } from '../generation/generation.service';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { ProviderRegistry } from '../provider/provider.registry';
import { WhatsappClient, mask } from './whatsapp.client';
import { normaliseInbound, type Inbound, type Outbound, type WebhookEnvelope } from './whatsapp.types';

/** The conversation as kept on the contact row. */
export interface BotState {
  flow: 'idle' | 'photo' | 'song' | 'voice' | 'copy';
  step?: string;
  data?: Record<string, unknown>;
  /** The last photo they sent, so "make a reel" a minute later still knows which one. */
  sourceKey?: string;
}

const MENU_WORDS = new Set(['hi', 'hello', 'hey', 'menu', 'start', 'help', 'home', '?', 'hallo', 'good morning', 'good afternoon', 'good evening']);
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel all']);
const INBOUND_PER_MINUTE = 30;

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly db: PrismaClient,
    private readonly client: WhatsappClient,
    private readonly generations: GenerationService,
    private readonly hooks: GenerationHooks,
    private readonly ledger: LedgerService,
    private readonly media: MediaService,
    private readonly audio: AudioService,
    private readonly billing: BillingService,
    private readonly registry: ProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.hooks.onFinished((row) => this.deliver(row));
  }

  // ---------------------------------------------------------------- webhook

  /** Meta's subscription handshake: echo the challenge when the verify token matches. */
  verify(query: Record<string, unknown>): string | null {
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (!expected) return null;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected && typeof query['hub.challenge'] === 'string') return query['hub.challenge'];
    return null;
  }

  /** `X-Hub-Signature-256: sha256=…` over the raw body with the app secret. Without a secret configured, nothing is trusted. */
  signatureOk(rawBody: Buffer, header: string | undefined): boolean {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret || !header?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = header.slice(7);
    return given.length === expected.length && timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  }

  /** Everything in one envelope, message by message, each on its own — one bad message must not lose the others. */
  async receive(envelope: WebhookEnvelope): Promise<{ handled: number; skipped: number }> {
    let handled = 0; let skipped = 0;
    for (const entry of envelope.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages?.length) continue;
        const names = new Map((value.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name ?? null]));
        for (const m of value.messages) {
          try {
            const outcome = await this.handleInbound(m.from, names.get(m.from) ?? null, m.id, normaliseInbound(m));
            if (outcome === 'handled') handled++; else skipped++;
          } catch (err) {
            skipped++;
            logger.error({ err, from: mask(m.from), messageId: m.id, type: m.type }, 'whatsapp message failed');
            await this.client.send(m.from, { kind: 'text', text: 'Something went wrong on our side. Nothing was charged — try that again in a moment.' }).catch(() => undefined);
          }
        }
      }
    }
    return { handled, skipped };
  }

  // ---------------------------------------------------------------- inbound

  async handleInbound(waId: string, name: string | null, waMessageId: string, inbound: Inbound): Promise<'handled' | 'duplicate' | 'throttled' | 'opted_out'> {
    if (!this.allow(waId)) { logger.warn({ from: mask(waId) }, 'whatsapp: too many messages from one number; dropping'); return 'throttled'; }
    const contact = await this.contactFor(waId, name);
    // Record first: the unique index on the message id is what makes a redelivered webhook a no-op.
    try {
      await this.db.whatsappMessage.create({ data: { contactId: contact.id, waMessageId, direction: 'IN', type: inbound.kind, body: inbound as unknown as Prisma.InputJsonObject } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'duplicate';
      throw err;
    }
    await this.db.whatsappContact.update({ where: { id: contact.id }, data: { lastInboundAt: new Date(), ...(contact.optedOut ? { optedOut: false } : {}) } });
    void this.client.markRead(waMessageId);

    const text = inbound.kind === 'text' ? inbound.text.toLowerCase() : '';
    if (STOP_WORDS.has(text)) {
      await this.db.whatsappContact.update({ where: { id: contact.id }, data: { optedOut: true, state: Prisma.JsonNull } });
      await this.say(contact, [{ kind: 'text', text: 'Okay — we will not message you again unless you write to us. Send "hi" whenever you want to make something.' }]);
      return 'opted_out';
    }
    if (inbound.kind === 'text' && MENU_WORDS.has(text)) { await this.menu(contact, true); return 'handled'; }
    if (inbound.kind === 'choice' && inbound.id === 'menu') { await this.menu(contact); return 'handled'; }

    const state = (contact.state as BotState | null) ?? { flow: 'idle' };
    // A photo restarts the photo flow whatever was going on: it is the most common thing a seller sends.
    if (inbound.kind === 'image') { await this.photoReceived(contact, inbound); return 'handled'; }
    if (inbound.kind === 'choice' && inbound.id.startsWith('unlock:')) { await this.unlock(contact, inbound.id.slice(7)); return 'handled'; }
    if (inbound.kind === 'choice' && inbound.id.startsWith('buy:')) { await this.buy(contact, inbound.id.slice(4)); return 'handled'; }
    if (inbound.kind === 'choice' && inbound.id === 'credits') { await this.credits(contact); return 'handled'; }

    switch (state.flow) {
      case 'photo': await this.photoFlow(contact, state, inbound); break;
      case 'song': await this.songFlow(contact, state, inbound); break;
      case 'voice': await this.voiceFlow(contact, state, inbound); break;
      case 'copy': await this.copyFlow(contact, state, inbound); break;
      default: await this.idle(contact, state, inbound);
    }
    return 'handled';
  }

  private async idle(contact: WhatsappContact, state: BotState, inbound: Inbound): Promise<void> {
    if (inbound.kind === 'choice') {
      switch (inbound.id) {
        case 'flow:photo': await this.say(contact, [{ kind: 'text', text: 'Send me a product photo — a plain phone photo is fine. Then I will ask what to do with it.' }]); return;
        case 'flow:song': await this.startSong(contact); return;
        case 'flow:voice': await this.setState(contact, { flow: 'voice', step: 'script', sourceKey: state.sourceKey }); await this.say(contact, [{ kind: 'text', text: 'Type the script and I will record it. About 150 words is a minute.' }]); return;
        case 'flow:copy': await this.setState(contact, { flow: 'copy', step: 'details', sourceKey: state.sourceKey }); await this.say(contact, [{ kind: 'text', text: 'What is the product? Put the name on the first line, then the price and anything a buyer should know.\n\ne.g.\nAnkara tote bag\n₦12,000, handmade in Lagos, fits a laptop' }]); return;
        default: break;
      }
    }
    if (inbound.kind === 'text' && inbound.text.length > 2 && state.sourceKey) {
      // Words after a photo: treat them as the scene.
      await this.requestScene(contact, state.sourceKey, inbound.text);
      return;
    }
    await this.menu(contact, true);
  }

  // ---------------------------------------------------------------- flows

  private async menu(contact: WhatsappContact, greet = false): Promise<void> {
    await this.setState(contact, { flow: 'idle', sourceKey: (contact.state as BotState | null)?.sourceKey });
    const balance = await this.balance(contact);
    const hello = greet ? `${contact.name ? `Hi ${contact.name.split(' ')[0]}. ` : 'Hi. '}` : '';
    await this.say(contact, [{
      kind: 'list', header: 'AnyStudio', button: 'Choose',
      text: `${hello}What shall we make? You have ${balance} credits.\n\nSend a product photo at any time and I will turn it into a post.`,
      sections: [{ rows: [
        { id: 'flow:photo', title: 'Product photo', description: 'A branded post from a photo · 10 cr' },
        { id: 'flow:song', title: 'A song', description: 'Any genre, preview first · 10 cr' },
        { id: 'flow:voice', title: 'A voiceover', description: 'Your script, read aloud · 8 cr' },
        { id: 'flow:copy', title: 'Caption & description', description: 'Words for your listing · 2 cr' },
        { id: 'credits', title: 'Credits', description: `${balance} left · buy more` },
      ] }],
    }]);
  }

  private async photoReceived(contact: WhatsappContact, inbound: Extract<Inbound, { kind: 'image' }>): Promise<void> {
    const { bytes, mime } = await this.client.download(inbound.mediaId);
    const asset = await this.media.ingest(contact.workspaceId!, contact.userId, bytes, mime, `whatsapp-${inbound.mediaId}.${mime.split('/')[1] ?? 'jpg'}`);
    await this.setState(contact, { flow: 'photo', step: 'choose', sourceKey: asset.key });
    if (inbound.caption && inbound.caption.length > 3) { await this.requestScene(contact, asset.key, inbound.caption); return; }
    await this.say(contact, [{
      kind: 'buttons', text: 'Got it. What shall I do with this one?', footer: 'Or just type where the product should be, e.g. "on a marble counter"',
      buttons: [{ id: 'photo:scene', title: 'New scene · 10 cr' }, { id: 'photo:cutout', title: 'Cut out · 2 cr' }, { id: 'photo:reel', title: 'Reel · 120 cr' }],
    }]);
  }

  private async photoFlow(contact: WhatsappContact, state: BotState, inbound: Inbound): Promise<void> {
    const sourceKey = state.sourceKey;
    if (!sourceKey) { await this.menu(contact); return; }
    if (inbound.kind === 'choice') {
      switch (inbound.id) {
        case 'photo:scene': await this.setState(contact, { ...state, step: 'scene' }); await this.say(contact, [{ kind: 'text', text: 'Where should the product be? One line is enough — "on a marble kitchen counter in soft morning light".' }]); return;
        case 'photo:cutout': await this.request(contact, 'BACKGROUND_REMOVE', { sourceKey, background: 'transparent' }, 'Cutting it out…'); return;
        case 'photo:reel': await this.setState(contact, { ...state, step: 'reel' }); await this.say(contact, [{ kind: 'buttons', text: 'A 5-second reel of this product costs 120 credits and takes a few minutes. Go ahead?', buttons: [{ id: 'photo:reel:yes', title: 'Yes, make it' }, { id: 'menu', title: 'No' }] }]); return;
        case 'photo:reel:yes': await this.request(contact, 'IMAGE_TO_VIDEO', { sourceKey, prompt: 'The camera slowly pushes in on the product as soft light sweeps across it', shots: 1, durationSec: 5, aspect: '9:16', format: 'reveal', audio: false }, 'Rendering your reel — this takes a few minutes.'); return;
        default: break;
      }
    }
    if (inbound.kind === 'text' && inbound.text.length > 2) { await this.requestScene(contact, sourceKey, inbound.text); return; }
    await this.say(contact, [{ kind: 'text', text: 'Tap one of the buttons above, or type where the product should be.' }]);
  }

  private async requestScene(contact: WhatsappContact, sourceKey: string, prompt: string): Promise<void> {
    await this.request(contact, 'IMAGE_EDIT', { sourceKey, prompt: prompt.slice(0, 600), preserveProduct: true, aspect: '1:1', sizes: ['feed_square', 'story'] }, 'Placing your product in the scene — about 20 seconds.');
  }

  private async startSong(contact: WhatsappContact): Promise<void> {
    const genres = await this.db.musicGenre.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], take: 9 });
    await this.setState(contact, { flow: 'song', step: 'genre', data: {} });
    await this.say(contact, [{
      kind: 'list', header: 'A song', button: 'Pick a genre', text: 'Which sound? Pick one, or choose "Another" and type it — we have 68 genres from Afrobeats to cumbia.',
      sections: [{ rows: [...genres.map((g) => ({ id: `genre:${g.key}`, title: g.name.slice(0, 24), description: g.region.slice(0, 72) })), { id: 'genre:other', title: 'Another genre', description: 'Type its name' }] }],
    }]);
  }

  private async songFlow(contact: WhatsappContact, state: BotState, inbound: Inbound): Promise<void> {
    const data = { ...(state.data ?? {}) } as { genre?: string; brief?: string };
    if (state.step === 'genre') {
      let key: string | null = null;
      if (inbound.kind === 'choice' && inbound.id.startsWith('genre:') && inbound.id !== 'genre:other') key = inbound.id.slice(6);
      else if (inbound.kind === 'text' || (inbound.kind === 'choice' && inbound.id === 'genre:other')) {
        if (inbound.kind === 'choice') { await this.say(contact, [{ kind: 'text', text: 'Type the genre — "highlife", "gospel", "k-pop", "cumbia"…' }]); return; }
        const q = inbound.text.toLowerCase();
        const found = await this.db.musicGenre.findFirst({ where: { active: true, OR: [{ key: q.replace(/\s+/g, '-') }, { name: { contains: q, mode: 'insensitive' } }] }, orderBy: { sort: 'asc' } });
        if (!found) { await this.say(contact, [{ kind: 'text', text: `I do not have "${inbound.text}" yet. Try another name, or say "menu".` }]); return; }
        key = found.key;
      }
      if (!key) { await this.say(contact, [{ kind: 'text', text: 'Pick a genre from the list, or type one.' }]); return; }
      await this.setState(contact, { ...state, step: 'brief', data: { ...data, genre: key } });
      await this.say(contact, [{ kind: 'text', text: 'What is the song about? A birthday, your shop, someone you love — a sentence or two.' }]);
      return;
    }
    if (state.step === 'brief') {
      if (inbound.kind !== 'text' || inbound.text.length < 3) { await this.say(contact, [{ kind: 'text', text: 'Tell me what the song is about, in a sentence or two.' }]); return; }
      await this.setState(contact, { ...state, step: 'vocal', data: { ...data, brief: inbound.text.slice(0, 2000) } });
      await this.say(contact, [{ kind: 'buttons', text: 'Who sings it?', buttons: [{ id: 'vocal:female', title: 'Female voice' }, { id: 'vocal:male', title: 'Male voice' }, { id: 'vocal:instrumental', title: 'No vocals' }] }]);
      return;
    }
    if (state.step === 'vocal') {
      const vocal = inbound.kind === 'choice' && inbound.id.startsWith('vocal:') ? inbound.id.slice(6) : inbound.kind === 'text' ? (/male|man|guy/i.test(inbound.text) && !/female/i.test(inbound.text) ? 'male' : /instrument|no vocal|beat/i.test(inbound.text) ? 'instrumental' : 'female') : null;
      if (!vocal || !data.genre || !data.brief) { await this.say(contact, [{ kind: 'text', text: 'Tap Female, Male or No vocals.' }]); return; }
      await this.request(contact, 'MUSIC', { brief: data.brief, genre: data.genre, vocal, language: 'en', durationSec: 120 }, 'Composing — a full song takes a minute or two. You will hear a 30-second preview first.');
      return;
    }
    await this.startSong(contact);
  }

  private async voiceFlow(contact: WhatsappContact, _state: BotState, inbound: Inbound): Promise<void> {
    if (inbound.kind !== 'text' || inbound.text.length < 3) { await this.say(contact, [{ kind: 'text', text: 'Type the script you want read.' }]); return; }
    const voice = await this.defaultVoice();
    await this.request(contact, 'VOICEOVER', { script: inbound.text.slice(0, 4000), language: 'en', voiceId: voice ?? undefined, style: 'natural', speed: 1 }, 'Recording…');
  }

  private async copyFlow(contact: WhatsappContact, state: BotState, inbound: Inbound): Promise<void> {
    if (inbound.kind !== 'text' || inbound.text.length < 2) { await this.say(contact, [{ kind: 'text', text: 'Type the product name on the first line, then the details.' }]); return; }
    const [first, ...rest] = inbound.text.split(/\r?\n/);
    const details = rest.join('\n').trim();
    const price = details.match(/[₦$€£]\s?[\d,.]+k?/i)?.[0];
    await this.request(contact, 'TEXT_GENERATE', { task: 'product_copy', productName: (first ?? '').slice(0, 120), details: details.slice(0, 800) || undefined, price, language: 'en', platforms: ['whatsapp_status', 'instagram'], ...(state.sourceKey ? { sourceKey: state.sourceKey } : {}) }, 'Writing your listing…');
  }

  // ---------------------------------------------------------------- money

  private async credits(contact: WhatsappContact): Promise<void> {
    const balance = await this.balance(contact);
    const packs = await this.db.creditPack.findMany({ where: { active: true }, orderBy: { sort: 'asc' }, take: 3 });
    const ws = await this.db.workspace.findUniqueOrThrow({ where: { id: contact.workspaceId! }, select: { currency: true } });
    // priceByMarket is in major units (₦5,000); the checkout converts to minor.
    const price = (p: { priceByMarket: unknown }) => { const by = p.priceByMarket as Record<string, number>; const v = by[ws.currency]; return v ? fmt(v * 100, ws.currency) : by.USD ? fmt(by.USD * 100, 'USD') : ''; };
    await this.say(contact, [{
      kind: 'buttons', text: `You have ${balance} credits. A branded post is 10, a song preview 10, a reel 120. Buy more:`,
      buttons: packs.map((p) => ({ id: `buy:${p.code}`, title: `${p.credits} cr · ${price(p)}`.slice(0, 20) })),
    }]);
  }

  private async buy(contact: WhatsappContact, code: string): Promise<void> {
    try {
      const r = await this.billing.checkout(this.actorFor(contact), contact.workspaceId!, { kind: 'pack', code }, fakeReq());
      await this.say(contact, [{ kind: 'text', preview: true, text: `${r.credits} credits for ${fmt(r.amountMinor, r.currency)}. Pay here and they land in your account as soon as the payment clears:\n\n${r.url}` }]);
    } catch (err) {
      logger.warn({ err, contactId: contact.id, code }, 'whatsapp: checkout failed');
      await this.say(contact, [{ kind: 'text', text: 'The payment page could not be opened just now. Nothing was charged — try again in a moment.' }]);
    }
  }

  private async unlock(contact: WhatsappContact, generationId: string): Promise<void> {
    try {
      const r = await this.audio.unlock(this.actorFor(contact), contact.workspaceId!, generationId, fakeReq());
      const full = r.generation.outputs.find((o) => o.role === 'audio' && o.url);
      if (!full?.url) { await this.say(contact, [{ kind: 'text', text: 'The full song is unlocked but I could not fetch it just now. Say "menu" and try again in a minute.' }]); return; }
      await this.say(contact, [{ kind: 'audio', url: full.url }, { kind: 'text', text: r.status === 'already_unlocked' ? 'Here is your full song again.' : `Unlocked. Here is the whole song — it is yours. ${await this.balance(contact)} credits left.` }], generationId);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) { await this.notEnough(contact, 'unlock the full song'); return; }
      logger.warn({ err, contactId: contact.id, generationId }, 'whatsapp: unlock failed');
      await this.say(contact, [{ kind: 'text', text: err instanceof AppError ? err.message : 'Could not unlock that just now. Try again in a moment.' }]);
    }
  }

  private async notEnough(contact: WhatsappContact, what: string): Promise<void> {
    const balance = await this.balance(contact);
    const packs = await this.db.creditPack.findMany({ where: { active: true }, orderBy: { sort: 'asc' }, take: 2 });
    await this.say(contact, [{ kind: 'buttons', text: `You have ${balance} credits — not enough to ${what}. Top up and I will carry on.`, buttons: [...packs.map((p) => ({ id: `buy:${p.code}`, title: `Buy ${p.credits} credits`.slice(0, 20) })), { id: 'menu', title: 'Not now' }] }]);
  }

  // ---------------------------------------------------------------- requests and results

  /** Ask the same service the studio asks, from this contact's workspace; tell them what is happening. */
  private async request(contact: WhatsappContact, capability: Parameters<GenerationService['request']>[0]['capability'], params: Record<string, unknown>, waiting: string): Promise<void> {
    try {
      const { generation, balance } = await this.generations.request({ workspaceId: contact.workspaceId!, requestedById: contact.userId!, capability, params, clientKey: `wa:${crypto.randomUUID()}`, channel: 'WHATSAPP' });
      await this.setState(contact, { flow: 'idle', sourceKey: (contact.state as BotState | null)?.sourceKey ?? (typeof params.sourceKey === 'string' ? params.sourceKey : undefined) });
      await this.say(contact, [{ kind: 'text', text: `${waiting} ${generation.credits} credits held; ${balance} left. If it fails they come straight back.` }], generation.id);
      logger.info({ contactId: contact.id, generationId: generation.id, capability }, 'whatsapp: generation requested');
    } catch (err) {
      if (err instanceof InsufficientCreditsError) { await this.notEnough(contact, 'make that'); return; }
      if (err instanceof AppError && err.status === 400) {
        const fields = Object.values((err.details ?? {}) as Record<string, string>).join(' ');
        await this.say(contact, [{ kind: 'text', text: `I could not start that: ${fields || err.message}` }]);
        return;
      }
      throw err;
    }
  }

  /** A generation finished. If a WhatsApp conversation is waiting on it, send the result there. */
  async deliver(row: Generation): Promise<void> {
    if (row.channel !== 'WHATSAPP' || row.kind === 'CHILD') return;
    const link = await this.db.whatsappMessage.findFirst({ where: { generationId: row.id, direction: 'OUT' }, include: { contact: true }, orderBy: { createdAt: 'asc' } });
    if (!link) { logger.warn({ generationId: row.id }, 'whatsapp: finished generation has no conversation to deliver to'); return; }
    const contact = link.contact;
    if (contact.optedOut) return;

    if (row.status === 'FAILED') {
      await this.say(contact, [{ kind: 'text', text: `${customerMessage(row) ?? 'That did not work.'} ${row.credits} credits are back in your account.` }, { kind: 'buttons', text: 'Try again?', buttons: [{ id: 'menu', title: 'Menu' }] }], row.id);
      return;
    }
    if (row.status !== 'SUCCEEDED') return;

    const outputs = (row.outputs as GenerationOutput[] | null) ?? [];
    const keys = outputs.map((o) => o.key).filter(Boolean);
    const urls = keys.length ? await this.media.readUrls(row.workspaceId, keys) : {};
    const balance = await this.balance(contact);
    const messages: Outbound[] = [];

    switch (row.capability) {
      case 'IMAGE_EDIT': case 'IMAGE_GENERATE': case 'BACKGROUND_REMOVE': case 'BACKGROUND_REPLACE': case 'UPSCALE': case 'RELIGHT': {
        const main = outputs.find((o) => o.role === 'image');
        const story = outputs.find((o) => o.role === 'variant' && o.size === 'story');
        if (main && urls[main.key]) messages.push(row.capability === 'BACKGROUND_REMOVE' ? { kind: 'document', url: urls[main.key]!, filename: 'cutout.png', caption: 'Your cut-out, on transparency.' } : { kind: 'image', url: urls[main.key]!, caption: 'Here it is. Long-press to save or forward.' });
        if (story && urls[story.key]) messages.push({ kind: 'image', url: urls[story.key]!, caption: 'And the 9:16 for your Status.' });
        messages.push({ kind: 'buttons', text: `${balance} credits left. Same photo again?`, buttons: [{ id: 'photo:scene', title: 'Another scene' }, { id: 'photo:reel', title: 'Make a reel' }, { id: 'flow:copy', title: 'Write a caption' }] });
        await this.setState(contact, { flow: 'photo', step: 'choose', sourceKey: (row.input as { sourceKey?: string }).sourceKey });
        break;
      }
      case 'IMAGE_TO_VIDEO': case 'VIDEO_STITCH': case 'DUB': case 'LIPSYNC': {
        const video = outputs.find((o) => o.role === 'video');
        if (video && urls[video.key]) messages.push({ kind: 'video', url: urls[video.key]!, caption: 'Your reel. Post it to Status straight from here.' });
        messages.push({ kind: 'text', text: `${balance} credits left. Say "menu" for more.` });
        break;
      }
      case 'MUSIC': {
        const preview = outputs.find((o) => o.role === 'preview');
        const text = outputs.find((o) => o.role === 'text')?.text as { title?: string | null } | undefined;
        const price = await this.audio.unlockPrice().catch(() => ({ credits: 30 }));
        if (preview && urls[preview.key]) messages.push({ kind: 'audio', url: urls[preview.key]! });
        messages.push({ kind: 'buttons', text: `${text?.title ? `"${text.title}" — ` : ''}that is the first 30 seconds. Like it? Unlock the whole song for ${price.credits} credits and it is yours to keep and share.`, buttons: [{ id: `unlock:${row.id}`, title: `Unlock · ${price.credits} cr`.slice(0, 20) }, { id: 'flow:song', title: 'Another song' }, { id: 'menu', title: 'Menu' }] });
        break;
      }
      case 'VOICEOVER': {
        const audio = outputs.find((o) => o.role === 'audio');
        if (audio && urls[audio.key]) messages.push({ kind: 'audio', url: urls[audio.key]! });
        messages.push({ kind: 'text', text: `Your voiceover. ${balance} credits left.` });
        break;
      }
      case 'TEXT_GENERATE': {
        const t = outputs.find((o) => o.role === 'text')?.text as { description?: { short?: string; long?: string }; captions?: Record<string, string>; hashtags?: { broad?: string[]; local?: string[] } } | undefined;
        const caption = t?.captions?.whatsapp_status ?? t?.captions?.instagram;
        const tags = [...(t?.hashtags?.broad ?? []), ...(t?.hashtags?.local ?? [])].slice(0, 6).join(' ');
        if (caption) messages.push({ kind: 'text', text: `For your Status:\n\n${caption}${tags ? `\n\n${tags}` : ''}` });
        if (t?.description?.long) messages.push({ kind: 'text', text: `Description for your listing:\n\n${t.description.long}` });
        if (messages.length === 0) messages.push({ kind: 'text', text: 'Written — but I could not read it back. Open the studio on the web to see it.' });
        messages.push({ kind: 'text', text: `Copy and paste wherever you sell. ${balance} credits left.` });
        break;
      }
      default:
        messages.push({ kind: 'text', text: `Done. ${balance} credits left. Open the studio on the web to see it.` });
    }
    await this.say(contact, messages, row.id);
    logger.info({ contactId: contact.id, generationId: row.id, capability: row.capability, messages: messages.length }, 'whatsapp: result delivered');
  }

  // ---------------------------------------------------------------- contacts

  /** The contact for a number; a new number becomes a user with a workspace and welcome credits. */
  async contactFor(waId: string, name: string | null): Promise<WhatsappContact> {
    const existing = await this.db.whatsappContact.findUnique({ where: { waId } });
    if (existing?.workspaceId && existing.userId) {
      if (name && name !== existing.name) return this.db.whatsappContact.update({ where: { id: existing.id }, data: { name } });
      return existing;
    }
    const phone = `+${waId}`;
    const result = await this.db.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { phone } });
      let workspaceId: string | null = null;
      if (user) {
        // A web customer writing from the phone on their account: their own workspace, no second grant.
        const member = await tx.workspaceMember.findFirst({ where: { userId: user.id, role: 'OWNER', workspace: { deletedAt: null } }, orderBy: { createdAt: 'asc' } });
        workspaceId = member?.workspaceId ?? null;
        if (!user.phoneVerifiedAt) await tx.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: new Date(), phoneIsWhatsApp: true } });
      } else {
        user = await tx.user.create({ data: { phone, phoneVerifiedAt: new Date(), phoneIsWhatsApp: true, name: name?.slice(0, 80) ?? null, identities: { create: { provider: 'WHATSAPP', providerUid: waId } } } });
      }
      if (!workspaceId) {
        const ws = await tx.workspace.create({ data: { type: 'PERSONAL', name: `${name?.split(' ')[0] ?? 'My'}'s studio`, members: { create: { userId: user.id, role: 'OWNER' } }, wallet: { create: {} } }, include: { wallet: { select: { id: true } } } });
        workspaceId = ws.id;
        if (ws.wallet) await this.ledger.grant({ walletId: ws.wallet.id, amount: SIGNUP_PROMO_CREDITS, idempotencyKey: signupGrantKey(ws.id), reason: 'Welcome credits' }, tx);
        await tx.authEvent.create({ data: { userId: user.id, type: 'SIGNED_UP', surface: 'APP', requestId: 'whatsapp' } });
      }
      const contact = existing
        ? await tx.whatsappContact.update({ where: { id: existing.id }, data: { userId: user.id, workspaceId, name: name ?? existing.name } })
        : await tx.whatsappContact.create({ data: { waId, userId: user.id, workspaceId, name } });
      return { contact, created: !existing };
    });
    authLog('whatsapp.onboard', 'succeeded', { userId: result.contact.userId ?? undefined, workspaceId: result.contact.workspaceId ?? undefined, created: result.created, phone: mask(waId) });
    return result.contact;
  }

  private actorFor(contact: WhatsappContact): Actor {
    return { userId: contact.userId!, surface: 'APP', staffRole: null, workspaceRoles: new Map([[contact.workspaceId!, 'OWNER']]), mfaLevel: 0, lastStepUpAt: null, impersonating: false };
  }

  private async balance(contact: WhatsappContact): Promise<number> {
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId: contact.workspaceId! }, select: { id: true } });
    return wallet ? this.ledger.balance(wallet.id) : 0;
  }

  private async defaultVoice(): Promise<string | null> {
    const voices = await this.db.voiceProfile.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    const usable = voices.filter((v) => this.registry.get(v.providerKey));
    return (usable.find((v) => v.language === 'en-NG') ?? usable[0])?.key ?? null;
  }

  private async setState(contact: WhatsappContact, state: BotState): Promise<void> {
    contact.state = state as unknown as Prisma.JsonValue;
    await this.db.whatsappContact.update({ where: { id: contact.id }, data: { state: state as unknown as Prisma.InputJsonObject } });
  }

  /** Send in order, record each as an OUT message (the generation link is how results find their way back). */
  private async say(contact: WhatsappContact, messages: Outbound[], generationId?: string): Promise<void> {
    for (const m of messages) {
      const r = await this.client.send(contact.waId, m);
      await this.db.whatsappMessage.create({ data: { contactId: contact.id, waMessageId: r.messageId, direction: 'OUT', type: m.kind, body: { ...m, ...(m.kind === 'image' || m.kind === 'video' || m.kind === 'audio' || m.kind === 'document' ? { url: '[signed url]' } : {}) } as unknown as Prisma.InputJsonObject, generationId: generationId ?? null } });
    }
    await this.db.whatsappContact.update({ where: { id: contact.id }, data: { lastOutboundAt: new Date() } });
  }

  private allow(waId: string): boolean {
    const now = Date.now();
    const list = (this.recent.get(waId) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    this.recent.set(waId, list);
    if (this.recent.size > 5000) this.recent.clear();
    return list.length <= INBOUND_PER_MINUTE;
  }
}

function fmt(minor: number, currency: string): string {
  const symbol = ({ NGN: '₦', USD: '$', GBP: '£', KES: 'KSh ', GHS: 'GH₵', ZAR: 'R' } as Record<string, string>)[currency] ?? `${currency} `;
  return `${symbol}${(minor / 100).toLocaleString('en', { maximumFractionDigits: 0 })}`;
}

/** Services that log with a request get one that says where this came from. */
function fakeReq() {
  return { ip: undefined, requestId: 'whatsapp', get: () => undefined } as never;
}
