/**
 * The wire layer without Meta: what an inbound message becomes, what an
 * outbound one is sent as, and the two checks at the door.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { normaliseInbound } from './whatsapp.types';
import { toMeta } from './whatsapp.client';
import { WhatsappService } from './whatsapp.service';

describe('inbound normalisation', () => {
  it('reads text, button and list replies, images (also as documents), and shrugs at the rest', () => {
    expect(normaliseInbound({ id: '1', from: '234', type: 'text', text: { body: '  hi  ' } })).toEqual({ kind: 'text', text: 'hi' });
    expect(normaliseInbound({ id: '2', from: '234', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'photo:scene', title: 'New scene' } } })).toEqual({ kind: 'choice', id: 'photo:scene', title: 'New scene' });
    expect(normaliseInbound({ id: '3', from: '234', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'genre:afrobeats', title: 'Afrobeats' } } })).toEqual({ kind: 'choice', id: 'genre:afrobeats', title: 'Afrobeats' });
    expect(normaliseInbound({ id: '4', from: '234', type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'on a beach' } })).toEqual({ kind: 'image', mediaId: 'm1', mime: 'image/jpeg', caption: 'on a beach' });
    expect(normaliseInbound({ id: '5', from: '234', type: 'document', document: { id: 'm2', mime_type: 'image/png' } })).toMatchObject({ kind: 'image', mediaId: 'm2', mime: 'image/png' });
    expect(normaliseInbound({ id: '6', from: '234', type: 'sticker' })).toEqual({ kind: 'other', type: 'sticker' });
  });
});

describe('outbound shapes', () => {
  it('caps buttons at three and titles at twenty characters, and sends media by link', () => {
    const b = toMeta({ kind: 'buttons', text: 'x', buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: 'a very long button title indeed' })) }) as { interactive: { action: { buttons: Array<{ reply: { title: string } }> } } };
    expect(b.interactive.action.buttons).toHaveLength(3);
    expect(b.interactive.action.buttons[0]!.reply.title).toHaveLength(20);
    expect(toMeta({ kind: 'audio', url: 'https://r2/x.mp3' })).toEqual({ type: 'audio', audio: { link: 'https://r2/x.mp3' } });
    expect(toMeta({ kind: 'text', text: 'hi', preview: true })).toEqual({ type: 'text', text: { body: 'hi', preview_url: true } });
    const l = toMeta({ kind: 'list', text: 'x', button: 'Choose', sections: [{ rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` })) }] }) as { interactive: { action: { sections: Array<{ rows: unknown[] }> } } };
    expect(l.interactive.action.sections[0]!.rows).toHaveLength(10);
  });
});

describe('the door', () => {
  const svc = new WhatsappService(null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never);
  const env = { ...process.env };
  beforeEach(() => { process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-me'; process.env.WHATSAPP_APP_SECRET = 'app-secret'; });
  afterEach(() => { process.env = { ...env }; });

  it('answers the handshake only with the right token, and checks the body signature with the app secret', () => {
    expect(svc.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' })).toBe('12345');
    expect(svc.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' })).toBeNull();
    const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(svc.signatureOk(body, sig)).toBe(true);
    expect(svc.signatureOk(Buffer.from('{}'), sig)).toBe(false);
    expect(svc.signatureOk(body, undefined)).toBe(false);
    delete process.env.WHATSAPP_APP_SECRET;
    expect(svc.signatureOk(body, sig)).toBe(false);
  });
});
