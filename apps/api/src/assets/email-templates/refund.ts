/** Refund mails: the request was received, and the decision. */
import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

export function refundRequested(to: string, name: string | null, f: { item: string; amount: string; reference: string; url: string }): Mail {
  return {
    to,
    subject: `Refund request received — ${f.amount}`,
    text: [
      greet(name),
      '',
      `We have your refund request for ${f.item} (${f.amount}, reference ${f.reference}).`,
      'It is reviewed within two working days; the credits stay on hold until then.',
      f.url,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: 'Reviewed within two working days.',
      eyebrow: 'Refund',
      title: 'Your refund request is in',
      paragraphs: [
        esc(greet(name)),
        `We have your request for <strong>${esc(f.item)}</strong>. It is reviewed within two working days; the credits stay on hold until then, and you will hear either way.`,
      ],
      panel: [
        { label: 'Amount', value: `<strong>${esc(f.amount)}</strong>` },
        { label: 'Reference', value: esc(f.reference) },
      ],
      action: { label: 'See your payments', url: f.url },
      reason: 'You are getting this because you asked for a refund on AnyStudio.',
    }),
  };
}

export function refundDecided(
  to: string,
  name: string | null,
  f: { approved: boolean; item: string; amount: string; reference: string; note: string | null; url: string },
): Mail {
  return {
    to,
    subject: f.approved ? `Refunded: ${f.amount}` : `About your refund request — ${f.item}`,
    text: [
      greet(name),
      '',
      f.approved
        ? `${f.amount} for ${f.item} is on its way back to the card or account it came from. Banks take 3–10 working days to show it.`
        : `We could not refund ${f.item} this time.${f.note ? ` ${f.note}` : ''}`,
      f.url,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: f.approved ? 'Money is on its way back.' : 'A decision on your request.',
      eyebrow: 'Refund',
      tone: f.approved ? 'ok' : 'warn',
      title: f.approved ? `${esc(f.amount)} refunded` : 'Your refund request',
      paragraphs: [
        esc(greet(name)),
        f.approved
          ? `<strong>${esc(f.amount)}</strong> for ${esc(f.item)} is on its way back to the card or account it came from. Banks take 3–10 working days to show it. The credits have been removed from the balance.`
          : `We could not refund <strong>${esc(f.item)}</strong> this time.${f.note ? ` ${esc(f.note)}` : ''} Reply to this email if something is wrong and a person will look.`,
      ],
      panel: [{ label: 'Reference', value: esc(f.reference) }],
      action: { label: 'See your payments', url: f.url },
      reason: 'You are getting this because you asked for a refund on AnyStudio.',
    }),
  };
}
