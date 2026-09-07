/**
 * The layout arithmetic, on its own.
 *
 * A collage is one of the few things in the product where a bug is silent:
 * nothing throws, the picture just looks wrong. So the rectangles are worked
 * out by a pure function and asserted here — every cell inside the frame,
 * every gap the same, nothing overlapping, every photo given a place.
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { autoLayout, collagePipeline, planCells, type Cell } from './collage';
import { collageLayoutsFor, COLLAGE_LAYOUTS } from '@anystudio/shared';

const W = 1440;
const H = 1440;
const G = 20;

const overlaps = (a: Cell, b: Cell): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('planCells', () => {
  const layouts = ['grid', 'hero', 'row', 'stack', 'before_after'] as const;

  it('gives every photo a rectangle, inside the frame, that touches no other', () => {
    for (const layout of layouts) {
      const counts = layout === 'before_after' ? [2] : layout === 'row' || layout === 'stack' ? [2, 3, 4] : layout === 'hero' ? [3, 5, 7, 9] : [2, 4, 5, 9];
      for (const n of counts) {
        const cells = planCells(layout, n, W, H, G);
        expect(cells, `${layout} ${n}`).toHaveLength(n);
        for (const c of cells) {
          expect(c.w, `${layout} ${n} width`).toBeGreaterThan(0);
          expect(c.h, `${layout} ${n} height`).toBeGreaterThan(0);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x + c.w).toBeLessThanOrEqual(W);
          expect(c.y + c.h).toBeLessThanOrEqual(H);
        }
        for (let i = 0; i < cells.length; i++)
          for (let j = i + 1; j < cells.length; j++) expect(overlaps(cells[i]!, cells[j]!), `${layout} ${n}: ${i} overlaps ${j}`).toBe(false);
      }
    }
  });

  it('leaves the same border around the collage as between the photos', () => {
    const cells = planCells('grid', 4, W, H, G);
    const left = Math.min(...cells.map((c) => c.x));
    const right = W - Math.max(...cells.map((c) => c.x + c.w));
    const top = Math.min(...cells.map((c) => c.y));
    const bottom = H - Math.max(...cells.map((c) => c.y + c.h));
    for (const edge of [left, right, top, bottom]) expect(Math.abs(edge - G)).toBeLessThanOrEqual(1);
  });

  it('fills the frame edge to edge when the gap is zero', () => {
    const cells = planCells('row', 3, W, H, 0);
    expect(Math.min(...cells.map((c) => c.x))).toBe(0);
    expect(Math.max(...cells.map((c) => c.x + c.w))).toBe(W);
    expect(cells.every((c) => c.h === H)).toBe(true);
  });

  it('gives the lead photo the most room, and never a sliver to the rest', () => {
    for (const n of [3, 5, 9]) {
      const [hero, ...rest] = planCells('hero', n, W, H, G);
      const area = (c: Cell) => c.w * c.h;
      for (const r of rest) expect(area(hero!), `hero ${n}`).toBeGreaterThan(area(r));
      // Nothing in the strip is thinner than a thumbnail: a 30px-tall photo is a bug, not a design.
      for (const r of rest) expect(r.h, `hero ${n} strip height`).toBeGreaterThan(H * 0.08);
    }
  });

  it('centres a short last row instead of leaving a hole in the corner', () => {
    // Five photos on a 3-wide grid: the last two sit in the middle.
    const cells = planCells('grid', 5, W, H, G);
    const lastRow = cells.slice(3);
    expect(lastRow).toHaveLength(2);
    const leftGap = Math.min(...lastRow.map((c) => c.x));
    const rightGap = W - Math.max(...lastRow.map((c) => c.x + c.w));
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);
  });

  it('never lets an absurd gap swallow the photos', () => {
    const cells = planCells('grid', 4, W, H, 9999);
    expect(cells.every((c) => c.w > 0 && c.h > 0)).toBe(true);
  });
});

describe('autoLayout', () => {
  it('reads two photos across in a wide frame and down in a tall one', () => {
    expect(autoLayout(2, '1:1')).toBe('row');
    expect(autoLayout(2, '16:9')).toBe('row');
    expect(autoLayout(2, '9:16')).toBe('stack');
  });

  it('puts four and nine on an even grid and the awkward counts behind a lead photo', () => {
    expect(autoLayout(4, '1:1')).toBe('grid');
    expect(autoLayout(9, '1:1')).toBe('grid');
    for (const n of [5, 6, 7, 8]) expect(autoLayout(n, '1:1')).toBe('hero');
  });

  it('only ever picks a layout that can hold that many photos', () => {
    for (let n = 2; n <= 9; n++) {
      for (const aspect of ['1:1', '9:16', '16:9', '4:5', '3:4']) {
        const picked = autoLayout(n, aspect);
        expect(collageLayoutsFor(n), `${n} photos, ${aspect}`).toContain(picked);
      }
    }
  });
});

describe('the layouts offered', () => {
  it('always leaves the seller a choice, whatever they picked', () => {
    for (let n = 2; n <= 9; n++) expect(collageLayoutsFor(n).length, `${n} photos`).toBeGreaterThan(1);
  });

  it('offers before-and-after for two photos and nothing else', () => {
    expect(collageLayoutsFor(2)).toContain('before_after');
    for (let n = 3; n <= 9; n++) expect(collageLayoutsFor(n)).not.toContain('before_after');
  });

  it('describes every arrangement, so the panel never shows a blank hint', () => {
    for (const [key, l] of Object.entries(COLLAGE_LAYOUTS)) {
      expect(l.label.length, key).toBeGreaterThan(0);
      expect(l.note.length, key).toBeGreaterThan(0);
      expect(l.min).toBeLessThanOrEqual(l.max);
    }
  });
});

/**
 * The whole pipeline, for real: sharp actually composites, so a broken SVG
 * or a bad rectangle fails here rather than in someone's feed. The photos
 * are served from a throwaway server because the pipeline fetches its
 * inputs by signed URL, exactly as the worker does.
 */
describe('collagePipeline', () => {
  it('lays real photos out, labels them, brands them and cuts every size', async () => {
    const photo = async (colour: { r: number; g: number; b: number }) =>
      sharp({ create: { width: 800, height: 600, channels: 3, background: colour } })
        .jpeg()
        .toBuffer();
    const bodies = [await photo({ r: 220, g: 40, b: 90 }), await photo({ r: 40, g: 120, b: 220 }), await photo({ r: 40, g: 200, b: 120 })];
    const server = createServer((req, res) => {
      const i = Number(new URL(req.url ?? '/', 'http://x').pathname.slice(1));
      const body = bodies[i];
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const stages: string[] = [];
      const ctx = {
        row: {
          id: 'gen-1',
          workspaceId: 'ws-1',
          input: {
            sourceKeys: ['ws/a.jpg', 'ws/b.jpg', 'ws/c.jpg'],
            layout: 'hero',
            aspect: '1:1',
            gap: 14,
            background: '#FFFFFF',
            rounded: true,
            labels: ['Before', '', 'After'],
            sizes: ['feed_square', 'story'],
            price: '₦12,000',
            businessName: 'Ada Fabrics',
          },
        },
        brandKit: null,
        files: Object.fromEntries(bodies.map((_, i) => [`sourceKeys[${i}]`, { url: `http://127.0.0.1:${port}/${i}`, mime: 'image/jpeg' }])),
        log: { info: () => undefined, warn: () => undefined },
        stage: async (_s: string, _p: number, detail?: string) => void stages.push(detail ?? ''),
      };
      const out = await collagePipeline(ctx as never);

      expect(out.costMinor).toBe(0);
      expect(out.providerKey).toBe('local:sharp');
      // The sheet, then one file per size asked for.
      expect(out.artifacts.map((a) => a.role)).toEqual(['image', 'variant', 'variant']);
      const sheet = out.artifacts[0]!;
      expect(sheet.width).toBe(1440);
      expect(sheet.height).toBe(1440);
      const meta = await sharp(Buffer.from(sheet.bytes!)).metadata();
      expect(meta.width).toBe(1440);
      expect(meta.height).toBe(1440);
      expect(out.artifacts[1]!.width).toBe(1080);
      expect(out.artifacts[2]!.height).toBe(1920);
      expect(stages.some((s) => s.includes('3 photos'))).toBe(true);
    } finally {
      server.close();
    }
  }, 30_000);

  it('keeps going when one photo will not open, rather than losing the others', async () => {
    const good = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 10, b: 10 } } })
      .png()
      .toBuffer();
    const server = createServer((req, res) => {
      if (req.url === '/bad') {
        res.writeHead(200, { 'content-type': 'image/jpeg' }).end('not an image');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(good.length) }).end(good);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const warnings: unknown[] = [];
    try {
      const ctx = {
        row: {
          id: 'g',
          workspaceId: 'w',
          input: { sourceKeys: ['a', 'b'], layout: 'row', aspect: '1:1', gap: 10, background: '#FFFFFF', rounded: false, labels: [], sizes: [] },
        },
        brandKit: null,
        files: {
          'sourceKeys[0]': { url: `http://127.0.0.1:${port}/ok`, mime: 'image/png' },
          'sourceKeys[1]': { url: `http://127.0.0.1:${port}/bad`, mime: 'image/jpeg' },
        },
        log: { info: () => undefined, warn: (o: unknown) => void warnings.push(o) },
        stage: async () => undefined,
      };
      const out = await collagePipeline(ctx as never);
      expect(out.artifacts).toHaveLength(1);
      expect(warnings).toHaveLength(1);
    } finally {
      server.close();
    }
  }, 30_000);

  it('refuses only when not one photo could be read', async () => {
    const ctx = {
      row: {
        id: 'g',
        workspaceId: 'w',
        input: { sourceKeys: ['a', 'b'], layout: 'row', aspect: '1:1', gap: 10, background: '#FFFFFF', rounded: false, labels: [], sizes: [] },
      },
      brandKit: null,
      files: {},
      log: { info: () => undefined, warn: () => undefined },
      stage: async () => undefined,
    };
    await expect(collagePipeline(ctx as never)).rejects.toThrow(/none of the photos/);
  });
});
