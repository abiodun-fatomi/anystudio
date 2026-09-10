import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

export interface TranscriptLine {
  role: 'USER' | 'ASSISTANT' | 'STAFF' | 'SYSTEM';
  text: string;
  at: Date;
  who?: string | null;
}

const LABEL: Record<TranscriptLine['role'], string> = { USER: 'You', ASSISTANT: 'AnyStudio assistant', STAFF: 'AnyStudio team', SYSTEM: '' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function stamp(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * A copy of a help chat, sent when it is closed. Every line, in order, with
 * who said it — so the person has what was promised in writing, and so a
 * follow-up can quote it. Plain text first; the HTML mirrors it as chat
 * bubbles inside the shared shell.
 */
export function supportTranscript(
  to: string,
  name: string | null,
  opts: { topic: string | null; lines: TranscriptLine[]; openedAt: Date; closedAt: Date; needsHuman: boolean },
): Mail {
  const subject = `Your AnyStudio help chat${opts.topic ? `: ${opts.topic}` : ''}`;
  const intro = opts.needsHuman
    ? 'Here is a copy of your chat with us. A member of the team has it too and will follow up by email if anything is still open.'
    : 'Here is a copy of your chat with us, for your records. Reply to this email if anything is still unclear.';
  const lines = opts.lines.filter((l) => l.role !== 'SYSTEM');

  const text = [
    greet(name),
    '',
    intro,
    '',
    `Opened ${stamp(opts.openedAt)} · closed ${stamp(opts.closedAt)}`,
    '',
    ...lines.map((l) => `${l.role === 'STAFF' && l.who ? `${l.who} (AnyStudio team)` : LABEL[l.role]} — ${stamp(l.at)}\n${l.text}\n`),
    SIGNATURE,
  ].join('\n');

  const bubbles = lines
    .map((l) => {
      const mine = l.role === 'USER';
      const who = l.role === 'STAFF' && l.who ? `${esc(l.who)} · AnyStudio team` : LABEL[l.role];
      const bubble = mine
        ? `background:#D6006E;color:#FFFFFF;border-radius:14px 14px 4px 14px;`
        : l.role === 'STAFF'
          ? `background:#DFF3F5;color:#17131A;border-radius:14px 14px 14px 4px;`
          : `background:#F8F5FA;color:#17131A;border:1px solid #E7E2EB;border-radius:14px 14px 14px 4px;`;
      return (
        `<tr><td align="${mine ? 'right' : 'left'}" style="padding:0 0 12px;">` +
        `<div style="font-family:${FONT};font-size:11px;color:#6E6575;padding:0 4px 4px;">${who} · ${stamp(l.at)}</div>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${mine ? 'right' : 'left'}" style="max-width:86%;"><tr>` +
        `<td style="padding:10px 14px;font-family:${FONT};font-size:15px;line-height:1.5;white-space:pre-wrap;word-break:break-word;${bubble}">${esc(l.text)}</td>` +
        `</tr></table></td></tr>`
      );
    })
    .join('');

  const html = render({
    preheader: intro,
    eyebrow: 'Help',
    tone: 'default',
    title: opts.topic ? `Your chat about ${esc(opts.topic)}` : 'Your help chat',
    paragraphs: [esc(greet(name)), esc(intro)],
    panel: [
      { label: 'Opened', value: esc(stamp(opts.openedAt)) },
      { label: 'Closed', value: esc(stamp(opts.closedAt)) },
    ],
    extra:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E7E2EB;border-radius:12px;border-collapse:separate;">` +
      `<tr><td style="padding:16px 14px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bubbles}</table></td></tr></table>`,
    note: 'Still stuck? Open the help chat in the app any time — the assistant answers in seconds and the team steps in when it matters.',
  });

  return { to, subject, text, html };
}
