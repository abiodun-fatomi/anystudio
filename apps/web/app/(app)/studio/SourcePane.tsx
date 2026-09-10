'use client';
/**
 * SOURCE — drop, paste or pick. Uploads go straight to storage with a
 * progress bar each; a rejected file says why in one line, and the recent
 * uploads below are what "use as source" and "pick from library" pick from.
 * Each one can be taken away again — a wrong upload should not sit in the
 * strip forever — which removes it from the library too.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, type CatalogueProductView, type MediaAssetRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { Button, ConfirmDialog, Dialog, Input, Progress, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

interface Pending {
  id: string;
  name: string;
  pct: number;
  /** Kept on failure so one click can send it again. */
  file?: File;
  error?: string;
}

export function SourcePane({
  selected,
  onSelect,
  onProduct,
  onRemoved,
  refreshKey,
}: {
  selected: string | null;
  onSelect: (asset: MediaAssetRow) => void;
  /** A product picked from the catalogue: the page takes its picture and its words. */
  onProduct?: (product: CatalogueProductView) => void;
  /** A photo is gone; the page drops it from the canvas if it was showing. */
  onRemoved?: (asset: MediaAssetRow) => void;
  refreshKey: number;
}) {
  const { workspace } = useApp();
  const { toast } = useToast();
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [recent, setRecent] = useState<MediaAssetRow[] | null>(null);
  const [removing, setRemoving] = useState<MediaAssetRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  // A placeholder only where something will replace it: a new account has no
  // recent photos, and three shimmering squares that vanish read as a glitch.
  // How many there were last time is remembered per workspace.
  const [expected, setExpected] = useState(0);
  useEffect(() => {
    try {
      setExpected(Math.min(3, Number(sessionStorage.getItem(`anystudio:recent-sources:${workspace.id}`) ?? 0)));
    } catch {
      /* fine */
    }
  }, [workspace.id]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const rows = await api.media.list(workspace.id, { kind: 'SOURCE', take: 18 });
      setRecent(rows);
      try {
        sessionStorage.setItem(`anystudio:recent-sources:${workspace.id}`, String(rows.length));
      } catch {
        /* fine */
      }
      if (rows.length) {
        const { urls: u } = await api.media.urls(
          workspace.id,
          rows.map((r) => r.key),
        );
        setUrls((prev) => ({ ...prev, ...u }));
      }
    } catch {
      setRecent([]);
    }
  }, [workspace.id]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /** One upload, by id, so a failed one can be sent again under the same row. */
  const send = useCallback(
    async (id: string, file: File) => {
      setPending((p) =>
        p.some((x) => x.id === id) ? p.map((x) => (x.id === id ? { ...x, pct: 0, error: undefined } : x)) : [...p, { id, name: file.name, pct: 0 }],
      );
      try {
        const asset = await uploadFile(workspace.id, file, (p) => setPending((ps) => ps.map((x) => (x.id === id ? { ...x, pct: p.pct } : x))));
        setPending((ps) => ps.filter((x) => x.id !== id));
        const { urls: u } = await api.media.urls(workspace.id, [asset.key]);
        setUrls((prev) => ({ ...prev, ...u }));
        setRecent((r) => [asset, ...(r ?? []).filter((x) => x.id !== asset.id)]);
        onSelect(asset);
      } catch (err) {
        setPending((ps) => ps.map((x) => (x.id === id ? { ...x, file, error: err instanceof Error ? err.message : 'Upload failed' } : x)));
      }
    },
    [workspace.id, onSelect],
  );

  const accept = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|jpe?g|png|webp)$/i.test(f.name));
      if (list.length === 0) return;
      for (const file of list) await send(crypto.randomUUID(), file);
    },
    [send],
  );

  // Paste a screenshot straight in.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) void accept(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [accept]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void accept(e.dataTransfer.files);
  };

  const doRemove = async () => {
    const asset = removing;
    if (!asset) return;
    setRemoveBusy(true);
    try {
      await api.media.remove(workspace.id, asset.id);
      setRecent((r) => {
        const next = (r ?? []).filter((x) => x.id !== asset.id);
        try {
          sessionStorage.setItem(`anystudio:recent-sources:${workspace.id}`, String(next.length));
        } catch {
          /* fine */
        }
        return next;
      });
      setRemoving(null);
      onRemoved?.(asset);
      toast({ title: 'Photo removed', tone: 'ok' });
    } catch (err) {
      toast({ title: 'Could not remove the photo', body: err instanceof Error ? err.message : 'Try again in a moment.', tone: 'danger' });
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <section className={`${styles.pane} ${styles.source}`} aria-label="Source">
      <div className={styles.paneHead}>
        <span className={styles.paneTitle}>Source</span>
      </div>
      <div className={styles.paneBody}>
        <div
          role="button"
          tabIndex={0}
          className={styles.drop}
          data-over={over || undefined}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              input.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          aria-label="Add a product photo"
        >
          <span className={styles.dropIcon}>
            <Icon.plus />
          </span>
          <strong>Add a product photo</strong>
          <span>Drop it here, paste it, or tap to choose. JPG, PNG, WebP or HEIC up to 25 MB.</span>
        </div>
        {onProduct && (
          <button type="button" className={styles.fromCatalogue} onClick={() => setPicker(true)}>
            <Icon.store width={16} height={16} />
            <span>
              <strong>Or start from your catalogue</strong>
              <span>A product from your store, with its name, price and details filled in.</span>
            </span>
          </button>
        )}
        {onProduct && (
          <CataloguePicker
            open={picker}
            onClose={() => setPicker(false)}
            workspaceId={workspace.id}
            onPick={(p) => {
              setPicker(false);
              onProduct(p);
            }}
          />
        )}
        <input
          ref={input}
          type="file"
          accept="image/*,.heic"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void accept(e.target.files);
            e.target.value = '';
          }}
        />

        {pending.length > 0 && (
          <div className={styles.uploads} aria-live="polite">
            {pending.map((p) => (
              <div key={p.id} className={styles.upload}>
                <Icon.library width={16} height={16} />
                <div>
                  <div className={styles.uploadName}>{p.name}</div>
                  {p.error ? (
                    <>
                      <div className={styles.uploadErr}>{p.error}</div>
                      <div className={styles.uploadRetry}>
                        {p.file && (
                          <Button size="sm" onClick={() => void send(p.id, p.file!)}>
                            Try again
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setPending((ps) => ps.filter((x) => x.id !== p.id))}>
                          Remove
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Progress value={p.pct} label={p.pct < 100 ? 'Uploading' : 'Checking'} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {recent === null && expected > 0 && (
          <div className={styles.recent}>
            {Array.from({ length: expected }, (_, i) => (
              <Skeleton key={i} style={{ aspectRatio: '1' }} />
            ))}
          </div>
        )}
        {recent && recent.length > 0 && (
          <div className={styles.recent} role="listbox" aria-label="Recent photos">
            {recent.map((a) => (
              <div key={a.id} className={styles.thumbWrap} data-selected={a.key === selected || undefined}>
                <button
                  type="button"
                  role="option"
                  aria-selected={a.key === selected}
                  aria-pressed={a.key === selected}
                  className={styles.thumb}
                  onClick={() => onSelect(a)}
                  title={a.filename ?? 'Photo'}
                >
                  {urls[a.key] ? (
                    <img src={urls[a.key]} alt={a.filename ?? 'Uploaded photo'} loading="lazy" />
                  ) : (
                    <Skeleton style={{ width: '100%', height: '100%' }} />
                  )}
                </button>
                <button
                  type="button"
                  className={styles.thumbRemove}
                  aria-label={`Remove ${a.filename ?? 'photo'}`}
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemoving(a);
                  }}
                >
                  <Icon.x width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          if (!removeBusy) setRemoving(null);
        }}
        onConfirm={() => void doRemove()}
        busy={removeBusy}
        title="Remove this photo?"
        description={`${removing?.filename ?? 'The photo'} leaves the studio and the library. Anything already made from it stays.`}
        confirmLabel="Remove"
        danger
      />
    </section>
  );
}

/** Search the catalogue and pick one product. Only products with a picture can be started from. */
function CataloguePicker({
  open,
  onClose,
  workspaceId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  onPick: (p: CatalogueProductView) => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CatalogueProductView[] | null>(null);
  const [stores, setStores] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.catalogue
      .stores(workspaceId)
      .then((s) => live && setStores(Array.isArray(s) ? s.length : 0))
      .catch(() => live && setStores(0));
    return () => {
      live = false;
    };
  }, [open, workspaceId]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows(null);
    const t = setTimeout(
      () => {
        api.catalogue
          .products(workspaceId, { q: q.trim() || undefined, take: 60 })
          .then((r) => live && setRows(r.rows))
          .catch(() => live && setRows([]));
      },
      q ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, workspaceId, q]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start from a product"
      description="Its first picture goes on the canvas; its name, price and details go into every tool."
      wide
    >
      {stores === 0 ? (
        <div className={styles.pickerEmpty}>
          <p>No store is connected yet. Connect Shopify or WooCommerce and your products appear here.</p>
          <Button href="/catalogue" variant="subtle">
            Open Catalogue
          </Button>
        </div>
      ) : (
        <div className={styles.picker}>
          <Input aria-label="Search products" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          {rows === null ? (
            <div className={styles.pickerGrid}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} style={{ aspectRatio: '1' }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className={styles.pickerEmpty}>{q ? 'Nothing matches.' : 'No products yet — the store may still be syncing.'}</p>
          ) : (
            <div className={styles.pickerGrid}>
              {rows.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={styles.pickerTile}
                  onClick={() => onPick(p)}
                  disabled={!p.images.some((i) => i.key)}
                  title={p.title}
                >
                  <span className={styles.pickerThumb}>{p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : null}</span>
                  <span className={styles.pickerTitle}>{p.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
