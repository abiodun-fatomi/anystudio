/** Fixed local prices, shown the way the market writes them. Never converted. */
const ZERO_DECIMAL = new Set(['UGX', 'RWF', 'XOF', 'XAF', 'JPY', 'KRW']);

export function money(major: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: ZERO_DECIMAL.has(currency) || Number.isInteger(major) ? 0 : 2 }).format(major);
  } catch {
    return `${currency} ${major.toLocaleString()}`;
  }
}

export function moneyMinor(minor: number, currency: string): string {
  return money(ZERO_DECIMAL.has(currency) ? minor : minor / 100, currency);
}

export const PLAN_WORDS: Record<string, { name: string; who: string }> = {
  starter: { name: 'Starter', who: 'Free. Thirty credits to see what it does.' },
  creator: { name: 'Creator', who: 'One person posting most days.' },
  business: { name: 'Business', who: 'A shop with a catalogue and weekly video.' },
  org: { name: 'Organization', who: 'Teams, agencies and platforms.' },
};

export const PACK_WORDS: Record<string, string> = {
  'pack.small': 'A week of photos',
  'pack.medium': 'A month of photos and captions',
  'pack.large': 'Photos, captions and a few reels',
  'pack.video': 'Built for video ads',
};
