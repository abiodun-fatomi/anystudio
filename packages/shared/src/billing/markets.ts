/**
 * Which currency a person is priced in, from where they are.
 *
 * Prices are fixed per market (Plan.priceByMarket, CreditPack.priceByMarket)
 * in exactly these currencies; anything else would be a live-FX conversion,
 * which the invariants forbid. Nigeria is priced in naira, the UK in
 * pounds, and everyone else in dollars — the gateway is chosen from the
 * currency (NGN → Flutterwave, the rest → Paddle).
 *
 * A confirmed residence/business country takes precedence over phone and
 * location suggestions. Unknown markets display USD provisionally. This
 * helper selects initial prices, never migrates existing subscriptions.
 */
export const MARKET_CURRENCIES = ['NGN', 'USD', 'GBP'] as const;
export type MarketCurrency = (typeof MARKET_CURRENCIES)[number];

const BY_COUNTRY: Record<string, MarketCurrency> = { NG: 'NGN', GB: 'GBP' };

export function currencyForCountry(country: string | null | undefined): MarketCurrency {
  if (!country) return 'USD';
  return BY_COUNTRY[country.toUpperCase()] ?? 'USD';
}

/** The storage/billing region for a workspace: the country, lower-case. */
export function regionForCountry(country: string | null | undefined): string {
  return (country ?? 'ng').toLowerCase();
}

export const CURRENCY_WORDS: Record<MarketCurrency, { symbol: string; name: string }> = {
  NGN: { symbol: '₦', name: 'Nigerian naira' },
  USD: { symbol: '$', name: 'US dollar' },
  GBP: { symbol: '£', name: 'British pound' },
};
