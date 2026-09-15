import { describe, expect, it } from 'vitest';
import { looksLikeAppShell, readProductPage } from './product-page';

/**
 * A link preview's reading of a product page: the picture the page presents
 * as the product, best candidate first, and the page's own name for it.
 */

const page = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('reading a product page', () => {
  it('prefers the Open Graph image, then Twitter, then schema.org, then content images', () => {
    const html = page(
      `<meta property="og:title" content="Handwoven Raffia Tote"><meta property="og:image" content="/img/tote-og.jpg">
       <meta name="twitter:image" content="https://cdn.shop.ng/tote-tw.jpg">
       <script type="application/ld+json">{"@type":"Product","name":"Tote","image":["https://cdn.shop.ng/tote-ld.jpg"]}</script>`,
      `<img src="/static/logo.png" width="80" height="40"><img src="/img/tote-1.jpg" alt="Raffia tote, front">`,
    );
    const out = readProductPage(html, 'https://shop.ng/products/tote');
    expect(out.images).toEqual([
      'https://shop.ng/img/tote-og.jpg',
      'https://cdn.shop.ng/tote-tw.jpg',
      'https://cdn.shop.ng/tote-ld.jpg',
      'https://shop.ng/img/tote-1.jpg',
    ]);
    expect(out.title).toBe('Handwoven Raffia Tote');
  });

  it('resolves relative and protocol-relative URLs against the page, and drops http', () => {
    const html = page(`<meta property="og:image" content="//cdn.shop.ng/a.jpg"><meta property="og:image" content="http://insecure.example/b.jpg">`);
    expect(readProductPage(html, 'https://shop.ng/p/1').images).toEqual(['https://cdn.shop.ng/a.jpg']);
  });

  it('falls back to the <title> and to the first sizeable picture when the page has no cards', () => {
    const html = page(
      `<title>  Mini handbag –
        Bimbo Market </title>`,
      `<img src="data:image/gif;base64,R0lG"><img src="/i/spacer.gif" width="1" height="1"><img class="product-photo" src="/i/bag.jpg">`,
    );
    const out = readProductPage(html, 'https://bimbomarket.ng/p/9');
    expect(out.images).toEqual(['https://bimbomarket.ng/i/bag.jpg']);
    expect(out.title).toBe('Mini handbag – Bimbo Market');
  });

  it('reads a schema.org graph and nested image objects', () => {
    const html = page(
      `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Product","image":{"@type":"ImageObject","url":"https://cdn.x/p.jpg"}}]}</script>`,
    );
    expect(readProductPage(html, 'https://x.example/p').images).toEqual(['https://cdn.x/p.jpg']);
  });

  it('answers empty rather than inventing a picture', () => {
    const out = readProductPage(page('<title>Nothing here</title>', '<p>text</p>'), 'https://x.example/');
    expect(out.images).toEqual([]);
    expect(out.title).toBe('Nothing here');
    expect(out.appShell).toBe(false);
  });

  it('knows an application shell from a page that simply has no picture', () => {
    // Mykiya's product page as the server sends it: the generic title, a mount point, bundles, nothing else.
    const shell = page(
      '<title>Mykiya | Shop Electronics, Fashion &amp; Groceries</title><script src="/static/js/main.3f2a.js"></script>',
      '<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script src="/static/js/vendor.js"></script>',
    );
    const out = readProductPage(shell, 'https://www.mykiya.ng/storefront/productdetail/1073');
    expect(out.images).toEqual([]);
    expect(out.appShell).toBe(true);
    // A real page with real words and no picture is not a shell.
    const article = page('<title>About us</title>', `<h1>About us</h1><p>${'We sell things to people who want them. '.repeat(20)}</p>`);
    expect(looksLikeAppShell(article)).toBe(false);
  });

  it('decodes entities in attributes and ignores malformed JSON-LD', () => {
    const html = page(
      `<meta property="og:image" content="https://cdn.x/p.jpg?w=800&amp;h=800"><script type="application/ld+json">{not json</script><meta property="og:title" content="Ada&#39;s bag">`,
    );
    const out = readProductPage(html, 'https://x.example/p');
    expect(out.images).toEqual(['https://cdn.x/p.jpg?w=800&h=800']);
    expect(out.title).toBe("Ada's bag");
  });
});
