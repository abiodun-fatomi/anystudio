/**
 * A folder of photos, and the three ways it goes wrong.
 *
 * Ordering, patience and forgiveness — each of these is something a merchant
 * on a phone tether will hit within their first real catalogue, and none of
 * them is visible until they do.
 */
import { describe, expect, it, vi } from 'vitest';
import { inHumanOrder, isPhoto, uploadMany } from './folder';

const file = (name: string, type = 'image/jpeg') => new File([new Uint8Array([1, 2, 3])], name, { type });

vi.mock('@/lib/upload', () => ({
  uploadFile: vi.fn(async (_ws: string, f: File) => {
    // One file in every catalogue is a screenshot, a duplicate, or corrupt.
    if (f.name.includes('bad')) throw new Error('Storage refused the upload (413).');
    // Uploads finish out of order; that must not reorder the batch.
    await new Promise((r) => setTimeout(r, f.name.length % 3));
    return { id: `a-${f.name}`, key: `ws/${f.name}`, mime: 'image/jpeg' };
  }),
}));

describe('what counts as a photo', () => {
  it('takes what a phone or a camera puts in a folder', () => {
    for (const n of ['IMG_1.jpg', 'a.jpeg', 'b.PNG', 'c.webp', 'd.heic', 'e.heif', 'f.avif']) expect(isPhoto(file(n, '')), n).toBe(true);
  });

  it('leaves the rest of the folder alone', () => {
    for (const n of ['notes.txt', 'video.mp4', '.DS_Store', 'prices.xlsx']) expect(isPhoto(file(n, '')), n).toBe(false);
  });
});

describe('the order a person would put them in', () => {
  it('sorts numbers as numbers, so photo 9 comes before photo 10', () => {
    const names = inHumanOrder([file('IMG_10.jpg'), file('IMG_9.jpg'), file('IMG_100.jpg'), file('IMG_2.jpg')]).map((f) => f.name);
    expect(names).toEqual(['IMG_2.jpg', 'IMG_9.jpg', 'IMG_10.jpg', 'IMG_100.jpg']);
  });

  it('does not care about capitals, because a camera and a phone disagree about them', () => {
    expect(inHumanOrder([file('dress-B.jpg'), file('dress-a.jpg')]).map((f) => f.name)).toEqual(['dress-a.jpg', 'dress-B.jpg']);
  });
});

describe('uploading a folder', () => {
  it('keeps the dropped order even though the uploads finish out of order', async () => {
    const out = await uploadMany('ws', [file('IMG_2.jpg'), file('IMG_10.jpg'), file('IMG_1.jpg')], 10);
    expect(out.added.map((a) => a.key)).toEqual(['ws/IMG_1.jpg', 'ws/IMG_2.jpg', 'ws/IMG_10.jpg']);
  });

  it('loses one bad file, never the rest of the shoot', async () => {
    const out = await uploadMany('ws', [file('a.jpg'), file('bad.jpg'), file('c.jpg')], 10);
    expect(out.added).toHaveLength(2);
    expect(out.failed).toEqual([{ name: 'bad.jpg', reason: 'Storage refused the upload (413).' }]);
  });

  it('does not spend a merchant’s data on photos the batch has no room for', async () => {
    const out = await uploadMany('ws', [file('1.jpg'), file('2.jpg'), file('3.jpg'), file('4.jpg')], 2);
    expect(out.added).toHaveLength(2);
    expect(out.skipped).toBe(2);
  });

  it('ignores everything in the folder that is not a photo', async () => {
    const out = await uploadMany('ws', [file('a.jpg'), file('notes.txt', 'text/plain'), file('clip.mp4', 'video/mp4')], 10);
    expect(out.added).toHaveLength(1);
    expect(out.skipped).toBe(0);
  });

  it('reports its way through so a slow upload does not look frozen', async () => {
    const seen: string[] = [];
    await uploadMany('ws', [file('a.jpg'), file('b.jpg')], 10, (done, total, name) => seen.push(`${done}/${total} ${name}`));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/^2\/2 /);
  });

  it('does nothing at all when there is no room left', async () => {
    const out = await uploadMany('ws', [file('a.jpg')], 0);
    expect(out.added).toHaveLength(0);
    expect(out.skipped).toBe(1);
  });
});
