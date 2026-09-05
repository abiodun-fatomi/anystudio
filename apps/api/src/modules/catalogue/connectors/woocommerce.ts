/**
 * WooCommerce, through the REST API with a consumer key and secret.
 *
 * Made in WordPress admin → WooCommerce → Settings → Advanced → REST API →
 * Add key, permissions Read. Sent as HTTP basic auth over https, which
 * WooCommerce accepts on any site with TLS; the query-string form is for
 * http sites, which are refused here. Pages are numbered; the total is in
 * `X-WP-TotalPages`.
 */
import { MAX_IMAGES_PER_PRODUCT, STORE_TIMEOUT_MS, StoreError, plainText, toMinor, type RemoteProduct, type StoreConnector, type StoreInfo } from './types';

interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink?: string;
  description?: string;
  short_description?: string;
  status: string;
  date_modified_gmt?: string;
  price?: string;
  regular_price?: string;
  images?: Array<{ src: string }>;
}

/** https://shop.example — origin only, https only. */
export function wooOrigin(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StoreError(`"${input}" is not a site address`, true, 'Enter the shop’s address, like https://shop.example');
  }
  if (u.protocol !== 'https:') throw new StoreError(`${input}: not https`, true, 'The shop must be served over https for the keys to travel safely.');
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
    throw new StoreError(`${input}: private address`, true, 'That address is not reachable from here.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export class WooCommerceConnector implements StoreConnector {
  async probe(origin: string, credentials: Record<string, string>): Promise<StoreInfo> {
    const settings = await this.get<Array<{ id: string; value: string }>>(origin, credentials, `/wp-json/wc/v3/settings/general`);
    const currency = settings.find?.((s) => s.id === 'woocommerce_currency')?.value ?? null;
    let name = new URL(origin).hostname;
    try {
      const site = await this.get<{ name?: string }>(origin, credentials, `/wp-json`);
      if (site?.name) name = site.name;
    } catch {
      /* the settings call already proved the keys; the name is a nicety */
    }
    return { name, currency, domain: origin };
  }

  async *products(origin: string, credentials: Record<string, string>): AsyncGenerator<RemoteProduct[]> {
    for (let page = 1; page < 200; page++) {
      const { body, totalPages } = await this.page<WooProduct[]>(
        origin,
        credentials,
        `/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish,private,draft&orderby=modified&order=desc`,
      );
      yield (Array.isArray(body) ? body : []).map((p) => this.normalise(p));
      if (page >= totalPages) break;
    }
  }

  private normalise(p: WooProduct): RemoteProduct {
    return {
      externalId: String(p.id),
      handle: p.slug ?? null,
      title: p.name,
      description: plainText(p.short_description || p.description),
      priceMinor: toMinor(p.price || p.regular_price || null, null),
      currency: null,
      url: p.permalink ?? null,
      imageUrls: (p.images ?? []).slice(0, MAX_IMAGES_PER_PRODUCT).map((i) => i.src),
      active: p.status === 'publish',
      updatedAt: p.date_modified_gmt ? new Date(`${p.date_modified_gmt}Z`) : null,
    };
  }

  private async get<T>(origin: string, credentials: Record<string, string>, path: string): Promise<T> {
    return (await this.page<T>(origin, credentials, path)).body;
  }

  private async page<T>(origin: string, credentials: Record<string, string>, path: string): Promise<{ body: T; totalPages: number }> {
    const auth = Buffer.from(`${credentials.consumerKey ?? ''}:${credentials.consumerSecret ?? ''}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${origin}${path}`, {
        headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new StoreError(`woocommerce ${origin}: ${e instanceof Error ? e.message : String(e)}`, false, 'The shop did not answer. Try again in a moment.');
    }
    if (res.status === 401 || res.status === 403)
      throw new StoreError(
        `woocommerce ${origin}: http ${res.status}`,
        true,
        'The shop refused the keys. Check they have Read permission, or make a new pair.',
      );
    if (res.status === 404)
      throw new StoreError(
        `woocommerce ${origin}: no REST API`,
        true,
        'No WooCommerce REST API answers at that address. Is the plugin active and pretty permalinks on?',
      );
    if (!res.ok) throw new StoreError(`woocommerce ${origin}: http ${res.status}`, res.status < 500);
    const body = (await res.json().catch(() => null)) as T;
    return { body, totalPages: Number(res.headers.get('x-wp-totalpages') ?? 1) || 1 };
  }
}
