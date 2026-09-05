/**
 * The WhatsApp Cloud API, as far as the bot needs it: send a message of
 * each kind, mark one read, download the media a customer sent.
 *
 *   POST https://graph.facebook.com/{v}/{phone_number_id}/messages
 *   GET  https://graph.facebook.com/{v}/{media_id}            → { url, mime_type }
 *   GET  {url}  (bearer)                                       → bytes
 *
 * Media is sent BY LINK — a signed R2 URL Meta fetches — so the worker
 * never uploads output bytes twice. Without credentials the client logs
 * what it would have sent, so the bot can be exercised end to end in
 * development and in tests without Meta in the loop.
 *
 * Every send is logged with the recipient and kind, never the text: a
 * seller's product brief is their business.
 */
import { Injectable } from '@nestjs/common';
import { logger } from '../../../config/logger';
import type { Outbound } from './whatsapp.types';

const GRAPH = 'https://graph.facebook.com';

export interface SendResult {
  messageId: string | null;
  ok: boolean;
  error?: string;
}

@Injectable()
export class WhatsappClient {
  private localSeq = 0;
  readonly configured: boolean;
  private readonly version = process.env.WHATSAPP_API_VERSION ?? 'v21.0';
  private readonly phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  private readonly token = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  /** What the null client "sent"; read by tests. */
  readonly sent: Array<{ to: string; message: Outbound }> = [];

  constructor() {
    this.configured = Boolean(this.phoneNumberId && this.token);
    if (!this.configured)
      logger.warn('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set: the WhatsApp bot will log outbound messages instead of sending them');
  }

  async send(to: string, message: Outbound): Promise<SendResult> {
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...toMeta(message) };
    if (!this.configured) {
      this.sent.push({ to, message });
      if (this.sent.length > 500) this.sent.splice(0, this.sent.length - 500);
      logger.info({ to: mask(to), kind: message.kind }, 'whatsapp (not configured): would send');
      // Unique for the life of the process, whatever happens to the buffer:
      // the id is a unique column, and a test that clears `sent` between
      // cases must not hand out `local-1` twice.
      return { messageId: `local-${++this.localSeq}`, ok: true };
    }
    const res = await this.graph(`${this.phoneNumberId}/messages`, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ to: mask(to), kind: message.kind, status: res.status, err: text.slice(0, 300) }, 'whatsapp send failed');
      return { messageId: null, ok: false, error: `HTTP ${res.status}` };
    }
    const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> };
    const id = json.messages?.[0]?.id ?? null;
    logger.info({ to: mask(to), kind: message.kind, messageId: id }, 'whatsapp sent');
    return { messageId: id, ok: true };
  }

  async markRead(messageId: string): Promise<void> {
    if (!this.configured) return;
    await this.graph(`${this.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    }).catch(() => undefined);
  }

  /** The bytes of a media id, with the mime Meta reports. */
  async download(mediaId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    if (!this.configured) throw new Error('whatsapp not configured');
    const meta = await this.graph(mediaId, { method: 'GET' });
    if (!meta.ok) throw new Error(`media lookup failed: HTTP ${meta.status}`);
    const { url, mime_type: mime } = (await meta.json()) as { url?: string; mime_type?: string };
    if (!url) throw new Error('media lookup returned no url');
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mime: (mime ?? res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim(),
    };
  }

  private graph(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${GRAPH}/${this.version}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
  }
}

/** Our message → Meta's body. Buttons are capped at three and lists at ten rows by the platform. */
export function toMeta(m: Outbound): Record<string, unknown> {
  switch (m.kind) {
    case 'text':
      return { type: 'text', text: { body: m.text.slice(0, 4096), preview_url: Boolean(m.preview) } };
    case 'buttons':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(m.header ? { header: { type: 'text', text: m.header.slice(0, 60) } } : {}),
          body: { text: m.text.slice(0, 1024) },
          ...(m.footer ? { footer: { text: m.footer.slice(0, 60) } } : {}),
          action: { buttons: m.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) },
        },
      };
    case 'list':
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(m.header ? { header: { type: 'text', text: m.header.slice(0, 60) } } : {}),
          body: { text: m.text.slice(0, 1024) },
          ...(m.footer ? { footer: { text: m.footer.slice(0, 60) } } : {}),
          action: {
            button: m.button.slice(0, 20),
            sections: m.sections.map((s) => ({
              ...(s.title ? { title: s.title.slice(0, 24) } : {}),
              rows: s.rows
                .slice(0, 10)
                .map((r) => ({ id: r.id.slice(0, 200), title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) })),
            })),
          },
        },
      };
    case 'image':
      return { type: 'image', image: { link: m.url, ...(m.caption ? { caption: m.caption.slice(0, 1024) } : {}) } };
    case 'video':
      return { type: 'video', video: { link: m.url, ...(m.caption ? { caption: m.caption.slice(0, 1024) } : {}) } };
    case 'audio':
      return { type: 'audio', audio: { link: m.url } };
    case 'document':
      return { type: 'document', document: { link: m.url, filename: m.filename, ...(m.caption ? { caption: m.caption.slice(0, 1024) } : {}) } };
  }
}

export function mask(waId: string): string {
  return waId.length > 6 ? `${waId.slice(0, 3)}…${waId.slice(-3)}` : '…';
}
