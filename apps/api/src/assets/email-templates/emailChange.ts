import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, greet, html } from './_layout';

/**
 * Sent to the NEW address. Nothing changes until this link is opened — so a
 * typo in the new address costs a resend, not the account.
 */
export function emailChangeConfirm(to: string, name: string | null, link: string): Mail {
  return {
    to,
    subject: 'Confirm your new AnyStudio email',
    text: [
      greet(name),
      '',
      `You asked to move your AnyStudio account to ${to}. Open this link within 24 hours to make it so:`,
      link,
      '',
      "If you didn't ask for this, ignore it — nothing changes unless the link is opened.",
      '',
      SIGNATURE,
    ].join('\n'),
    html: html(
      [
        greet(name),
        `You asked to move your AnyStudio account to <strong>${to}</strong>. The link below works for 24 hours.`,
        "If you didn't ask for this, ignore this email — nothing changes unless the link is opened.",
      ],
      { label: 'Use this email', url: link },
    ),
  };
}

/**
 * Sent to the OLD address the moment a change is requested, before anything
 * has happened. This is the email that saves an account whose password
 * leaked: the owner still reads the old inbox, and "sign out everywhere" is
 * one tap from the link.
 */
export function emailChangeNotice(to: string, name: string | null, newEmail: string, securityUrl: string): Mail {
  return {
    to,
    subject: 'Someone asked to change the email on your AnyStudio account',
    text: [
      greet(name),
      '',
      `A request was made to change the email on your AnyStudio account from ${to} to ${newEmail}. It only takes effect once the new address confirms it.`,
      '',
      "If that was you, there's nothing to do here.",
      "If it wasn't, open Security, change your password and sign out everywhere:",
      securityUrl,
      '',
      SIGNATURE,
    ].join('\n'),
    html: html(
      [
        greet(name),
        `A request was made to change the email on your AnyStudio account from <strong>${to}</strong> to <strong>${newEmail}</strong>. It only takes effect once the new address confirms it.`,
        "If that was you, there's nothing to do.",
        "If it wasn't, change your password and sign out everywhere from the Security screen.",
      ],
      { label: 'Open Security', url: securityUrl },
    ),
  };
}
