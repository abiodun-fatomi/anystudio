import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, greet, html } from './_layout';

/** The account is scheduled to go. The date is the whole message. */
export function deletionScheduled(to: string, name: string | null, deleteOn: Date, cancelUrl: string): Mail {
  const date = deleteOn.toISOString().slice(0, 10);
  return {
    to,
    subject: 'Your AnyStudio account will be deleted on ' + date,
    text: [greet(name), '',
      `You asked us to delete your AnyStudio account. Your photos, videos, copy and credits will be gone on ${date}.`,
      'Changed your mind? Sign in before then and press "Keep my account":', cancelUrl, '',
      "If you didn't ask for this, sign in now, cancel it, and change your password.",
      '', SIGNATURE].join('\n'),
    html: html([greet(name),
      `You asked us to delete your AnyStudio account. Your photos, videos, copy and credits will be gone on <strong>${date}</strong>.`,
      'Changed your mind? Sign in before then and press "Keep my account".',
      "If you didn't ask for this, sign in now, cancel it, and change your password."],
      { label: 'Keep my account', url: cancelUrl }),
  };
}
