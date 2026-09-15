/**
 * A page as a browser sees it, for the pages that are nothing until a
 * browser sees them.
 *
 * Marketplaces built as single-page apps (Mykiya is one) serve an empty
 * shell and draw the product with JavaScript, so the HTML a link reader
 * gets has no picture and the generic site title. The fix is to let a real
 * browser load it — and rather than run Chromium inside the API (300 MB in
 * the image, a few hundred MB of memory per render), the render is asked of
 * Cloudflare's Browser Rendering REST API, which the account already has:
 * one POST, the rendered DOM back, billed by the second and free for the
 * first ten hours a month.
 *
 * Off unless CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_TOKEN are set; the
 * static reader then stands alone, as before. The URL has already passed
 * the SSRF guard — it is https and a public host — before it gets here, and
 * the render happens on Cloudflare's machines, not ours.
 */
import { logger } from '../../../config/logger';

export interface PageRenderer {
  /** The rendered HTML, or null when rendering is off, refused, or timed out. Never throws. */
  render(url: string): Promise<string | null>;
}

export const RENDER_TIMEOUT_MS = 15_000;

export class CloudflarePageRenderer implements PageRenderer {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async render(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS + 2_000);
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/browser-rendering/content`, {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          // The DOM is what we read; the pixels are not. Fonts, media and analytics only slow the page down.
          rejectResourceTypes: ['font', 'media', 'stylesheet'],
          rejectRequestPattern: ['/(analytics|gtag|googletagmanager|facebook\\.net|hotjar|clarity)/'],
          gotoOptions: { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS },
          userAgent: 'Mozilla/5.0 (compatible; AnyStudioBot/1.0; +https://anystudio.ai)',
        }),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> } | null;
      if (!res.ok || !body?.success || typeof body.result !== 'string') {
        logger.warn({ url, status: res.status, errors: body?.errors?.map((e) => e.message), ms: Date.now() - started }, 'page render refused');
        return null;
      }
      logger.info({ url, bytes: body.result.length, ms: Date.now() - started }, 'page rendered');
      return body.result;
    } catch (err) {
      logger.warn({ url, err, ms: Date.now() - started }, 'page render failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Nothing configured: the static reader stands alone. */
export class NoPageRenderer implements PageRenderer {
  async render(): Promise<string | null> {
    return null;
  }
}

export function pageRendererFromEnv(env: NodeJS.ProcessEnv = process.env): PageRenderer {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_BROWSER_TOKEN?.trim();
  if (account && token) return new CloudflarePageRenderer(account, token);
  return new NoPageRenderer();
}
