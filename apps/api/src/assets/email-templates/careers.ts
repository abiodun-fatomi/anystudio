/** Careers mails: the application was received. */
import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

export function applicationReceived(to: string, name: string | null, f: { title: string; team: string; url: string }): Mail {
  return {
    to,
    subject: `Your application for ${f.title} — received`,
    text: [
      greet(name),
      '',
      `Thank you for applying for ${f.title} (${f.team}) at AnyStudio. We read every application ourselves and reply within two weeks, either way.`,
      f.url,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: 'We read every application ourselves.',
      eyebrow: 'Careers',
      title: 'Thank you — we have it',
      paragraphs: [
        esc(greet(name)),
        `Your application for <strong>${esc(f.title)}</strong> on the ${esc(f.team)} team is in. We read every application ourselves and reply within two weeks, either way. If something in it should change, reply to this email.`,
      ],
      action: { label: 'The opening', url: f.url },
      reason: 'You are getting this because you applied for a role at AnyStudio.',
    }),
  };
}
