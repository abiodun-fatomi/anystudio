/**
 * Shared pieces for the transactional emails in this folder. One file per
 * email, so "what exactly did we send them?" is answered by opening one file.
 *
 * Every message is written plain-text first and the HTML mirrors it, because
 * a seller reading this on a 3G connection in a WhatsApp-first market may
 * never load the styled version — and because a text part is what keeps a
 * message out of the spam folder.
 *
 * The HTML is one shell, `render()`, that every email fills in: a card on a
 * pale ground, the wordmark, an eyebrow naming the kind of email, a title,
 * the body, an optional panel of facts (what changed, when, from where), one
 * button, the same link in plain text for clients that refuse buttons, and a
 * footer. Tables and inline styles throughout — Gmail strips <style> from
 * some views and Outlook renders with Word — so what it looks like here is
 * what it looks like there. A hero image is optional and always has alt
 * text: most clients hide images until asked.
 *
 * Nothing here takes a template engine: nine emails do not justify one, and
 * a string function is greppable when support asks "what exactly did we send
 * them?".
 */

export const SIGNATURE = 'AnyStudio\nanystudio.ai';

/** First name if we have one, so the greeting is not "Hi ,". */
export const greet = (name: string | null): string => (name ? `Hi ${name.trim().split(/\s+/)[0]},` : 'Hi,');

/** HTML-escape a value that came from a person (a name, an address, a message). */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/**
 * Where the email images live: static files under apps/web/public/email,
 * served by the marketing host (https://<base>/email/…). Null when
 * MAIL_ASSET_BASE is unset — the templates then send no image rather than a
 * broken one, and every email still stands on its own without pictures.
 */
export const assetBase = (): string | null => process.env.MAIL_ASSET_BASE?.replace(/\/$/, '') || null;

// Palette: the app's light tokens, so an email and the screen it links to look like one product.
const C = {
  ground: '#F4F0F6',
  card: '#FFFFFF',
  line: '#E7E2EB',
  ink: '#17131A',
  inkSoft: '#3B3341',
  muted: '#6E6575',
  accent: '#D6006E',
  accentInk: '#FFFFFF',
  panel: '#F8F5FA',
  ok: '#0F7B4F',
  warn: '#8A5A00',
  danger: '#B3261E',
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

export type Tone = 'default' | 'ok' | 'warn' | 'danger';

export interface EmailSpec {
  /** Hidden first line that inboxes show beside the subject. */
  preheader?: string;
  /** Small caps label above the title: "Welcome", "Security", "Your team". */
  eyebrow: string;
  tone?: Tone;
  /** The one-line headline. */
  title: string;
  /** Optional image between header and title: an absolute URL and its alt text. */
  hero?: { src: string; alt: string; width?: number; height?: number };
  /** Paragraphs. Already-escaped HTML; may contain <strong>. */
  paragraphs: string[];
  /** Facts, in a quiet panel: label/value pairs. Values are HTML. */
  panel?: Array<{ label: string; value: string }>;
  /** The single call to action. */
  action?: { label: string; url: string };
  /** Small print under the button: "This link works for 24 hours." */
  note?: string;
  /** Extra HTML dropped in after the paragraphs (the transcript uses this). */
  extra?: string;
  /** Why they got it. Defaults to the account line. */
  reason?: string;
}

const TONE_COLOR: Record<Tone, string> = { default: C.accent, ok: C.ok, warn: C.warn, danger: C.danger };

/** A row of the facts panel. */
const panelRow = (label: string, value: string, last: boolean): string =>
  `<tr>` +
  `<td style="padding:10px 16px;font-family:${FONT};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};vertical-align:top;white-space:nowrap;${last ? '' : `border-bottom:1px solid ${C.line};`}">${label}</td>` +
  `<td style="padding:10px 16px 10px 8px;font-family:${FONT};font-size:15px;line-height:1.45;color:${C.ink};vertical-align:top;${last ? '' : `border-bottom:1px solid ${C.line};`}">${value}</td>` +
  `</tr>`;

/** A button that renders as a button everywhere, Outlook included (VML). */
function button(action: { label: string; url: string }): string {
  const href = esc(action.url);
  return (
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:260px;" arcsize="20%" fillcolor="${C.accent}" strokecolor="${C.accent}"><w:anchorlock/><center style="color:${C.accentInk};font-family:${FONT};font-size:16px;font-weight:700;">${esc(action.label)}</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-->` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.accent}" style="border-radius:10px;background:${C.accent};">` +
    `<a href="${href}" style="display:inline-block;padding:15px 30px;font-family:${FONT};font-size:16px;font-weight:700;line-height:20px;color:${C.accentInk};text-decoration:none;border-radius:10px;">${esc(action.label)}</a>` +
    `</td></tr></table>` +
    `<!--<![endif]-->`
  );
}

/** The whole document. */
export function render(spec: EmailSpec): string {
  const tone = TONE_COLOR[spec.tone ?? 'default'];
  const pre = spec.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.ground};opacity:0;">${esc(spec.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`
    : '';

  const hero = spec.hero
    ? `<tr><td style="padding:0 0 8px;">` +
      `<img src="${esc(spec.hero.src)}" alt="${esc(spec.hero.alt)}" width="${spec.hero.width ?? 528}" ${spec.hero.height ? `height="${spec.hero.height}"` : ''} ` +
      `style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:12px;outline:none;text-decoration:none;" />` +
      `</td></tr>`
    : '';

  const paragraphs = spec.paragraphs
    .map((p) => `<tr><td style="padding:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.inkSoft};">${p}</td></tr>`)
    .join('');

  const panel = spec.panel?.length
    ? `<tr><td style="padding:6px 0 20px;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;border-collapse:separate;">` +
      spec.panel.map((r, i, a) => panelRow(r.label, r.value, i === a.length - 1)).join('') +
      `</table></td></tr>`
    : '';

  const action = spec.action
    ? `<tr><td style="padding:10px 0 12px;">${button(spec.action)}</td></tr>` +
      `<tr><td style="padding:0 0 18px;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">` +
      `Button not working? Copy this link into your browser:<br>` +
      `<a href="${esc(spec.action.url)}" style="color:${C.muted};word-break:break-all;">${esc(spec.action.url)}</a>` +
      `</td></tr>`
    : '';

  const note = spec.note ? `<tr><td style="padding:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">${spec.note}</td></tr>` : '';
  const extra = spec.extra ? `<tr><td style="padding:0 0 12px;">${spec.extra}</td></tr>` : '';
  const reason = spec.reason ?? 'You are getting this because you have an AnyStudio account.';

  return (
    `<!DOCTYPE html>` +
    `<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">` +
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `<meta name="x-apple-disable-message-reformatting"><title>${esc(spec.title)}</title>` +
    `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${C.ground};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">` +
    pre +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.ground}" style="background:${C.ground};">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    // the card
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:18px;border-collapse:separate;overflow:hidden;">` +
    // top accent bar
    `<tr><td bgcolor="${tone}" style="height:6px;line-height:6px;font-size:6px;background:${tone};">&nbsp;</td></tr>` +
    // header: wordmark + eyebrow
    `<tr><td style="padding:26px 36px 0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="vertical-align:middle;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td bgcolor="${C.accent}" style="width:26px;height:26px;border-radius:7px;background:${C.accent};text-align:center;vertical-align:middle;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td bgcolor="#FFFFFF" style="width:10px;height:10px;border-radius:2px;background:#FFFFFF;font-size:0;line-height:0;">&nbsp;</td></tr></table>` +
    `</td>` +
    `<td style="padding-left:10px;font-family:${FONT};font-size:18px;font-weight:800;letter-spacing:-.02em;color:${C.ink};vertical-align:middle;">AnyStudio</td>` +
    `</tr></table>` +
    `</td>` +
    `<td align="right" style="vertical-align:middle;font-family:${MONO};font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${tone};">${esc(spec.eyebrow)}</td>` +
    `</tr></table>` +
    `</td></tr>` +
    // body
    `<tr><td style="padding:24px 36px 8px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    hero +
    `<tr><td style="padding:6px 0 14px;font-family:${FONT};font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-.02em;color:${C.ink};">${spec.title}</td></tr>` +
    paragraphs +
    panel +
    extra +
    action +
    note +
    `</table>` +
    `</td></tr>` +
    // card footer
    `<tr><td style="padding:18px 36px 26px;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">` +
    `Need a hand? Reply to this email or write to <a href="mailto:hello@anystudio.ai" style="color:${C.muted};">hello@anystudio.ai</a>.` +
    `</td></tr>` +
    `</table>` +
    // below the card
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">` +
    `<tr><td style="padding:18px 12px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};text-align:center;">` +
    `${esc(reason)}<br>` +
    `<a href="https://anystudio.ai" style="color:${C.muted};">anystudio.ai</a> &nbsp;·&nbsp; One photo in. Everything you post, out.` +
    `</td></tr>` +
    `</table>` +
    `</td></tr></table>` +
    `</body></html>`
  );
}
