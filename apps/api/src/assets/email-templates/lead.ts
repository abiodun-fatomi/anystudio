/**
 * Platform leads. Two emails: the sender's copy of what they wrote, and the
 * alert to the inbox that answers it — the whole form, laid out to be read
 * and replied to from a phone, with the reply one tap away.
 */
import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, render } from './_layout';
import { quoted } from './staffAlerts';

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

/**
 * The alert. The organization is the headline; the two numbers that decide
 * the size of the conversation (how much, how soon) sit right under it; the
 * facts are in the panel; the blocker they named is quoted as they wrote it;
 * and the button is the reply itself, addressed and with a subject, so
 * answering is one tap. The console link is there for the record.
 */
export function leadAlert(to: string, f: LeadMailFacts & { email: string; consoleUrl: string }): Mail {
  const dash = (s: string | null) => s ?? '—';
  const sizing = [f.volume && `${f.volume} a month`, f.timeline && `live ${f.timeline.toLowerCase()}`].filter(Boolean).join(' · ');
  const replyUrl = `mailto:${f.email}?subject=${encodeURIComponent(`AnyStudio — ${f.organization}`)}`;
  return {
    to,
    subject: `Platform lead: ${f.organization}${f.volume ? ` — ${f.volume}` : ''}`,
    text: [
      `${f.organization}${sizing ? ` — ${sizing}` : ''}`,
      '',
      `From: ${f.email}${f.role ? ` (${f.role})` : ''}`,
      `Images and reels per month: ${dash(f.volume)}`,
      `Wants to be live: ${dash(f.timeline)}`,
      '',
      'What would stop this working:',
      dash(f.notes),
      '',
      `Reply: ${f.email}`,
      `Console: ${f.consoleUrl}`,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: sizing || `${f.email} wrote in from the platforms page.`,
      eyebrow: 'Platform lead',
      title: esc(f.organization),
      paragraphs: [
        sizing
          ? `<strong>${esc(sizing)}</strong>. Wrote in from the platforms page; a person there is waiting to hear back within one working day.`
          : 'Wrote in from the platforms page; a person there is waiting to hear back within one working day.',
      ],
      panel: [
        {
          label: 'From',
          value: `<a href="mailto:${esc(f.email)}" style="color:#17131A;">${esc(f.email)}</a>${f.role ? `<br><span style="color:#6E6575;">${esc(f.role)}</span>` : ''}`,
        },
        { label: 'Per month', value: esc(dash(f.volume)) },
        { label: 'Live by', value: esc(dash(f.timeline)) },
      ],
      extra: f.notes ? quoted('What would stop this working', f.notes) : undefined,
      action: { label: `Reply to ${f.organization}`, url: replyUrl },
      note: `Also in the staff console: <a href="${esc(f.consoleUrl)}" style="color:#6E6575;">Platform leads</a>, where it can be marked handled.`,
      reason: 'You are getting this because a platform filled in the contact form on anystudio.ai/org.',
      audience: 'staff',
    }),
  };
}
