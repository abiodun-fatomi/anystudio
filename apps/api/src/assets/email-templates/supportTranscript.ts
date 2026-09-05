import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, greet } from './_layout';

export interface TranscriptLine { role: 'USER' | 'ASSISTANT' | 'STAFF' | 'SYSTEM'; text: string; at: Date; who?: string | null }

const LABEL: Record<TranscriptLine['role'], string> = { USER: 'You', ASSISTANT: 'AnyStudio assistant', STAFF: 'AnyStudio team', SYSTEM: '' };

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function stamp(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * A copy of a help chat, sent when it is closed. Every line, in order, with
 * who said it — so the person has what was promised in writing, and so a
 * follow-up can quote it. Plain text first; the HTML mirrors it.
 */
export function supportTranscript(to: string, name: string | null, opts: { topic: string | null; lines: TranscriptLine[]; openedAt: Date; closedAt: Date; needsHuman: boolean }): Mail {
  const subject = `Your AnyStudio help chat${opts.topic ? `: ${opts.topic}` : ''}`;
  const intro = opts.needsHuman
    ? 'Here is a copy of your chat with us. A member of the team has it too and will follow up by email if anything is still open.'
    : 'Here is a copy of your chat with us, for your records. Reply to this email if anything is still unclear.';
  const lines = opts.lines.filter((l) => l.role !== 'SYSTEM');

  const text = [greet(name), '', intro, '',
    `Opened ${stamp(opts.openedAt)} · closed ${stamp(opts.closedAt)}`, '',
    ...lines.map((l) => `${l.role === 'STAFF' && l.who ? `${l.who} (AnyStudio team)` : LABEL[l.role]} — ${stamp(l.at)}\n${l.text}\n`),
    SIGNATURE].join('\n');

  const rows = lines.map((l) => {
    const mine = l.role === 'USER';
    const who = l.role === 'STAFF' && l.who ? `${esc(l.who)} · AnyStudio team` : LABEL[l.role];
    return `<div style="margin:0 0 14px;${mine ? 'text-align:right' : ''}">` +
      `<div style="font-size:12px;color:#6E6575;margin:0 0 4px">${who} · ${stamp(l.at)}</div>` +
      `<div style="display:inline-block;text-align:left;max-width:88%;padding:10px 14px;border-radius:12px;white-space:pre-wrap;` +
      `${mine ? 'background:#D6006E;color:#fff;border-bottom-right-radius:4px' : 'background:#F3EFF4;color:#17131A;border-bottom-left-radius:4px'}">${esc(l.text)}</div></div>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#17131A;max-width:560px">` +
    `<p style="margin:0 0 16px">${esc(greet(name))}</p><p style="margin:0 0 16px">${esc(intro)}</p>` +
    `<p style="margin:0 0 20px;color:#6E6575;font-size:13px">Opened ${stamp(opts.openedAt)} · closed ${stamp(opts.closedAt)}${opts.topic ? ` · ${esc(opts.topic)}` : ''}</p>` +
    `<div style="border:1px solid #E7E0E9;border-radius:12px;padding:16px">${rows}</div>` +
    `<p style="margin:28px 0 0;color:#6E6575;font-size:13px">AnyStudio · <a href="https://anystudio.ai" style="color:#6E6575">anystudio.ai</a></p></div>`;

  return { to, subject, text, html };
}
