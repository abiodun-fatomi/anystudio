// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downscaleImage } from './downscale';

/**
 * The one property that matters: this must never make an upload worse.
 *
 * It sits in front of the single action the whole product depends on — a
 * seller putting a photo in — on hardware we do not control and cannot test
 * against. A cheap phone that runs out of memory mid-decode, a browser that
 * taints the canvas, a file whose type header lies: every one of those has to
 * end with the original file going up exactly as it would have before this
 * code existed. So most of what is below asserts that nothing happened.
 *
 * jsdom has neither createImageBitmap nor a real canvas, which is honest here:
 * the shrink itself is two browser calls, and what needs protecting is the
 * decision around them.
 */

const png = new Uint8Array(2 * 1024 * 1024);

function makeFile(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** A decode that reports a given size, the way a camera photo would. */
function stubDecode(width: number, height: number) {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close: vi.fn() })),
  );
}

/** A canvas whose toBlob returns a blob of the size we want to test against. */
function stubCanvas(outBytes: number | null) {
  const ctx = { imageSmoothingQuality: '', drawImage: vi.fn() };
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return document.createElementNS('http://www.w3.org/1999/xhtml', tag);
    return {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: (cb: (b: Blob | null) => void, type: string) => cb(outBytes === null ? null : new Blob([new Uint8Array(outBytes)], { type })),
    } as unknown as HTMLCanvasElement;
  }) as typeof document.createElement);
  return ctx;
}

beforeEach(() => stubDecode(4000, 3000));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shrinks a big camera photo and says it did', async () => {
  stubCanvas(400 * 1024);
  const out = await downscaleImage(makeFile('IMG_2291.JPG', 'image/jpeg', 6 * 1024 * 1024));
  expect(out.shrunk).toBe(true);
  expect(out.file.size).toBeLessThan(out.originalBytes);
  expect(out.originalBytes).toBe(6 * 1024 * 1024);
});

it('bounds the long edge at 2048, whatever the camera produced', async () => {
  const ctx = stubCanvas(400 * 1024);
  await downscaleImage(makeFile('big.jpg', 'image/jpeg', 6 * 1024 * 1024));
  // drawImage(bitmap, 0, 0, w, h) — the last two are the size actually drawn.
  const [, , , w, h] = ctx.drawImage.mock.calls[0] as unknown as [unknown, number, number, number, number];
  expect(Math.max(w, h)).toBe(2048);
  // 4000x3000 is 4:3 and must stay 4:3, or the product arrives distorted.
  expect(Math.round((w / h) * 100)).toBe(Math.round((4000 / 3000) * 100));
});

it('renames the file so the extension stops lying', async () => {
  stubCanvas(400 * 1024);
  const out = await downscaleImage(makeFile('shoe.jpeg', 'image/jpeg', 6 * 1024 * 1024));
  expect(out.file.name).toBe('shoe.jpg');
  expect(out.file.type).toBe('image/jpeg');
});

it('keeps a WebP a WebP rather than flattening the format', async () => {
  stubCanvas(400 * 1024);
  const out = await downscaleImage(makeFile('bag.webp', 'image/webp', 6 * 1024 * 1024));
  expect(out.file.type).toBe('image/webp');
  expect(out.file.name).toBe('bag.webp');
});

it('leaves a PNG alone, because re-encoding one fills its transparency with black', async () => {
  stubCanvas(100 * 1024);
  const file = new File([png], 'cutout.png', { type: 'image/png' });
  const out = await downscaleImage(file);
  expect(out.shrunk).toBe(false);
  expect(out.file).toBe(file);
});

it('leaves a small file alone — a second of a cheap phone to save 40KB is a bad trade', async () => {
  const file = makeFile('small.jpg', 'image/jpeg', 200 * 1024);
  const out = await downscaleImage(file);
  expect(out.shrunk).toBe(false);
  expect(out.file).toBe(file);
});

it('leaves an already-small image alone even when the file is heavy', async () => {
  stubDecode(1600, 1200);
  const file = makeFile('dense.jpg', 'image/jpeg', 5 * 1024 * 1024);
  const out = await downscaleImage(file);
  expect(out.shrunk).toBe(false);
  expect(out.file).toBe(file);
});

it('sends the original when the shrink barely saved anything', async () => {
  // A re-encode that wins 10% is not worth a generational quality loss.
  stubCanvas(Math.round(6 * 1024 * 1024 * 0.9));
  const file = makeFile('noisy.jpg', 'image/jpeg', 6 * 1024 * 1024);
  const out = await downscaleImage(file);
  expect(out.shrunk).toBe(false);
  expect(out.file).toBe(file);
});

it('sends the original when the decode throws, rather than failing the upload', async () => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      throw new Error('out of memory');
    }),
  );
  const file = makeFile('huge.jpg', 'image/jpeg', 9 * 1024 * 1024);
  const out = await downscaleImage(file);
  expect(out.shrunk).toBe(false);
  expect(out.file).toBe(file);
});

it('sends the original when the browser refuses to read the canvas back', async () => {
  stubCanvas(null);
  const file = makeFile('tainted.jpg', 'image/jpeg', 6 * 1024 * 1024);
  const out = await downscaleImage(file);
  expect(out.shrunk).toBe(false);
  expect(out.file).toBe(file);
});

it('sends the original on a browser with no createImageBitmap at all', async () => {
  vi.stubGlobal('createImageBitmap', undefined);
  const file = makeFile('old-browser.jpg', 'image/jpeg', 6 * 1024 * 1024);
  const out = await downscaleImage(file);
  expect(out.shrunk).toBe(false);
  expect(out.file).toBe(file);
});
