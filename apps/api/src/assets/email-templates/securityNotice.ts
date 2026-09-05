import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, greet, html } from './_layout';

export type SecurityEvent = 'password_changed' | 'email_changed' | 'mfa_enabled' | 'mfa_disabled' | 'recovery_codes' | 'signed_out_everywhere';

const WORDS: Record<SecurityEvent, { subject: string; line: string }> = {
  password_changed: {
    subject: 'Your AnyStudio password was changed',
    line: 'The password on your AnyStudio account was just changed, and every other device was signed out.',
  },
  email_changed: {
    subject: 'The email on your AnyStudio account was changed',
    line: 'The email on your AnyStudio account was just changed. This address no longer signs in.',
  },
  mfa_enabled: {
    subject: 'Two-step sign-in is on',
    line: 'Two-step sign-in was just turned on for your AnyStudio account. From now on, signing in on a new device asks for a code from your authenticator app.',
  },
  mfa_disabled: {
    subject: 'Two-step sign-in was turned off',
    line: 'Two-step sign-in was just turned off for your AnyStudio account. Your password alone now signs in.',
  },
  recovery_codes: {
    subject: 'New recovery codes were made',
    line: 'A new set of recovery codes was just made for your AnyStudio account. The old ones no longer work.',
  },
  signed_out_everywhere: { subject: 'You were signed out everywhere', line: 'Every session on your AnyStudio account was just ended.' },
};

/**
 * One template for every "something changed on your account" email. The
 * shape is always the same — what happened, when, what to do if it wasn't you
 * — because a person skimming a worrying email needs the same thing in the
 * same place every time.
 */
export function securityNotice(to: string, name: string | null, event: SecurityEvent, when: Date, where: string | null, securityUrl: string): Mail {
  const w = WORDS[event];
  const stamp = `${when.toUTCString()}${where ? ` · ${where}` : ''}`;
  return {
    to,
    subject: w.subject,
    text: [
      greet(name),
      '',
      w.line,
      '',
      `When: ${stamp}`,
      '',
      "If that was you, there's nothing to do.",
      "If it wasn't, open Security straight away, change your password and sign out everywhere:",
      securityUrl,
      '',
      SIGNATURE,
    ].join('\n'),
    html: html(
      [
        greet(name),
        w.line,
        `<span style="color:#6E6575">When: ${stamp}</span>`,
        "If that was you, there's nothing to do.",
        "If it wasn't, open Security straight away, change your password and sign out everywhere.",
      ],
      { label: 'Open Security', url: securityUrl },
    ),
  };
}
