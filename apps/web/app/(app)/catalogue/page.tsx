'use client';
/**
 * Catalogue: the seller's store, read into the studio. Connect Shopify or
 * WooCommerce with a read-only credential, and every product arrives with
 * its pictures, name, price and description — then "Make something" opens
 * the studio already knowing the product. Syncs run on their own every few
 * hours; nothing is ever written back to the store.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type CatalogueProductView, type StoreKind, type StoreView } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { moneyMinor } from '@/lib/billing/money';
import { PageHeader } from '@/components/shell/Page';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Input, SegmentedControl, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './catalogue.module.css';

export const STORE_WORDS: Record<StoreKind, string> = { SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce' };
const ago = (iso: string | null) => {
  if (!iso) return 'not yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
};

export default function CataloguePage() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const router = useRouter();
  const canConnect = ['OWNER', 'ADMIN'].includes(workspace.role);
  const [stores, setStores] = useState<StoreView[] | null>(null);
  const [products, setProducts] = useState<CatalogueProductView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  const [storeFilter, setStoreFilter] = useState<string>('');
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState<StoreView | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<CatalogueProductView | null>(null);

  const loadStores = useCallback(async () => {
    try {
      const s = await api.catalogue.stores(workspace.id);
      setStores(Array.isArray(s) ? s : []);
    } catch {
      setStores((cur) => cur ?? []);
    }
  }, [workspace.id]);
  const loadProducts = useCallback(
    async (after?: string) => {
      try {
        const r = await api.catalogue.products(workspace.id, { q: q.trim() || undefined, storeId: storeFilter || undefined, cursor: after, take: 40 });
        setProducts((cur) => (after && cur ? [...cur, ...r.rows] : r.rows));
        setCursor(r.nextCursor);
      } catch {
        setProducts((cur) => cur ?? []);
      } finally {
        setMore(false);
      }
    },
    [workspace.id, q, storeFilter],
  );
  useEffect(() => {
    void loadStores();
  }, [loadStores]);
  useEffect(() => {
    const t = setTimeout(() => void loadProducts(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadProducts, q]);

  // A store that is being read: poll until it settles, then refresh the grid.
  const syncing = stores?.some((s) => s.syncing) ?? false;
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (!syncing) {
      if (wasSyncing.current) void loadProducts();
      wasSyncing.current = false;
      return;
    }
    wasSyncing.current = true;
    const t = setInterval(() => void loadStores(), 4000);
    return () => clearInterval(t);
  }, [syncing, loadStores, loadProducts]);

  const syncNow = async (s: StoreView) => {
    try {
      const r = await api.catalogue.sync(workspace.id, s.id);
      toast({ title: r.started ? `Reading ${s.label}…` : (r.reason ?? 'Already running'), tone: r.started ? 'ok' : 'warn' });
      void loadStores();
    } catch (e) {
      toast({ title: 'Could not start the sync', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const disconnect = async () => {
    if (!disconnecting) return;
    setBusy(true);
    try {
      await api.catalogue.disconnect(workspace.id, disconnecting.id);
      toast({ title: `${disconnecting.label} disconnected`, body: 'Its pictures stay in your library.', tone: 'ok' });
      setDisconnecting(null);
      await Promise.all([loadStores(), loadProducts()]);
    } catch (e) {
      toast({ title: 'Could not disconnect', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const makeFrom = (p: CatalogueProductView) => router.push(`/studio?product=${p.id}`);

  return (
    <div className="rise">
      <PageHeader
        title="Catalogue"
        lede="Your store, read into the studio. Every product arrives with its pictures, name, price and description, and stays in step on its own."
        actions={
          canConnect ? (
            <Button leading={<Icon.plus />} onClick={() => setConnectOpen(true)}>
              Connect a store
            </Button>
          ) : undefined
        }
      />

      <section className={styles.section} aria-labelledby="stores">
        <h2 id="stores">Stores</h2>
        {stores === null ? (
          <Skeleton height={72} />
        ) : stores.length === 0 ? (
          <div className={styles.connectEmpty}>
            <div>
              <strong>Nothing connected yet.</strong> Connect Shopify or WooCommerce with a read-only key and your products appear here in a minute or two.
              Nothing is ever written back to the store.
            </div>
            {canConnect && (
              <Button variant="subtle" onClick={() => setConnectOpen(true)}>
                Connect a store
              </Button>
            )}
          </div>
        ) : (
          <ul className={styles.stores}>
            {stores.map((s) => (
              <li key={s.id} className={styles.store} data-status={s.status}>
                <div className={styles.storeMark}>{STORE_WORDS[s.kind].slice(0, 1)}</div>
                <div className={styles.storeBody}>
                  <div className={styles.storeName}>
                    {s.label} <span className={styles.storeKind}>{STORE_WORDS[s.kind]}</span>
                    {s.status === 'NEEDS_ATTENTION' && <Badge tone="danger">Needs attention</Badge>}
                    {s.syncing && <Badge tone="cyan">Reading…</Badge>}
                  </div>
                  <div className={styles.storeMeta}>
                    {s.domain} · {s.productCount.toLocaleString()} product{s.productCount === 1 ? '' : 's'} · last read {ago(s.lastSyncAt)}
                  </div>
                  {s.lastError && <div className={styles.storeError}>{s.lastError}</div>}
                </div>
                <div className={styles.storeActions}>
                  <Button size="sm" variant="ghost" onClick={() => void syncNow(s)} disabled={s.syncing}>
                    Sync now
                  </Button>
                  {canConnect && (
                    <Button size="sm" variant="ghost" onClick={() => setDisconnecting(s)}>
                      Disconnect
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="products">
        <div className={styles.toolbar}>
          <h2 id="products">Products</h2>
          <div className={styles.filters}>
            {stores && stores.length > 1 && (
              <SegmentedControl
                label="Store"
                value={storeFilter}
                onChange={setStoreFilter}
                items={[{ id: '', label: 'All' }, ...stores.map((s) => ({ id: s.id, label: s.label }))]}
              />
            )}
            <Input
              aria-label="Search products"
              placeholder="Search by name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              leading={<Icon.library width={16} height={16} />}
            />
          </div>
        </div>
        {products === null ? (
          <div className={styles.grid}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} height={220} />
            ))}
          </div>
        ) : products.length === 0 ? (
          <EmptyState
            icon={<Icon.store />}
            title={q ? 'Nothing matches' : syncing ? 'Reading your store…' : 'No products yet'}
            body={
              q
                ? 'Try another word.'
                : syncing
                  ? 'Pictures are arriving. This takes a minute or two the first time.'
                  : 'Connect a store above and they will appear here.'
            }
          />
        ) : (
          <>
            <div className={styles.grid}>
              {products.map((p) => (
                <article key={p.id} className={styles.tile}>
                  <button type="button" className={styles.thumb} onClick={() => setDetail(p)} aria-label={`${p.title}: details`}>
                    {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : <span className={styles.noPic}>No picture</span>}
                  </button>
                  <div className={styles.tileBody}>
                    <div className={styles.tileTitle} title={p.title}>
                      {p.title}
                    </div>
                    <div className={styles.tileMeta}>
                      {p.priceMinor !== null && p.currency ? moneyMinor(p.priceMinor, p.currency) : '—'}
                      {p.images.length > 1 ? ` · ${p.images.length} pictures` : ''}
                    </div>
                  </div>
                  <Button size="sm" className={styles.make} onClick={() => makeFrom(p)} disabled={!p.thumbUrl}>
                    Make something
                  </Button>
                </article>
              ))}
            </div>
            {cursor && (
              <div className={styles.moreRow}>
                <Button
                  variant="ghost"
                  loading={more}
                  onClick={() => {
                    setMore(true);
                    void loadProducts(cursor);
                  }}
                >
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} workspaceId={workspace.id} onConnected={() => void loadStores()} />

      <ConfirmDialog
        open={disconnecting !== null}
        onClose={() => setDisconnecting(null)}
        onConfirm={() => void disconnect()}
        busy={busy}
        title={`Disconnect ${disconnecting?.label ?? 'this store'}?`}
        description="The key is forgotten and the products stop updating. Pictures already in your library stay, and so does everything you made from them."
        confirmLabel="Disconnect"
        danger
      />

      <Dialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.title ?? ''}
        description={detail ? `${STORE_WORDS[detail.store.kind]} · ${detail.store.label}` : undefined}
        wide
      >
        {detail && (
          <div className={styles.detail}>
            <div className={styles.detailPics}>
              {detail.images.map((i) => (
                <div key={i.key} className={styles.detailPic}>
                  {i.url ? <img src={i.url} alt="" /> : null}
                </div>
              ))}
            </div>
            <div className={styles.detailBody}>
              <div className={styles.detailPrice}>
                {detail.priceMinor !== null && detail.currency ? moneyMinor(detail.priceMinor, detail.currency) : 'No price'}
              </div>
              <p className={styles.detailDesc}>{detail.description || <em>No description in the store.</em>}</p>
              <div className={styles.detailActions}>
                <Button onClick={() => makeFrom(detail)} disabled={!detail.thumbUrl}>
                  Make something
                </Button>
                {detail.url && (
                  <Button variant="ghost" href={detail.url}>
                    Open in store
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** Connect a store with a read-only credential. The secret is sent once and never shown again. */
function ConnectDialog({ open, onClose, workspaceId, onConnected }: { open: boolean; onClose: () => void; workspaceId: string; onConnected: () => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<StoreKind>('SHOPIFY');
  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const [ck, setCk] = useState('');
  const [cs, setCs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setError(null);
      setToken('');
      setCk('');
      setCs('');
    }
  }, [open]);
  const ready = domain.trim().length > 2 && (kind === 'SHOPIFY' ? token.trim().length > 7 : ck.trim().length > 7 && cs.trim().length > 7);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.catalogue.connect(
        workspaceId,
        kind === 'SHOPIFY' ? { kind, domain, accessToken: token } : { kind, domain, consumerKey: ck, consumerSecret: cs },
      );
      toast({ title: `${s.label} connected`, body: 'Reading the products now — they will appear in a minute or two.', tone: 'ok' });
      onConnected();
      onClose();
      setDomain('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect a store"
      description="A read-only key. Products, pictures and prices are read in; nothing is written back."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void connect()} loading={busy} disabled={!ready}>
            Connect
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <SegmentedControl
          label="Platform"
          value={kind}
          onChange={setKind}
          items={[
            { id: 'SHOPIFY', label: 'Shopify' },
            { id: 'WOOCOMMERCE', label: 'WooCommerce' },
          ]}
        />
        {kind === 'SHOPIFY' ? (
          <>
            <Input label="Shop address" placeholder="acme.myshopify.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" />
            <Input
              label="Admin API access token"
              placeholder="shpat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              autoComplete="off"
              hint="Shopify admin → Settings → Apps and sales channels → Develop apps → Create app → give it the read_products scope → Install → reveal the token."
            />
          </>
        ) : (
          <>
            <Input label="Shop address" placeholder="https://shop.example" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" />
            <Input label="Consumer key" placeholder="ck_…" value={ck} onChange={(e) => setCk(e.target.value)} autoComplete="off" />
            <Input
              label="Consumer secret"
              placeholder="cs_…"
              value={cs}
              onChange={(e) => setCs(e.target.value)}
              type="password"
              autoComplete="off"
              hint="WordPress admin → WooCommerce → Settings → Advanced → REST API → Add key, permissions Read."
            />
          </>
        )}
        {error && (
          <div className={styles.formError} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
