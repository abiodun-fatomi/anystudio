/**
 * The invoice mails: issued, overdue, paid, and the account paused for
 * non-payment. Money is spelled out in the currency's own format; the link
 * always opens the invoice on the organization portal, where it can be paid
 * or printed.
 */
import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

export interface InvoiceMailFacts {
  workspaceName: string;
  number: string;
  /** "September 2026" */
  period: string;
  /** Already formatted: "₦1,240,000.00" */
  total: string;
  credits: number;
  /** "19 October 2026" */
  due: string;
  url: string;
}

export function invoiceIssued(to: string, name: string | null, f: InvoiceMailFacts): Mail {
  const zero = f.credits === 0;
  return {
    to,
    subject: `Invoice ${f.number} for ${f.workspaceName} — ${f.total} due ${f.due}`,
    text: [
      greet(name),
      '',
      `Here is the ${f.period} invoice for ${f.workspaceName} on AnyStudio.`,
      `${f.credits.toLocaleString()} credits were used. The total is ${f.total}, due ${f.due}.`,
      'Open it to pay online or to print it for a bank transfer:',
      f.url,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: `${f.total} for ${f.period}, due ${f.due}.`,
      eyebrow: 'Invoice',
      title: `${esc(f.period)} invoice for <span style="white-space:nowrap">${esc(f.workspaceName)}</span>`,
      paragraphs: [
        esc(greet(name)),
        zero
          ? `Nothing was used in ${esc(f.period)}, so there is nothing to pay — this is for the record.`
          : `<strong>${f.credits.toLocaleString()} credits</strong> were used in ${esc(f.period)}. The invoice is ready to pay online, or to print for a bank transfer.`,
      ],
      panel: [
        { label: 'Invoice', value: `<strong>${esc(f.number)}</strong>` },
        { label: 'Total', value: `<strong>${esc(f.total)}</strong>` },
        { label: 'Due', value: esc(f.due) },
      ],
      action: { label: 'Open the invoice', url: f.url },
      reason: 'You are getting this because you are an owner or the billing contact of this organization on AnyStudio.',
    }),
  };
}

export function invoiceOverdue(to: string, name: string | null, f: InvoiceMailFacts & { graceDays: number }): Mail {
  const pause = f.graceDays > 0 ? `If it is still unpaid in ${f.graceDays} days, new work is paused until it clears.` : 'New work is paused until it clears.';
  return {
    to,
    subject: `Invoice ${f.number} is overdue — ${f.total}`,
    text: [greet(name), '', `Invoice ${f.number} for ${f.workspaceName} (${f.total}) was due ${f.due} and is still open.`, pause, f.url, '', SIGNATURE].join(
      '\n',
    ),
    html: render({
      preheader: `${f.total} was due ${f.due}.`,
      eyebrow: 'Overdue',
      tone: 'warn',
      title: `Invoice ${esc(f.number)} is overdue`,
      paragraphs: [
        esc(greet(name)),
        `The ${esc(f.period)} invoice for <strong>${esc(f.workspaceName)}</strong> was due ${esc(f.due)} and is still open. ${esc(pause)}`,
        'If it was paid by bank transfer, reply with the reference and it will be marked as paid.',
      ],
      panel: [
        { label: 'Invoice', value: `<strong>${esc(f.number)}</strong>` },
        { label: 'Total', value: `<strong>${esc(f.total)}</strong>` },
        { label: 'Was due', value: esc(f.due) },
      ],
      action: { label: 'Pay the invoice', url: f.url },
      reason: 'You are getting this because you are an owner or the billing contact of this organization on AnyStudio.',
    }),
  };
}

export function invoicePaid(to: string, name: string | null, f: InvoiceMailFacts & { via: string; reference: string | null }): Mail {
  return {
    to,
    subject: `Paid: invoice ${f.number} — ${f.total}`,
    text: [
      greet(name),
      '',
      `Invoice ${f.number} for ${f.workspaceName} is paid (${f.total}, ${f.via}${f.reference ? `, ref ${f.reference}` : ''}).`,
      f.url,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: `${f.total} received. Thank you.`,
      eyebrow: 'Receipt',
      tone: 'ok',
      title: `Invoice ${esc(f.number)} is paid`,
      paragraphs: [esc(greet(name)), `Thank you — the ${esc(f.period)} invoice for <strong>${esc(f.workspaceName)}</strong> is settled.`],
      panel: [
        { label: 'Total', value: `<strong>${esc(f.total)}</strong>` },
        { label: 'Paid by', value: esc(f.via) },
        ...(f.reference ? [{ label: 'Reference', value: esc(f.reference) }] : []),
      ],
      action: { label: 'View the receipt', url: f.url },
      reason: 'You are getting this because you are an owner or the billing contact of this organization on AnyStudio.',
    }),
  };
}

export function accountPaused(to: string, name: string | null, f: { workspaceName: string; numbers: string[]; total: string; url: string }): Mail {
  const list = f.numbers.join(', ');
  return {
    to,
    subject: `${f.workspaceName} is paused — ${f.total} overdue`,
    text: [
      greet(name),
      '',
      `New work for ${f.workspaceName} is paused because ${list} ${f.numbers.length === 1 ? 'is' : 'are'} overdue (${f.total}).`,
      'Everything resumes the moment it is paid:',
      f.url,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: `Work resumes as soon as ${f.total} is paid.`,
      eyebrow: 'Paused',
      tone: 'danger',
      title: `${esc(f.workspaceName)} is paused`,
      paragraphs: [
        esc(greet(name)),
        `New work is paused because <strong>${esc(list)}</strong> ${f.numbers.length === 1 ? 'is' : 'are'} overdue. Nothing already made is affected, and everything resumes the moment the balance is paid.`,
      ],
      panel: [{ label: 'Overdue', value: `<strong>${esc(f.total)}</strong>` }],
      action: { label: 'Pay now', url: f.url },
      reason: 'You are getting this because you are an owner or the billing contact of this organization on AnyStudio.',
    }),
  };
}
