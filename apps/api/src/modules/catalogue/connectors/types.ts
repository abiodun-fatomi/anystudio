/**
 * What a store looks like from here, whichever platform it runs on: a way
 * to prove the credentials work, and a way to read every product. Each
 * connector turns its platform's shapes into RemoteProduct; nothing past
 * this file knows a Shopify variant from a WooCommerce meta field.
 */
export interface RemoteProduct {
  externalId: string;
  handle: string | null;
  title: string;
  /** Plain text. Connectors strip the HTML their platforms store. */
  description: string | null;
  priceMinor: number | null;
  currency: string | null;
  url: string | null;
  imageUrls: string[];
  active: boolean;
  updatedAt: Date | null;
}

export interface StoreInfo {
  name: string;
  currency: string | null;
  /** The canonical domain to store — normalised by the connector. */
  domain: string;
}

export interface StoreConnector {
  /** Prove the credentials and learn the shop's name and currency. Throws StoreError. */
  probe(domain: string, credentials: Record<string, string>): Promise<StoreInfo>;
  /** Every product, in pages, newest first. */
  products(domain: string, credentials: Record<string, string>): AsyncGenerator<RemoteProduct[]>;
}

export class StoreError extends Error {
  constructor(
    message: string,
    /** True when retrying without the person changing something will not help (revoked token, wrong domain). */
    readonly permanent: boolean,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export const STORE_TIMEOUT_MS = 30_000;
export const MAX_IMAGES_PER_PRODUCT = 4;

/** Tags out, entities back to characters, whitespace collapsed, capped. */
export function plainText(html: string | null | undefined, max = 2000): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, max) : null;
}

/** "12.50" → 1250; zero-decimal currencies keep the integer. */
export function toMinor(amount: string | number | null | undefined, currency: string | null): number | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  const zero = new Set(['UGX', 'RWF', 'XOF', 'XAF', 'JPY', 'KRW']);
  return Math.round(zero.has((currency ?? '').toUpperCase()) ? n : n * 100);
}
