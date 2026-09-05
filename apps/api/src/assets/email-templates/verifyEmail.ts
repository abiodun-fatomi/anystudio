import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, greet, html } from './_layout';

/** A second copy of the verification link, on request. */
export function verifyEmail(to: string, name: string | null, link: string): Mail {
  return {
    to,
    subject: 'Confirm your AnyStudio email',
    text: [
      greet(name),
      '',
      'Here is a fresh link to confirm your email address:',
      link,
      '',
      'It works for 24 hours. Older links have stopped working.',
      '',
      SIGNATURE,
    ].join('\n'),
    html: html([greet(name), 'Here is a fresh link to confirm your email address.', 'It works for 24 hours, and any older link has stopped working.'], {
      label: 'Confirm my email',
      url: link,
    }),
  };
}
