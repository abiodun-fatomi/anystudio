import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

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
    html: render({
      preheader: `Confirm ${to} as the email on your AnyStudio account.`,
      eyebrow: 'Your account',
      title: 'Use this address for AnyStudio?',
      paragraphs: [esc(greet(name)), 'You asked to move your AnyStudio account to this address. Nothing changes until you confirm it here.'],
      panel: [{ label: 'New email', value: `<strong>${esc(to)}</strong>` }],
      action: { label: 'Yes, use this email', url: link },
      note: "The link works for 24 hours. If you didn't ask for this, ignore this email — nothing changes unless the link is opened.",
    }),
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
    html: render({
      preheader: `A request to change your email to ${newEmail}. If that was you, nothing to do.`,
      eyebrow: 'Security',
      tone: 'warn',
      title: 'Was this you?',
      paragraphs: [
        esc(greet(name)),
        'A request was made to change the email on your AnyStudio account. It only takes effect once the new address confirms it.',
      ],
      panel: [
        { label: 'From', value: esc(to) },
        { label: 'To', value: `<strong>${esc(newEmail)}</strong>` },
      ],
      action: { label: 'Open Security', url: securityUrl },
      note: "If that was you, there's nothing to do. If it wasn't, change your password and sign out everywhere from the Security screen — straight away.",
    }),
  };
}
