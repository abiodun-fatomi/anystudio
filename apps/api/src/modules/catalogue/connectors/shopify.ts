/**
 * Shopify, through the Admin REST API with a custom-app access token.
 *
 * The seller makes the token themselves: Shopify admin → Settings → Apps and
 * sales channels → Develop apps → Create app → Admin API scopes
 * `read_products` → Install → reveal the token (shpat_…). No OAuth, no app
 * review, nothing to host — the right size for a shop connecting one store.
 * Pages follow the `Link: <…page_info=…>; rel="next"` header.
 */
import { MAX_IMAGES_PER_PRODUCT, STORE_TIMEOUT_MS, StoreError, plainText, toMinor, type RemoteProduct, type StoreConnector, type StoreInfo } from './types';

const API_VERSION = '2024-10';

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  status: 'active' | 'archived' | 'draft';
  updated_at: string;
  variants?: Array<{ price?: string }>;
  images?: Array<{ src: string }>;
}

/** acme.myshopify.com, from whatever the person typed: a URL, a bare name, a custom domain they think is the shop. */
export function shopifyDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d.includes('.')) d = `${d}.myshopify.com`;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(d))
    throw new StoreError(`"${input}" is not a myshopify.com domain`, true, 'Use the shop’s myshopify.com address — Settings → Domains shows it.');
  return d;
}

export class ShopifyConnector implements StoreConnector {
  async probe(domain: string, credentials: Record<string, string>): Promise<StoreInfo> {
    const res = await this.get<{ shop?: { name?: string; currency?: string; myshopify_domain?: string } }>(domain, credentials, `/shop.json`);
    const shop = res.shop ?? {};
    return { name: shop.name ?? domain, currency: shop.currency ?? null, domain: shop.myshopify_domain ?? domain };
  }

  async *products(domain: string, credentials: Record<string, string>): AsyncGenerator<RemoteProduct[]> {
    let path: string | null = `/products.json?limit=250&status=active,archived&fields=id,title,handle,body_html,status,updated_at,variants,images`;
    while (path) {
      const res: { body: { products?: ShopifyProduct[] }; next: string | null } = await this.page(domain, credentials, path);
      yield (res.body.products ?? []).map((p) => this.normalise(domain, p));
      path = res.next;
    }
  }

  private normalise(domain: string, p: ShopifyProduct): RemoteProduct {
    return {
      externalId: String(p.id),
      handle: p.handle ?? null,
      title: p.title,
      description: plainText(p.body_html),
      priceMinor: toMinor(p.variants?.[0]?.price ?? null, null),
      currency: null, // the shop's currency, learned at probe time and stamped by the service
      url: p.handle ? `https://${domain.replace(/\.myshopify\.com$/, '')}.myshopify.com/products/${p.handle}` : null,
      imageUrls: (p.images ?? []).slice(0, MAX_IMAGES_PER_PRODUCT).map((i) => i.src),
      active: p.status === 'active',
      updatedAt: p.updated_at ? new Date(p.updated_at) : null,
    };
  }

  private async get<T>(domain: string, credentials: Record<string, string>, path: string): Promise<T> {
    return (await this.page<T>(domain, credentials, path)).body;
  }

  private async page<T>(domain: string, credentials: Record<string, string>, path: string): Promise<{ body: T; next: string | null }> {
    let res: Response;
    try {
      res = await fetch(`https://${domain}/admin/api/${API_VERSION}${path}`, {
        headers: { 'X-Shopify-Access-Token': credentials.accessToken ?? '', accept: 'application/json' },
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new StoreError(`shopify ${domain}: ${e instanceof Error ? e.message : String(e)}`, false, 'Shopify did not answer. Try again in a moment.');
    }
    if (res.status === 401 || res.status === 403)
      throw new StoreError(
        `shopify ${domain}: http ${res.status}`,
        true,
        'Shopify refused the token. Check it has the read_products scope, or make a new one.',
      );
    if (res.status === 404) throw new StoreError(`shopify ${domain}: not found`, true, 'No shop answers at that address.');
    if (res.status === 429) throw new StoreError(`shopify ${domain}: rate limited`, false);
    if (!res.ok) throw new StoreError(`shopify ${domain}: http ${res.status}`, res.status < 500);
    const body = (await res.json().catch(() => ({}))) as T;
    const link = res.headers.get('link') ?? '';
    const m = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link);
    const next = m ? `/products.json?limit=250&page_info=${m[1]}` : null;
    return { body, next };
  }
}
