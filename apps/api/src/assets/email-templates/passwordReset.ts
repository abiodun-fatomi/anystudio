import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

/**
 * Password reset. The wording matters: someone who did NOT request this needs
 * to know, in the first screenful, that they do not have to do anything.
 */
export function passwordReset(to: string, name: string | null, link: string): Mail {
  return {
    to,
    subject: 'Reset your AnyStudio password',
    text: [
      greet(name),
      '',
      'Someone asked to reset the password on your AnyStudio account. If that was you, open this link within 30 minutes:',
      link,
      '',
      "If it wasn't you, ignore this — your password has not changed and nobody can use this link without your inbox.",
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: 'Choose a new password. The link works for 30 minutes.',
      eyebrow: 'Security',
      title: 'Reset your password',
      paragraphs: [esc(greet(name)), 'Someone asked to reset the password on your AnyStudio account. If that was you, choose a new one below.'],
      action: { label: 'Choose a new password', url: link },
      note: "The link works for 30 minutes. If it wasn't you, ignore this email — your password has not changed, and nobody can use the link without access to your inbox.",
    }),
  };
}
