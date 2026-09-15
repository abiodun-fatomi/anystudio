import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../../config/globals/errors';

vi.mock('../../utils/safe-fetch', () => ({
  safeFetch: vi.fn(),
  UnsafeUrlError: class UnsafeUrlError extends Error {},
}));

import { safeFetch } from '../../utils/safe-fetch';
import { MediaService } from './media.service';

/**
 * A link a merchant pastes is either the picture or the page it sits on, and
 * the service should not need telling which. Pinned: a page's Open Graph
 * picture is what gets ingested; a picture link is ingested as itself; a dead
 * first candidate falls through to the next; and a page with no picture says
 * so instead of guessing.
 */

const response = (body: string, type: string, status = 200) =>
  ({
    ok: status < 400,
    status,
    headers: new Headers({ 'content-type': type }),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }) as unknown as Response;

const page = `<html><head><meta property="og:title" content="Mini handbag"><meta property="og:image" content="https://cdn.shop.ng/bag-og.jpg"></head>
<body><img src="/i/bag-2.jpg" alt="Mini handbag, side"></body></html>`;

let service: MediaService;
let ingestUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
  service = Object.create(MediaService.prototype) as MediaService;
  ingestUrl = vi.fn(async (_ws: string, _u: string | null, url: string) => ({ id: 'asset', key: `k:${url}` }));
  Object.assign(service, { ingestUrl });
});

describe('a product from a link', () => {
  it('reads a listing page and ingests the picture it presents, with the page title', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(response(page, 'text/html; charset=utf-8'));
    const out = await service.ingestProduct('ws', 'u', 'https://shop.ng/products/mini-handbag');
    expect(ingestUrl).toHaveBeenCalledWith('ws', 'u', 'https://cdn.shop.ng/bag-og.jpg');
    expect(out).toMatchObject({ asset: { key: 'k:https://cdn.shop.ng/bag-og.jpg' }, title: 'Mini handbag', pageUrl: 'https://shop.ng/products/mini-handbag' });
  });

  it('ingests a direct picture link as itself, with nothing declared', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(response('', 'image/jpeg'));
    const out = await service.ingestProduct('ws', 'u', 'https://cdn.shop.ng/bag.jpg');
    expect(ingestUrl).toHaveBeenCalledWith('ws', 'u', 'https://cdn.shop.ng/bag.jpg');
    expect(out.title).toBeNull();
    expect(out.pageUrl).toBeNull();
  });

  it('falls through to the next picture when the first cannot be fetched', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(response(page, 'text/html'));
    ingestUrl.mockRejectedValueOnce(new ValidationError({ url: 'The URL answered 404.' }));
    const out = await service.ingestProduct('ws', 'u', 'https://shop.ng/products/mini-handbag');
    expect(ingestUrl).toHaveBeenCalledTimes(2);
    expect(ingestUrl).toHaveBeenLastCalledWith('ws', 'u', 'https://shop.ng/i/bag-2.jpg');
    expect(out.asset.key).toBe('k:https://shop.ng/i/bag-2.jpg');
  });

  it('says plainly when a page has no product picture', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(response('<html><body><p>Coming soon</p></body></html>', 'text/html'));
    await expect(service.ingestProduct('ws', 'u', 'https://shop.ng/soon')).rejects.toMatchObject({
      details: { url: expect.stringContaining('does not present a product picture') },
    });
    expect(ingestUrl).not.toHaveBeenCalled();
  });

  it('refuses anything that is not https before fetching', async () => {
    await expect(service.ingestProduct('ws', 'u', 'http://shop.ng/p')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.ingestProduct('ws', 'u', 'not a url')).rejects.toBeInstanceOf(ValidationError);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('refuses a link that serves neither a page nor a picture', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(response('%PDF', 'application/pdf'));
    await expect(service.ingestProduct('ws', 'u', 'https://shop.ng/catalogue.pdf')).rejects.toMatchObject({
      details: { url: expect.stringContaining('application/pdf') },
    });
  });
});
