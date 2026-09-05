/**
 * The help assistant behind the chat floater.
 *
 * Claude, answering as AnyStudio's support — it knows what the product does
 * and what it costs, points people at the right screen, and says plainly when
 * a question needs a person (a payment that did not land, a suspended
 * account, a refund). The answer is a forced tool call, so the flag that
 * escalates to staff is a boolean the model must set, never a phrase we
 * would have to grep for.
 *
 * No key, a timeout, or a vendor outage never breaks the chat: the person
 * gets an honest holding line, the conversation is flagged for a human, and
 * the failure is logged as one event with its cause.
 */
import { Injectable } from '@nestjs/common';
import { logger } from '../../../config/logger';

export interface AssistantTurn { role: 'user' | 'assistant'; text: string }

export interface AssistantAnswer {
  reply: string;
  /** The model could not resolve it, or the person asked for a human. */
  needsHuman: boolean;
  /** A few words naming the subject, set on the first turn and kept. */
  topic: string;
  meta: { model: string; usage?: unknown; fallback?: string };
}

export interface AssistantContext {
  userName: string | null;
  workspace: { name: string; type: string; balance: number | null } | null;
  page: string | null;
}

const MODEL_DEFAULT = 'claude-haiku-4-5';
const TIMEOUT_MS = 20_000;

/** What the assistant knows. Kept in one place so a price change is one edit. */
const PRODUCT = `
AnyStudio (anystudio.ai) is an AI content studio for sellers, brands and organizations. One product photo in; branded images, a written description, captions per platform, hashtags, and short video out — on the web app and on WhatsApp.

What it makes and what it costs, in credits (a failed generation always refunds itself):
- Product sheet / image edit (IMAGE_EDIT): 10. The product stays pixel-identical; the brand kit is applied. Sizes for Instagram, story, marketplace.
- Background remove: 2. Background replace: 10. Upscale: 3. Image from a prompt: 10.
- Text (description, captions, hashtags, alt text, SEO): 2.
- Image to video: reel 120; 15-second ad 260; 30-second ad 480.
- Voice-over: 8. Music: 10 for a 30-second preview, 30 more to unlock the full track.
- Dubbing into another language: 90, or 240 with lip-sync. Lip-sync to a script or audio: 150. Both require the person's consent tick.
- Credits are bought as packs (Credits page → Add credits) or come with a plan. New accounts get welcome credits. Payments: cards and bank via Flutterwave (Nigeria and Africa) and Paddle elsewhere. Payment history and the statement are on the Credits page.

Where things are in the app: Today (overview), Studio (make things), Library (everything made; download, share, publish), Brand (brand kit: logo, colours, fonts, tone), Publishing (connect Instagram/TikTok/Facebook; scheduled posts), Insights (what performed), Credits (balance, packs, plans, statement), Settings (profile, security incl. two-step verification, notifications, your data incl. export and account deletion, workspace members and invites), Developer (organizations only: projects, API keys, webhooks; docs at /developers).
WhatsApp: a business workspace links a WhatsApp number in Settings; send a photo to the AnyStudio number and the sheet comes back in chat.
Workspaces: Personal (one person), Business (a shop or brand, with a team), Organization (builds on the API). Create one from the workspace menu at the top-left.
Sign-in: email or phone + password, or Google. Two-step verification is in Settings → Security. Password reset is from the sign-in page.
Limits: images 25 MB, video 250 MB, audio 30 MB; dubs up to five minutes; lip-syncs up to three; twenty videos per workspace per day.
`;

const SYSTEM = `You are the help assistant inside AnyStudio's web app. Answer as AnyStudio's support: warm, brief, concrete. Use plain sentences, no headings, no bullet lists unless the person asks for steps; at most a short numbered list. Never invent features, prices or policies — if it is not in what you know, say you are not sure and set needsHuman. Point to the exact screen (e.g. "Credits → Add credits").

Set needsHuman to true when: the person asks for a human; money is involved and something went wrong (a payment taken but no credits, a refund, a double charge); an account is suspended or locked; a generation failed repeatedly; a bug or error message you cannot explain; anything about deleting data on their behalf; anything you cannot answer from what you know. When you set it, tell the person a member of the team will pick this up in this chat and by email, and that they can keep writing here.

Never ask for passwords, card numbers or codes. Do not promise timelines beyond "usually within a day". Do not discuss other customers. Keep replies under 120 words unless steps are needed.

${PRODUCT}`;

const TOOL = {
  name: 'answer',
  description: 'Your reply to the person, with the escalation flag and the topic.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'What to say to the person. Plain text.' },
      needsHuman: { type: 'boolean', description: 'True when a member of the team must look at this.' },
      topic: { type: 'string', description: 'Two to six words naming what the conversation is about, e.g. "credits not added after payment".' },
    },
    required: ['reply', 'needsHuman', 'topic'],
  },
} as const;

const HOLDING = "Thanks for writing. I can't reach the assistant right now, so I've flagged this for the team — someone will pick it up here and by email. Feel free to add anything that helps in the meantime.";

@Injectable()
export class SupportAssistant {
  private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  private readonly model = process.env.SUPPORT_MODEL ?? MODEL_DEFAULT;

  get configured(): boolean { return this.apiKey.length > 0; }

  async answer(history: AssistantTurn[], ctx: AssistantContext, conversationId: string): Promise<AssistantAnswer> {
    if (!this.configured) {
      logger.warn({ conversationId }, 'support assistant: ANTHROPIC_API_KEY not set; holding reply sent and conversation flagged for staff');
      return { reply: HOLDING, needsHuman: true, topic: 'needs a person', meta: { model: 'none', fallback: 'not_configured' } };
    }
    const started = Date.now();
    try {
      const body = {
        model: this.model,
        max_tokens: 700,
        temperature: 0.3,
        system: `${SYSTEM}\n\nAbout this person: ${describe(ctx)}`,
        // The vendor wants the person to speak first; when staff wrote before they did, say so.
        messages: (history[0]?.role === 'assistant' ? [{ role: 'user', text: '(The person opened the chat.)' }, ...history] : history).map((h) => ({ role: h.role, content: h.text })),
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
      };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));
      const json = (await res.json().catch(() => null)) as { content?: Array<{ type: string; input?: unknown }>; usage?: unknown; error?: { message?: string } } | null;
      if (!res.ok || !json) {
        logger.error({ conversationId, status: res.status, err: json?.error?.message, ms: Date.now() - started }, 'support assistant: vendor refused the request; holding reply sent');
        return { reply: HOLDING, needsHuman: true, topic: 'needs a person', meta: { model: this.model, fallback: `http_${res.status}` } };
      }
      const tool = json.content?.find((b) => b.type === 'tool_use');
      const input = (tool?.input ?? {}) as Partial<{ reply: string; needsHuman: boolean; topic: string }>;
      if (!input.reply) {
        logger.error({ conversationId, ms: Date.now() - started }, 'support assistant: no answer in the completion; holding reply sent');
        return { reply: HOLDING, needsHuman: true, topic: 'needs a person', meta: { model: this.model, fallback: 'empty' } };
      }
      logger.info({ conversationId, ms: Date.now() - started, needsHuman: input.needsHuman === true }, 'support assistant answered');
      return {
        reply: input.reply.trim(),
        needsHuman: input.needsHuman === true,
        topic: (input.topic ?? '').trim().slice(0, 80) || 'help',
        meta: { model: this.model, usage: json.usage },
      };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'AbortError';
      logger.error({ conversationId, err, ms: Date.now() - started }, timedOut ? 'support assistant: timed out; holding reply sent' : 'support assistant: request failed; holding reply sent');
      return { reply: HOLDING, needsHuman: true, topic: 'needs a person', meta: { model: this.model, fallback: timedOut ? 'timeout' : 'error' } };
    }
  }
}

function describe(ctx: AssistantContext): string {
  const bits: string[] = [];
  bits.push(ctx.userName ? `first name ${ctx.userName.split(/\s+/)[0]}` : 'name unknown');
  if (ctx.workspace) {
    bits.push(`in the ${ctx.workspace.type.toLowerCase()} workspace "${ctx.workspace.name}"`);
    if (ctx.workspace.balance !== null) bits.push(`with ${ctx.workspace.balance} credits`);
  }
  if (ctx.page) bits.push(`currently on the page ${ctx.page}`);
  return bits.join(', ') + '.';
}
