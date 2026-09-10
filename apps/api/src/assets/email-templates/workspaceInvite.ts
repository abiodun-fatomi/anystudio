import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, esc, greet, render } from './_layout';

const ROLE_WORDS: Record<string, string> = {
  ADMIN: 'an admin (they can change settings and invite people)',
  MEMBER: 'a member (they can make things)',
  BILLING: 'a billing contact (they can see and top up credits)',
  AUDITOR: 'a viewer (they can see everything, change nothing)',
};

const ROLE_SHORT: Record<string, string> = { ADMIN: 'Admin', MEMBER: 'Member', BILLING: 'Billing', AUDITOR: 'Viewer' };

/** An invitation to join a workspace. Works for people with and without an account. */
export function workspaceInvite(to: string, inviterName: string | null, workspaceName: string, role: string, link: string): Mail {
  const who = inviterName?.trim() || 'Someone';
  const as = ROLE_WORDS[role] ?? role.toLowerCase();
  return {
    to,
    subject: `${who} invited you to ${workspaceName} on AnyStudio`,
    text: [
      greet(null),
      '',
      `${who} invited you to join ${workspaceName} on AnyStudio as ${as}.`,
      'Open this link within 7 days to accept:',
      link,
      '',
      "If you don't know them, ignore this — nothing happens unless the link is opened.",
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: `${who} invited you to ${workspaceName}. The invitation works for 7 days.`,
      eyebrow: 'Your team',
      title: `${esc(who)} invited you to <span style="white-space:nowrap">${esc(workspaceName)}</span>`,
      paragraphs: [
        esc(greet(null)),
        `You have been invited to join <strong>${esc(workspaceName)}</strong> on AnyStudio — the studio that turns one product photo into branded images, copy and reels.`,
      ],
      panel: [
        { label: 'Workspace', value: `<strong>${esc(workspaceName)}</strong>` },
        {
          label: 'Your role',
          value: `${esc(ROLE_SHORT[role] ?? role)} <span style="color:#6E6575">— ${esc(
            as
              .replace(/^an? /, '')
              .replace(/^[a-z ]+ \(/, '(')
              .replace(/^\(|\)$/g, ''),
          )}</span>`,
        },
        { label: 'Invited by', value: esc(who) },
      ],
      action: { label: `Join ${workspaceName}`, url: link },
      note: "The invitation works for 7 days. If you don't know them, ignore this email — nothing happens unless the link is opened.",
      reason: 'You are getting this because someone invited this address to a workspace on AnyStudio.',
    }),
  };
}
