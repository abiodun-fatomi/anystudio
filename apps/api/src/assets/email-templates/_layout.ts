/**
 * Shared pieces for the transactional emails in this folder. One file per
 * email, so "what exactly did we send them?" is answered by opening one file.
 *
 * Every message is written plain-text first and the HTML mirrors it, because
 * a seller reading this on a 3G connection in a WhatsApp-first market may
 * never load the styled version — and because a text part is what keeps a
 * message out of the spam folder.
 *
 * Nothing here takes a template engine: four emails do not justify one, and
 * a string function is greppable when support asks "what exactly did we send
 * them?".
 */

export const SIGNATURE = 'AnyStudio\nanystudio.ai';

/** First name if we have one, so the greeting is not "Hi ,". */
export const greet = (name: string | null): string => (name ? `Hi ${name.trim().split(/\s+/)[0]},` : 'Hi,');

/** Minimal, table-free HTML. Clients that strip it fall back to the text part. */
export function html(bodyLines: string[], action?: { label: string; url: string }): string {
  const p = bodyLines.map((l) => `<p style="margin:0 0 16px">${l}</p>`).join('');
  const button = action
    ? `<p style="margin:26px 0"><a href="${action.url}" style="background:#D6006E;color:#fff;text-decoration:none;` +
      `padding:13px 22px;border-radius:4px;font-weight:600;display:inline-block">${action.label}</a></p>` +
      `<p style="margin:0 0 16px;color:#6E6575;font-size:13px">If the button does not work, paste this into your browser:<br>` +
      `<span style="word-break:break-all">${action.url}</span></p>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;` +
    `color:#17131A;max-width:520px">${p}${button}` +
    `<p style="margin:28px 0 0;color:#6E6575;font-size:13px">AnyStudio · <a href="https://anystudio.ai" style="color:#6E6575">anystudio.ai</a></p></div>`;
}
