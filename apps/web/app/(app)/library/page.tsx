'use client';
/**
 * The library: everything this workspace has made, findable again.
 *
 * Search is the first thing on the page because "that ankara photo from
 * last week" is how a seller thinks about their work. Type chips, a
 * starred filter and a products view narrow it; a card opens into every
 * output at every size, with the three things a person does next — use it
 * as a source, make a video from it, or make it again with changes.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/lib/app-context';
import { api, type LibraryItem, type LibraryProduct, type LibraryType } from '@/lib/api';
import { toolFor } from '@/lib/studio/useGenerations';
import { toolById } from '@/lib/studio/tools';
import { PageHeader } from '@/components/shell/Page';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Input, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './library.module.css';

const TYPES: Array<{ id: LibraryType; label: string }> = [{ id: 'all', label: 'Everything' }, { id: 'image', label: 'Photos' }, { id: 'video', label: 'Videos' }, { id: 'copy', label: 'Copy' }, { id: 'audio', label: 'Audio' }];
const TYPE_WORD: Record<string, string> = { image: 'Photo', video: 'Video', copy: 'Copy', audio: 'Audio' };
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export default function LibraryPage() { return <Suspense fallback={null}><Library /></Suspense>; }

function Library() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [type, setType] = useState<LibraryType>((params.get('type') as LibraryType) || 'all');
  const [starred, setStarred] = useState(params.get('starred') === '1');
  const [product, setProduct] = useState<string | null>(params.get('product'));
  const [view, setView] = useState<'items' | 'products'>(params.get('view') === 'products' ? 'products' : 'items');
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [products, setProducts] = useState<LibraryProduct[] | null>(null);
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const [remove, setRemove] = useState<LibraryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const req = useRef(0);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  // The URL carries the filters, so a search can be shared or refreshed.
  useEffect(() => {
    const u = new URLSearchParams();
    if (debounced) u.set('q', debounced);
    if (type !== 'all') u.set('type', type);
    if (starred) u.set('starred', '1');
    if (product) u.set('product', product);
    if (view === 'products') u.set('view', 'products');
    router.replace(`/library${u.size ? `?${u}` : ''}`, { scroll: false });
  }, [debounced, type, starred, product, view, router]);

  const load = useCallback(async (after?: string) => {
    const seq = ++req.current;
    try {
      const r = await api.library.list(workspace.id, { q: debounced || undefined, type, favourite: starred || undefined, product: product ?? undefined, cursor: after, take: 24 });
      if (seq !== req.current) return;
      setItems((cur) => (after && cur ? [...cur, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch (e) {
      if (seq === req.current) { setItems([]); toast({ title: 'Could not load the library', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    } finally { setMore(false); }
  }, [workspace.id, debounced, type, starred, product, toast]);

  useEffect(() => { setItems(null); void load(); }, [load]);
  useEffect(() => { if (view === 'products' && products === null) api.library.products(workspace.id).then(setProducts).catch(() => setProducts([])); }, [view, products, workspace.id]);

  const patch = async (item: LibraryItem, p: { title?: string | null; favourite?: boolean }) => {
    try {
      const u = await api.library.patch(workspace.id, item.id, p);
      setItems((cur) => cur?.map((i) => (i.id === u.id ? { ...i, ...u, outputs: i.outputs, params: i.params } : i)) ?? cur);
      setOpen((o) => (o && o.id === u.id ? { ...o, ...u, outputs: o.outputs, params: o.params } : o));
    } catch (e) { toast({ title: 'Could not save', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
  };
  const doRemove = async () => {
    if (!remove) return;
    setBusy(true);
    try { await api.library.remove(workspace.id, remove.id); setItems((cur) => cur?.filter((i) => i.id !== remove.id) ?? cur); setOpen(null); setRemove(null); toast({ title: 'Removed from the library', tone: 'ok' }); }
    catch (e) { toast({ title: 'Could not remove', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  // A link from the bell (`?open=<id>`) opens that item straight away.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open');
    if (!id) return;
    api.library.get(workspace.id, id).then(setOpen).catch(() => undefined);
    window.history.replaceState(null, '', '/library');
  }, [workspace.id]);

  const openItem = async (item: LibraryItem) => {
    setOpen(item);
    try { setOpen(await api.library.get(workspace.id, item.id)); } catch { /* the list's copy still shows */ }
  };
  const again = (item: LibraryItem) => {
    try { sessionStorage.setItem('anystudio:prefill', JSON.stringify({ toolId: toolFor(item.capability), params: item.params ?? {} })); } catch { /* fine */ }
    const u = new URLSearchParams({ tool: toolFor(item.capability) });
    // A video the tool brought itself is prefilled into its panel, not put on the canvas.
    const ownsSource = toolById(toolFor(item.capability)).fields.some((f) => f.kind === 'file' && f.key === 'sourceKey');
    if (item.sourceKey && !ownsSource) u.set('source', item.sourceKey);
    router.push(`/studio?${u}`);
  };

  const productTitle = useMemo(() => products?.find((p) => p.productKey === product)?.title ?? product, [products, product]);

  return (
    <div className="rise">
      <PageHeader title="Library" lede="Everything you have made, searchable, in every size it was exported in." actions={<Button href="/studio" leading={<Icon.plus />}>Make something</Button>} />

      <div className={styles.bar}>
        <div className={styles.search}><Input placeholder="Search by product, words in the prompt, or the copy itself" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" /></div>
        <div className={styles.chips} role="group" aria-label="Type">
          {TYPES.map((t) => <button key={t.id} type="button" className={styles.chip} aria-pressed={type === t.id && view === 'items'} onClick={() => { setType(t.id); setView('items'); }}>{t.label}</button>)}
          <button type="button" className={styles.chip} aria-pressed={starred} onClick={() => setStarred((s) => !s)}>★ Starred</button>
          <button type="button" className={styles.chip} aria-pressed={view === 'products'} onClick={() => setView((v) => (v === 'products' ? 'items' : 'products'))}>Products</button>
        </div>
      </div>
      {product && <div className={styles.crumb}>Showing <strong>{productTitle}</strong> <Button variant="link" size="sm" onClick={() => setProduct(null)}>Show everything</Button></div>}

      {view === 'products' ? (
        products === null ? <div className={styles.grid}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={200} />)}</div> : products.length === 0 ? (
          <EmptyState icon={<Icon.library />} title="No products yet" body="Give a product a name when you make something and it shows up here with everything made for it." />
        ) : (
          <div className={styles.grid}>
            {products.map((p) => (
              <button key={p.productKey} type="button" className={styles.card} onClick={() => { setProduct(p.productKey); setView('items'); setType('all'); }}>
                <span className={styles.thumb}>{p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : <Icon.library />}</span>
                <span className={styles.cardBody}><span className={styles.cardTitle}>{p.title ?? p.productKey}</span><span className={styles.cardMeta}>{p.count} item{p.count === 1 ? '' : 's'} · last {when(p.lastAt)}</span></span>
              </button>
            ))}
          </div>
        )
      ) : items === null ? (
        <div className={styles.grid}>{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={220} />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Icon.library />} title={debounced || type !== 'all' || starred || product ? 'Nothing matches' : 'Nothing here yet'} body={debounced ? `No photos, videos or copy mention “${debounced}”. Search looks at product names, prompts and the words in your copy.` : 'Your first generation will appear here, with every size it was exported in.'} actions={debounced || type !== 'all' || starred || product ? <Button variant="ghost" onClick={() => { setQ(''); setType('all'); setStarred(false); setProduct(null); }}>Clear filters</Button> : <Button href="/studio">Open the studio</Button>} />
      ) : (
        <>
          <div className={styles.grid}>
            {items.map((item) => (
              <div key={item.id} className={styles.card} data-type={item.type}>
                <button type="button" className={styles.thumb} onClick={() => void openItem(item)} aria-label={`Open ${item.title ?? TYPE_WORD[item.type]}`}>
                  {item.thumbUrl ? <img src={item.thumbUrl} alt="" loading="lazy" /> : item.type === 'copy' ? <span className={styles.copyThumb}>{excerpt(item.text)}</span> : item.type === 'audio' ? <span className={styles.audioThumb}><Icon.music width={28} height={28} /><span>{excerpt(item.text).slice(0, 80)}</span></span> : <Icon.library />}
                  {item.type === 'video' && <span className={styles.play} aria-hidden="true">▶</span>}
                </button>
                <div className={styles.cardBody}>
                  <div className={styles.cardTitle}><span>{item.title ?? TYPE_WORD[item.type]}</span><button type="button" className={styles.star} aria-pressed={item.favourite} aria-label={item.favourite ? 'Unstar' : 'Star'} onClick={() => void patch(item, { favourite: !item.favourite })}>{item.favourite ? '★' : '☆'}</button></div>
                  <div className={styles.cardMeta}><Badge mono>{TYPE_WORD[item.type]}</Badge> {when(item.createdAt)} · {item.credits} cr</div>
                </div>
              </div>
            ))}
          </div>
          {cursor && <div className={styles.more}><Button variant="subtle" loading={more} onClick={() => { setMore(true); void load(cursor); }}>Show more</Button></div>}
        </>
      )}

      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open ? <TitleEditor item={open} onSave={(t) => void patch(open, { title: t })} /> : ''} wide
        footer={open ? <>
          <Button variant="ghost" onClick={() => setRemove(open)}>Remove</Button>
          <span style={{ flex: 1 }} />
          {open.type === 'image' && open.outputs.find((o) => o.role === 'image') && <Button variant="subtle" onClick={() => router.push(`/studio?source=${encodeURIComponent(open.outputs.find((o) => o.role === 'image')!.key)}`)}>Use as source</Button>}
          {open.type === 'image' && open.outputs.find((o) => o.role === 'image') && <Button variant="subtle" onClick={() => router.push(`/studio?tool=video&source=${encodeURIComponent(open.outputs.find((o) => o.role === 'image')!.key)}`)}>Make a video</Button>}
          <Button onClick={() => again(open)}>Make again</Button>
        </> : undefined}>
        {open && <ItemDetail item={open} workspaceId={workspace.id} />}
      </Dialog>

      <ConfirmDialog open={remove !== null} onClose={() => setRemove(null)} onConfirm={() => void doRemove()} busy={busy} title="Remove from the library?" description="It disappears from every list. The credits it cost are not refunded — it was made. Support can bring it back for a while if you change your mind." confirmLabel="Remove" danger />
    </div>
  );
}

function TitleEditor({ item, onSave }: { item: LibraryItem; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(item.title ?? '');
  useEffect(() => { setV(item.title ?? ''); }, [item.title]);
  if (!editing) return <span className={styles.titleRow}><span>{item.title ?? TYPE_WORD[item.type]}</span><Button variant="link" size="sm" onClick={() => setEditing(true)}>Rename</Button></span>;
  return (
    <form className={styles.titleRow} onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); setEditing(false); }}>
      <Input value={v} onChange={(e) => setV(e.target.value)} maxLength={120} autoFocus aria-label="Title" />
      <Button size="sm" type="submit">Save</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setV(item.title ?? ''); }}>Cancel</Button>
    </form>
  );
}

function ItemDetail({ item, workspaceId }: { item: LibraryItem; workspaceId: string }) {
  const files = item.outputs.filter((o) => o.role !== 'text' && !o.locked);
  const image = item.outputs.find((o) => o.role === 'image');
  const video = item.outputs.find((o) => o.role === 'video');
  const track = item.outputs.find((o) => o.role === 'audio' && !o.locked) ?? item.outputs.find((o) => o.role === 'preview');
  const lockedTrack = item.outputs.some((o) => o.role === 'audio' && o.locked);
  return (
    <div className={styles.detail}>
      <div className={styles.preview}>
        {video ? <video src={video.url ?? item.previewUrl ?? undefined} controls playsInline preload="metadata" />
          : image ? <img src={image.url ?? item.previewUrl ?? undefined} alt={item.title ?? ''} />
            : track ? (
              <div className={styles.audioBox}>
                <Icon.library width={32} height={32} />
                <audio src={track.url ?? item.previewUrl ?? undefined} controls preload="metadata" style={{ width: '100%' }} />
                {lockedTrack && <span className={styles.cardMeta} style={{ whiteSpace: 'normal' }}>This is the 30-second preview. Unlock the full song from the studio result, or make it again.</span>}
              </div>
            ) : item.text ? <CopyText text={item.text} /> : <span className={styles.cardMeta}>No preview</span>}
      </div>
      <div className={styles.side}>
        <div className={styles.meta}>
          <span><Badge mono>{TYPE_WORD[item.type]}</Badge></span>
          <span>{new Date(item.createdAt).toLocaleString()}</span>
          <span>{item.credits} credits</span>
          {item.productKey && <span>Product: {item.productKey}</span>}
        </div>
        {files.length > 0 && (
          <div className={styles.files}>
            <div className={styles.filesHead}><span>Files</span><a className={styles.dl} href={api.library.downloadUrl(workspaceId, item.id)}>Download all (.zip)</a></div>
            {files.map((o) => (
              <a key={o.key} className={styles.file} href={o.url ?? '#'} download target="_blank" rel="noreferrer" aria-disabled={!o.url}>
                <span>{o.size ? o.size.replace('_', ' ') : o.role}</span>
                <span className={styles.cardMeta}>{o.width && o.height ? `${o.width}×${o.height}` : ''}{o.durationMs ? `${Math.round(o.durationMs / 1000)}s` : ''} {o.bytes ? `· ${(o.bytes / 1_000_000).toFixed(1)} MB` : ''}</span>
              </a>
            ))}
          </div>
        )}
        {item.text && (image || video) ? <CopyText text={item.text} compact /> : null}
      </div>
    </div>
  );
}

function CopyText({ text, compact }: { text: unknown; compact?: boolean }) {
  const fields = flatten(text);
  const { toast } = useToast();
  return (
    <div className={styles.copy} data-compact={compact || undefined}>
      {fields.map(([k, v]) => (
        <div key={k} className={styles.copyField}>
          <div className={styles.copyHead}><span>{k}</span><Button variant="link" size="sm" onClick={() => { void navigator.clipboard?.writeText(v); toast({ title: 'Copied', tone: 'ok' }); }}>Copy</Button></div>
          <p>{v}</p>
        </div>
      ))}
    </div>
  );
}

function flatten(v: unknown, prefix = ''): Array<[string, string]> {
  if (typeof v === 'string') return [[prefix || 'text', v]];
  if (Array.isArray(v)) return [[prefix || 'items', v.map(String).join('\n')]];
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => flatten(x, prefix ? `${prefix} · ${k}` : k));
  return [];
}
function excerpt(text: unknown): string {
  const first = flatten(text).find(([, v]) => v.length > 20)?.[1] ?? flatten(text)[0]?.[1] ?? '';
  return first.slice(0, 140);
}
