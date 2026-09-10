import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

/** The account is scheduled to go. The date is the whole message. */
export function deletionScheduled(to: string, name: string | null, deleteOn: Date, cancelUrl: string): Mail {
  const date = deleteOn.toISOString().slice(0, 10);
  const pretty = deleteOn.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return {
    to,
    subject: 'Your AnyStudio account will be deleted on ' + date,
    text: [
      greet(name),
      '',
      `You asked us to delete your AnyStudio account. Your photos, videos, copy and credits will be gone on ${date}.`,
      'Changed your mind? Sign in before then and press "Keep my account":',
      cancelUrl,
      '',
      "If you didn't ask for this, sign in now, cancel it, and change your password.",
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: `Your account and everything in it will be deleted on ${pretty}. You can still change your mind.`,
      eyebrow: 'Your account',
      tone: 'danger',
      title: 'Your account is scheduled for deletion',
      paragraphs: [
        esc(greet(name)),
        'You asked us to delete your AnyStudio account. Until the date below, everything stays exactly as it is and you can change your mind with one tap.',
      ],
      panel: [
        { label: 'Deleted on', value: `<strong>${esc(pretty)}</strong>` },
        { label: 'What goes', value: 'Your photos, videos, copy, brand kit and any remaining credits' },
      ],
      action: { label: 'Keep my account', url: cancelUrl },
      note: "If you didn't ask for this, sign in now, keep the account, and change your password.",
    }),
  };
}
