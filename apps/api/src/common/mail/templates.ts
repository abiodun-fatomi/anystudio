/**
 * Transactional email copy, in one place.
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
import type { Mail } from './mailer';

const SIGNATURE = 'AnyStudio\nanystudio.ai';

/** First name if we have one, so the greeting is not "Hi ,". */
const greet = (name: string | null): string => (name ? `Hi ${name.trim().split(/\s+/)[0]},` : 'Hi,');

/** Minimal, table-free HTML. Clients that strip it fall back to the text part. */
function html(bodyLines: string[], action?: { label: string; url: string }): string {
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

/**
 * Signup: welcome and verify in one message.
 *
 * Two separate emails would be worse on both counts — the welcome would
 * arrive without anything to do, and a bare "confirm your email" reads like
 * a chore from a company you have not met yet.
 */
export function welcomeAndVerify(to: string, name: string | null, link: string): Mail {
  const lines = [
    greet(name),
    'Your AnyStudio account is ready, and you have <strong>three free generations</strong> waiting — no card.',
    'Confirm this address so we can reach you if you ever lose your password:',
  ];
  return {
    to,
    subject: 'Welcome to AnyStudio — confirm your email',
    text: [
      greet(name), '',
      'Your AnyStudio account is ready, and you have three free generations waiting — no card.',
      '', 'Confirm this address so we can reach you if you ever lose your password:',
      link, '',
      'The link works for 24 hours. If you did not sign up, ignore this email — the account cannot be used until someone confirms it.',
      '', SIGNATURE,
    ].join('\n'),
    html: html([...lines,
      'The link works for 24 hours. If you did not sign up, ignore this email — nobody can use the account until it is confirmed.'],
      { label: 'Confirm my email', url: link }),
  };
}

/** A second copy of the verification link, on request. */
export function verifyEmail(to: string, name: string | null, link: string): Mail {
  return {
    to,
    subject: 'Confirm your AnyStudio email',
    text: [greet(name), '', 'Here is a fresh link to confirm your email address:', link, '',
      'It works for 24 hours. Older links have stopped working.', '', SIGNATURE].join('\n'),
    html: html([greet(name), 'Here is a fresh link to confirm your email address.',
      'It works for 24 hours, and any older link has stopped working.'],
      { label: 'Confirm my email', url: link }),
  };
}

/**
 * Password reset. The wording matters: someone who did NOT request this needs
 * to know, in the first screenful, that they do not have to do anything.
 */
export function passwordReset(to: string, name: string | null, link: string): Mail {
  return {
    to,
    subject: 'Reset your AnyStudio password',
    text: [greet(name), '',
      'Someone asked to reset the password on your AnyStudio account. If that was you, open this link within 30 minutes:',
      link, '',
      "If it wasn't you, ignore this — your password has not changed and nobody can use this link without your inbox.",
      '', SIGNATURE].join('\n'),
    html: html([greet(name),
      'Someone asked to reset the password on your AnyStudio account. If that was you, the link below works for 30 minutes.',
      "If it wasn't you, ignore this email — your password has not changed, and nobody can use the link without access to your inbox."],
      { label: 'Choose a new password', url: link }),
  };
}
