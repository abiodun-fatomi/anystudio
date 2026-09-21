// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { PRICING } from '@/content/pricing';

beforeEach(() => {
  document.documentElement.innerHTML = PRICING;
  // Exercise the shipped pricing controls without starting unrelated media
  // animations or theme timers from the marketing page's shared script.
  const start = PRICING.indexOf('  /* ---------- pricing ---------- */');
  const end = PRICING.indexOf('  /* screen readers and search engines both need the document language */', start);
  new Function('document', PRICING.slice(start, end))(document);
});

const text = (selector: string) => document.querySelector(selector)!.textContent;
const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();

describe('published pricing controls', () => {
  it('offers Business monthly and annually with the matching credits', () => {
    expect(text('[data-price="business"]')).toBe('29');
    expect(text('[data-cr="business"]')).toContain('2,400 credits');
    click('[data-cycle="yr"]');
    expect(text('[data-price="business"]')).toBe('290');
    expect(text('[data-cr="business"]')).toContain('28,800 credits');
    expect(document.querySelector('[data-plan="business"] a')!.getAttribute('href')).toBe('/signup');
  });

  it.each(['USD', 'NGN', 'GBP'])('keeps Organization in USD when browsing %s prices', (currency) => {
    click(`[data-cur="${currency}"]`);
    expect(text('[data-plan="org"] .cur')).toBe('$');
    expect(text('[data-price="org"]')).toBe('499');
    expect(text('[data-cr="org"]')).toContain('24,000 credits');
    click('[data-cycle="yr"]');
    expect(text('[data-price="org"]')).toBe('4,990');
    expect(text('[data-cr="org"]')).toContain('288,000 credits');
  });

  it('keeps the usage calculator recommendation and its local price in step', () => {
    const images = document.querySelector('#sImg') as HTMLInputElement;
    const reels = document.querySelector('#sReel') as HTMLInputElement;
    images.value = '150';
    reels.value = '0';
    images.dispatchEvent(new Event('input'));
    expect(text('#recName')).toBe('Business');
    click('[data-cur="NGN"]');
    expect(text('#recCur')).toBe('₦');
    expect(text('#recPrice')).toBe('39,000');
  });
});
