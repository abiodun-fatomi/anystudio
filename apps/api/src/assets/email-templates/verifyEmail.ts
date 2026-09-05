import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

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
    html: render({
      preheader: 'A fresh link to confirm your email. It works for 24 hours.',
      eyebrow: 'Your account',
      title: 'Confirm your email',
      paragraphs: [esc(greet(name)), 'Here is a fresh link to confirm your email address.'],
      action: { label: 'Confirm my email', url: link },
      note: 'It works for 24 hours, and any older link has stopped working.',
    }),
  };
}
