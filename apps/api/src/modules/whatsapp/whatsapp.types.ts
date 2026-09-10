/**
 * The shapes on the wire with Meta's WhatsApp Cloud API, reduced to what
 * the bot reads and sends. Field names are Meta's (snake_case); everything
 * else in the module speaks our own.
 */

/** What Meta POSTs to the webhook. One envelope can carry many messages. */
export interface WebhookEnvelope {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: InboundMessage[];
        statuses?: Array<{ id?: string; status?: string; recipient_id?: string; errors?: Array<{ code?: number; title?: string }> }>;
      };
    }>;
  }>;
}

export interface InboundMessage {
  id: string;
  from: string;
  timestamp?: string;
  type:
    'text' | 'image' | 'audio' | 'video' | 'document' | 'interactive' | 'button' | 'sticker' | 'location' | 'contacts' | 'reaction' | 'unsupported' | string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string; sha256?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  video?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  interactive?: {
    type?: 'button_reply' | 'list_reply';
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  button?: { payload?: string; text?: string };
  context?: { id?: string; from?: string };
}

/** What the bot wants to send, in our words; the client translates. */
export type Outbound =
  | { kind: 'text'; text: string; preview?: boolean }
  | { kind: 'buttons'; text: string; buttons: Array<{ id: string; title: string }>; header?: string; footer?: string }
  | {
      kind: 'list';
      text: string;
      button: string;
      sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>;
      header?: string;
      footer?: string;
    }
  | { kind: 'image'; url: string; caption?: string }
  | { kind: 'video'; url: string; caption?: string }
  | { kind: 'audio'; url: string }
  | { kind: 'document'; url: string; filename: string; caption?: string };

/** What the bot understood from an inbound message. */
export type Inbound =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; id: string; title: string }
  | { kind: 'image'; mediaId: string; mime: string; caption?: string }
  | { kind: 'audio'; mediaId: string; mime: string }
  | { kind: 'video'; mediaId: string; mime: string; caption?: string }
  | { kind: 'other'; type: string };

export function normaliseInbound(m: InboundMessage): Inbound {
  switch (m.type) {
    case 'text':
      return { kind: 'text', text: (m.text?.body ?? '').trim() };
    case 'interactive': {
      const r = m.interactive?.type === 'list_reply' ? m.interactive.list_reply : m.interactive?.button_reply;
      return { kind: 'choice', id: r?.id ?? '', title: r?.title ?? '' };
    }
    case 'button':
      return { kind: 'choice', id: m.button?.payload ?? '', title: m.button?.text ?? '' };
    case 'image':
      return { kind: 'image', mediaId: m.image?.id ?? '', mime: m.image?.mime_type ?? 'image/jpeg', caption: m.image?.caption?.trim() || undefined };
    case 'audio':
      return { kind: 'audio', mediaId: m.audio?.id ?? '', mime: m.audio?.mime_type?.split(';')[0] ?? 'audio/ogg' };
    case 'video':
      return {
        kind: 'video',
        mediaId: m.video?.id ?? '',
        mime: m.video?.mime_type?.split(';')[0] ?? 'video/mp4',
        caption: m.video?.caption?.trim() || undefined,
      };
    case 'document': {
      const mime = m.document?.mime_type ?? '';
      if (mime.startsWith('image/')) return { kind: 'image', mediaId: m.document?.id ?? '', mime, caption: m.document?.caption?.trim() || undefined };
      return { kind: 'other', type: 'document' };
    }
    default:
      return { kind: 'other', type: m.type };
  }
}
