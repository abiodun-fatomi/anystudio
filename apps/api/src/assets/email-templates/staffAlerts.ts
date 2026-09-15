/**
 * Alerts to the team's own inboxes: a job application, a refund request.
 * Same shell as every customer email so the inbox reads as one product,
 * but written for the person who acts on it — the facts in the panel, what
 * the person said quoted as they said it, and the button is the action.
 */
import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, render } from './_layout';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

/** Something a person wrote, quoted in their words under a small label. */
export function quoted(label: string, text: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="border-left:3px solid #D6006E;padding:4px 0 4px 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:#17131A;white-space:pre-wrap;">` +
    `<div style="font-family:${MONO};font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6E6575;padding-bottom:6px;">${esc(label)}</div>` +
    `${esc(text)}</td></tr></table>`
  );
}

export function applicationAlert(
  to: string,
  f: { name: string; email: string; phone: string | null; links: string | null; coverNote: string | null; title: string; team: string; consoleUrl: string },
): Mail {
  return {
    to,
    subject: `New application: ${f.title} — ${f.name}`,
    text: [
      `${f.name} applied for ${f.title} (${f.team}).`,
      '',
      `Email: ${f.email}`,
      `Phone: ${f.phone ?? '—'}`,
      `Links: ${f.links ?? '—'}`,
      '',
      'Cover note:',
      f.coverNote ?? '—',
      '',
      `Console: ${f.consoleUrl}`,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: `${f.name} · ${f.title}`,
      eyebrow: 'Careers',
      title: esc(f.name),
      paragraphs: [`Applied for <strong>${esc(f.title)}</strong> on the ${esc(f.team)} team. The CV is in the console.`],
      panel: [
        { label: 'Email', value: `<a href="mailto:${esc(f.email)}" style="color:#17131A;">${esc(f.email)}</a>` },
        ...(f.phone ? [{ label: 'Phone', value: esc(f.phone) }] : []),
        ...(f.links ? [{ label: 'Links', value: esc(f.links).replace(/\n/g, '<br>') }] : []),
      ],
      extra: f.coverNote ? quoted('Cover note', f.coverNote) : undefined,
      action: { label: 'Open in the console', url: f.consoleUrl },
      reason: 'You are getting this because CAREERS_EMAIL is set for the AnyStudio API.',
      audience: 'staff',
    }),
  };
}

export function refundAlert(
  to: string,
  f: { workspaceName: string; amount: string; item: string; reference: string; credits: number; balance: number; reason: string; consoleUrl: string },
): Mail {
  return {
    to,
    subject: `Refund request: ${f.amount} · ${f.reference}`,
    text: [
      `${f.workspaceName} asked for a refund of ${f.amount} (${f.item}, ${f.reference}).`,
      '',
      `Credits bought: ${f.credits.toLocaleString()}`,
      `Balance now: ${f.balance.toLocaleString()}`,
      '',
      'Their reason:',
      f.reason,
      '',
      `Decide: ${f.consoleUrl}`,
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: `${f.workspaceName} · ${f.amount}`,
      eyebrow: 'Refund request',
      tone: 'warn',
      title: `${esc(f.amount)} — ${esc(f.workspaceName)}`,
      paragraphs: [`For <strong>${esc(f.item)}</strong>, reference ${esc(f.reference)}. The credits are on hold until this is decided.`],
      panel: [
        { label: 'Credits', value: esc(f.credits.toLocaleString()) },
        { label: 'Balance', value: esc(f.balance.toLocaleString()) },
      ],
      extra: quoted('Their reason', f.reason),
      action: { label: 'Decide in the console', url: f.consoleUrl },
      reason: 'You are getting this because REFUNDS_EMAIL is set for the AnyStudio API.',
      audience: 'staff',
    }),
  };
}
