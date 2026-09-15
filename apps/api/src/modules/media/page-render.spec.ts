import { describe, expect, it, vi } from 'vitest';
import { CloudflarePageRenderer, NoPageRenderer, pageRendererFromEnv } from './page-render';

/**
 * The renderer is a fallback that must never make things worse: a refusal,
 * a bad body or a timeout is a null, not an exception, so the reader's own
 * message still reaches the person. And it is off until both variables are
 * set — a half-configured account renders nothing rather than erroring.
 */

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe('rendering a page through Cloudflare', () => {
  it('posts the URL to the account’s content endpoint and returns the rendered HTML', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { success: true, result: '<html><body><h1>iPhone 17 pro</h1></body></html>' }));
    const html = await new CloudflarePageRenderer('acct-1', 'tok', fetchImpl as never).render('https://www.mykiya.ng/storefront/productdetail/1073');
    expect(html).toContain('iPhone 17 pro');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/browser-rendering/content');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body as string) as { url: string; gotoOptions: { waitUntil: string }; rejectResourceTypes: string[] };
    expect(body.url).toBe('https://www.mykiya.ng/storefront/productdetail/1073');
    expect(body.gotoOptions.waitUntil).toBe('networkidle0');
    expect(body.rejectResourceTypes).toContain('font');
  });

  it('answers null, never throws, when Cloudflare refuses or the body is not a page', async () => {
    const refused = new CloudflarePageRenderer('a', 't', vi.fn(async () => reply(429, { success: false, errors: [{ message: 'rate limited' }] })) as never);
    expect(await refused.render('https://x.example/')).toBeNull();
    const odd = new CloudflarePageRenderer('a', 't', vi.fn(async () => reply(200, { success: true, result: { not: 'a string' } })) as never);
    expect(await odd.render('https://x.example/')).toBeNull();
    const down = new CloudflarePageRenderer('a', 't', vi.fn(async () => Promise.reject(new Error('ECONNRESET'))) as never);
    expect(await down.render('https://x.example/')).toBeNull();
  });

  it('is off unless both the account and the token are set', () => {
    expect(pageRendererFromEnv({} as NodeJS.ProcessEnv)).toBeInstanceOf(NoPageRenderer);
    expect(pageRendererFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a' } as NodeJS.ProcessEnv)).toBeInstanceOf(NoPageRenderer);
    expect(pageRendererFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_BROWSER_TOKEN: 't' } as NodeJS.ProcessEnv)).toBeInstanceOf(CloudflarePageRenderer);
  });
});
