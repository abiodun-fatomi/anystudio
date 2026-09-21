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
  it('offers Studio monthly and annually with the matching credits', () => {
    expect(text('[data-price="studio"]')).toBe('99');
    expect(text('[data-cr="studio"]')).toContain('9,000 credits');
    click('[data-cycle="yr"]');
    expect(text('[data-price="studio"]')).toBe('990');
    expect(text('[data-cr="studio"]')).toContain('108,000 credits');
    expect(document.querySelector('[data-plan="studio"] a')!.getAttribute('href')).toBe('/signup');
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

  it('includes Studio in the usage calculator and keeps its recommendation local', () => {
    const images = document.querySelector('#sImg') as HTMLInputElement;
    const reels = document.querySelector('#sReel') as HTMLInputElement;
    images.value = '300';
    reels.value = '0';
    images.dispatchEvent(new Event('input'));
    expect(text('#recName')).toBe('Studio');
    click('[data-cur="NGN"]');
    expect(text('#recCur')).toBe('₦');
    expect(text('#recPrice')).toBe('132,000');
  });
});
