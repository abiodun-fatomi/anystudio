import type { Mail } from '../../utils/mail-service';
import { SIGNATURE, assetBase, esc, greet, render } from './_layout';

/**
 * Signup: welcome and verify in one message.
 *
 * Two separate emails would be worse on both counts — the welcome would
 * arrive without anything to do, and a bare "confirm your email" reads like
 * a chore from a company you have not met yet. The only email with a hero
 * image: it is the first thing they see from us.
 */
export function welcomeAndVerify(to: string, name: string | null, link: string): Mail {
  const assets = assetBase();
  return {
    to,
    subject: 'Welcome to AnyStudio — confirm your email',
    text: [
      greet(name),
      '',
      'Your AnyStudio account is ready, and you have three free generations waiting — no card.',
      '',
      'Confirm this address so we can reach you if you ever lose your password:',
      link,
      '',
      'The link works for 24 hours. If you did not sign up, ignore this email — the account cannot be used until someone confirms it.',
      '',
      SIGNATURE,
    ].join('\n'),
    html: render({
      preheader: 'Three free generations are waiting. Confirm your email to keep your account safe.',
      eyebrow: 'Welcome',
      title: 'One photo in. Everything you post, out.',
      ...(assets ? { hero: { src: `${assets}/welcome-hero.jpg`, alt: 'A product photo beside the branded posts made from it', width: 528, height: 297 } } : {}),
      paragraphs: [
        esc(greet(name)),
        'Your AnyStudio account is ready, and you have <strong>three free generations</strong> waiting — no card needed. Send one product photo and get back branded images, a description, captions and a reel.',
        'First, confirm this address so we can reach you if you ever lose your password.',
      ],
      action: { label: 'Confirm my email', url: link },
      note: 'The link works for 24 hours. If you did not sign up, ignore this email — nobody can use the account until it is confirmed.',
    }),
  };
}
