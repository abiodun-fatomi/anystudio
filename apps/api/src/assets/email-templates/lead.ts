/** Platform leads: the contact form was received, echoed back so they have a record to reply to. */
import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, render } from './_layout';

export interface LeadMailFacts {
  organization: string;
  role: string | null;
  volume: string | null;
  timeline: string | null;
  notes: string | null;
}

export function leadReceived(to: string, f: LeadMailFacts): Mail {
  const dash = (s: string | null) => s ?? '—';
  return {
    to,
    subject: `AnyStudio — we have your message from ${f.organization}`,
    text: [
      'Hi,',
      '',
      `Thank you for writing about ${f.organization}. A person reads this, not a queue, and you will hear back within one working day in your timezone. If anything below should change, reply to this email.`,
      '',
      `Organization: ${f.organization}`,
      `Your role: ${dash(f.role)}`,
      `Images and reels per month: ${dash(f.volume)}`,
      `When you want to be live: ${dash(f.timeline)}`,
      `Anything that would stop this working: ${dash(f.notes)}`,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: 'A person reads this, and replies within one working day.',
      eyebrow: 'For platforms',
      title: 'Thank you — we have it',
      paragraphs: [
        'Hi,',
        `Thank you for writing about <strong>${esc(f.organization)}</strong>. A person reads this, not a queue, and you will hear back within one working day in your timezone. If anything below should change, reply to this email.`,
      ],
      panel: [
        { label: 'Organization', value: esc(f.organization) },
        { label: 'Your role', value: esc(dash(f.role)) },
        { label: 'Per month', value: esc(dash(f.volume)) },
        { label: 'Live by', value: esc(dash(f.timeline)) },
        { label: 'Blockers', value: esc(dash(f.notes)).replace(/\n/g, '<br>') },
      ],
      reason: 'You are getting this because you filled in the contact form for platforms on anystudio.ai.',
    }),
  };
}
