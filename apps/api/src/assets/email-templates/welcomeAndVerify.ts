import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, greet, html } from './_layout';

/**
 * Signup: welcome and verify in one message.
 *
 * Two separate emails would be worse on both counts — the welcome would
 * arrive without anything to do, and a bare "confirm your email" reads like
 * a chore from a company you have not met yet.
 */
export function welcomeAndVerify(to: string, name: string | null, link: string): Mail {
  const lines = [
    greet(name),
    'Your AnyStudio account is ready, and you have <strong>three free generations</strong> waiting — no card.',
    'Confirm this address so we can reach you if you ever lose your password:',
  ];
  return {
    to,
    subject: 'Welcome to AnyStudio — confirm your email',
    text: [
      greet(name), '',
      'Your AnyStudio account is ready, and you have three free generations waiting — no card.',
      '', 'Confirm this address so we can reach you if you ever lose your password:',
      link, '',
      'The link works for 24 hours. If you did not sign up, ignore this email — the account cannot be used until someone confirms it.',
      '', SIGNATURE,
    ].join('\n'),
    html: html([...lines,
      'The link works for 24 hours. If you did not sign up, ignore this email — nobody can use the account until it is confirmed.'],
      { label: 'Confirm my email', url: link }),
  };
}
