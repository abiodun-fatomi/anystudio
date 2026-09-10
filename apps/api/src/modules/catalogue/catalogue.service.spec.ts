/**
 * Catalogue sync: domains are normalised and refused when unsafe, HTML
 * becomes copy the writer can use, and a sync claims its row once, keeps
 * the pictures it already has, fetches only new ones, and retires what the
 * store no longer lists.
 */
import { describe, expect, it, vi } from 'vitest';
import { CatalogueService } from './catalogue.service';
import { shopifyDomain } from './connectors/shopify';
import { plainText, toMinor, StoreError, type RemoteProduct } from './connectors/types';
import { wooOrigin } from './connectors/woocommerce';
import { encrypt } from '../../utils/crypto/encrypt';

describe('connector helpers', () => {
  it('normalises shop addresses and refuses what is not a shop', () => {
    expect(shopifyDomain('Acme')).toBe('acme.myshopify.com');
    expect(shopifyDomain('https://acme-store.myshopify.com/admin')).toBe('acme-store.myshopify.com');
    expect(() => shopifyDomain('shop.example.com')).toThrow(StoreError);
    expect(wooOrigin('shop.example')).toBe('https://shop.example');
    expect(wooOrigin('https://shop.example/store/')).toBe('https://shop.example/store');
    expect(() => wooOrigin('http://shop.example')).toThrow(StoreError);
    expect(() => wooOrigin('https://192.168.1.4')).toThrow(StoreError);
    expect(() => wooOrigin('https://localhost')).toThrow(StoreError);
  });

  it('turns a store description into plain text and a price into minor units', () => {
    expect(plainText('<p>Soft <strong>cotton</strong>&nbsp;tote.</p><ul><li>40cm</li><li>Navy &amp; cream</li></ul>')).toBe(
      'Soft cotton tote.\n40cm\nNavy & cream',
    );
    expect(plainText('   ')).toBeNull();
    expect(toMinor('12.50', 'NGN')).toBe(1250);
    expect(toMinor('1200', 'UGX')).toBe(1200);
    expect(toMinor('', 'USD')).toBeNull();
  });
});

function harness() {
  process.env.APP_KEY = Buffer.alloc(32, 9).toString('base64');
  const store: Record<string, unknown> & { id: string } = {
    id: 's1',
    workspaceId: 'w1',
    kind: 'SHOPIFY',
    label: 'Acme',
    domain: 'acme.myshopify.com',
    credentialsEnc: encrypt(JSON.stringify({ accessToken: 'shpat_x' })),
    status: 'CONNECTED',
    lastError: null,
    lastSyncAt: null,
    nextSyncAt: new Date(0),
    syncingSince: null,
    productCount: 0,
    connectedById: 'u1',
    disconnectedAt: null,
    createdAt: new Date(),
  };
  const products: Array<Record<string, unknown> & { id: string; externalId: string; active: boolean; images: Array<{ src: string; key: string }> }> = [
    { id: 'p1', storeId: 's1', workspaceId: 'w1', externalId: '100', title: 'Old tote', active: true, images: [{ src: 'https://cdn/old.jpg', key: 'w1/old' }] },
    { id: 'p2', storeId: 's1', workspaceId: 'w1', externalId: '200', title: 'Gone hat', active: true, images: [] },
  ];
  const ingested: string[] = [];
  const db = {
    storeConnection: {
      updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== store.id || store.syncingSince) return { count: 0 };
        store.syncingSince = new Date();
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...store })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(store, data)),
    },
    catalogueProduct: {
      findUnique: vi.fn(
        async ({ where }: { where: { storeId_externalId: { externalId: string } } }) =>
          products.find((p) => p.externalId === where.storeId_externalId.externalId) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(
          products.find((p) => p.id === where.id)!,
          data,
        ),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `p${products.length + 1}`, ...data } as (typeof products)[number];
        products.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { externalId: { notIn: string[] } }; data: { active: boolean } }) => {
        const hit = products.filter((p) => p.active && !where.externalId.notIn.includes(p.externalId));
        for (const p of hit) p.active = data.active;
        return { count: hit.length };
      }),
      count: vi.fn(async () => products.filter((p) => p.active).length),
    },
  };
  const media = {
    ingestUrl: vi.fn(async (_w: string, _u: string | null, url: string) => {
      ingested.push(url);
      return { key: `w1/${ingested.length}` };
    }),
    readUrls: vi.fn(async () => ({})),
  };
  const notifications = { notifyWorkspace: vi.fn(async () => undefined) };
  const svc = new CatalogueService(db as never, media as never, notifications as never);
  const remote: RemoteProduct[] = [
    {
      externalId: '100',
      handle: 'old-tote',
      title: 'Old tote',
      description: 'Still here',
      priceMinor: 1200,
      currency: null,
      url: null,
      imageUrls: ['https://cdn/old.jpg', 'https://cdn/old-2.jpg'],
      active: true,
      updatedAt: null,
    },
    {
      externalId: '300',
      handle: 'new-cap',
      title: 'New cap',
      description: null,
      priceMinor: 500,
      currency: null,
      url: null,
      imageUrls: ['https://cdn/cap.jpg'],
      active: true,
      updatedAt: null,
    },
  ];
  (svc as unknown as { connectors: Record<string, unknown> }).connectors.SHOPIFY = {
    probe: vi.fn(async () => ({ name: 'Acme', currency: 'NGN', domain: 'acme.myshopify.com' })),
    products: async function* () {
      yield remote;
    },
  };
  return { svc, store, products, ingested, notifications };
}

describe('sync', () => {
  it('keeps known pictures, fetches new ones, retires the missing, and notifies on the first read', async () => {
    const h = harness();
    expect(await h.svc.sync('s1')).toBe(true);
    expect(h.ingested).toEqual(['https://cdn/old-2.jpg', 'https://cdn/cap.jpg']);
    const old = h.products.find((p) => p.externalId === '100')!;
    expect(old.images).toEqual([
      { src: 'https://cdn/old.jpg', key: 'w1/old' },
      { src: 'https://cdn/old-2.jpg', key: 'w1/1' },
    ]);
    expect(old.currency).toBe('NGN');
    expect(old.productKey).toBe('old-tote');
    expect(h.products.find((p) => p.externalId === '200')!.active).toBe(false);
    expect(h.products.find((p) => p.externalId === '300')).toBeTruthy();
    expect(h.store.status).toBe('CONNECTED');
    expect(h.store.productCount).toBe(2);
    expect(h.store.syncingSince).toBeNull();
    expect(h.store.lastSyncAt).toBeInstanceOf(Date);
    expect(h.notifications.notifyWorkspace).toHaveBeenCalledTimes(1);
  });

  it('is claimed once', async () => {
    const h = harness();
    h.store.syncingSince = new Date();
    expect(await h.svc.sync('s1')).toBe(false);
  });

  it('marks a refused credential as needing attention with the hint, and a slow store as merely retried', async () => {
    const h = harness();
    (h.svc as unknown as { connectors: Record<string, unknown> }).connectors.SHOPIFY = {
      probe: vi.fn(async () => {
        throw new StoreError('http 401', true, 'Shopify refused the token.');
      }),
      products: async function* () {
        yield [];
      },
    };
    await h.svc.sync('s1');
    expect(h.store.status).toBe('NEEDS_ATTENTION');
    expect(h.store.lastError).toBe('Shopify refused the token.');

    const h2 = harness();
    (h2.svc as unknown as { connectors: Record<string, unknown> }).connectors.SHOPIFY = {
      probe: vi.fn(async () => {
        throw new StoreError('timeout', false, 'Shopify did not answer.');
      }),
      products: async function* () {
        yield [];
      },
    };
    await h2.svc.sync('s1');
    expect(h2.store.status).toBe('CONNECTED');
    expect(h2.store.nextSyncAt).toBeInstanceOf(Date);
  });
});
