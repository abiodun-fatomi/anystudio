import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, greet, html } from './_layout';

const ROLE_WORDS: Record<string, string> = {
  ADMIN: 'an admin (they can change settings and invite people)',
  MEMBER: 'a member (they can make things)',
  BILLING: 'a billing contact (they can see and top up credits)',
  AUDITOR: 'a viewer (they can see everything, change nothing)',
};

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
    html: html(
      [
        greet(null),
        `<strong>${who}</strong> invited you to join <strong>${workspaceName}</strong> on AnyStudio as ${as}.`,
        'The link works for 7 days.',
        "If you don't know them, ignore this email — nothing happens unless the link is opened.",
      ],
      { label: `Join ${workspaceName}`, url: link },
    ),
  };
}
