'use client';
/**
 * SOURCE — drop, paste or pick. Uploads go straight to storage with a
 * progress bar each; a rejected file says why in one line, and the recent
 * uploads below are what "use as source" and "pick from library" pick from.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, type MediaAssetRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { Progress, Skeleton } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

interface Pending {
  id: string;
  name: string;
  pct: number;
  error?: string;
}

export function SourcePane({ selected, onSelect, refreshKey }: { selected: string | null; onSelect: (asset: MediaAssetRow) => void; refreshKey: number }) {
  const { workspace } = useApp();
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [recent, setRecent] = useState<MediaAssetRow[] | null>(null);
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

  const accept = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|jpe?g|png|webp)$/i.test(f.name));
      if (list.length === 0) return;
      for (const file of list) {
        const id = crypto.randomUUID();
        setPending((p) => [...p, { id, name: file.name, pct: 0 }]);
        try {
          const asset = await uploadFile(workspace.id, file, (p) => setPending((ps) => ps.map((x) => (x.id === id ? { ...x, pct: p.pct } : x))));
          setPending((ps) => ps.filter((x) => x.id !== id));
          const { urls: u } = await api.media.urls(workspace.id, [asset.key]);
          setUrls((prev) => ({ ...prev, ...u }));
          setRecent((r) => [asset, ...(r ?? []).filter((x) => x.id !== asset.id)]);
          onSelect(asset);
        } catch (err) {
          setPending((ps) => ps.map((x) => (x.id === id ? { ...x, error: err instanceof Error ? err.message : 'Upload failed' } : x)));
        }
      }
    },
    [workspace.id, onSelect],
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
                  {p.error ? <div className={styles.uploadErr}>{p.error}</div> : <Progress value={p.pct} label={p.pct < 100 ? 'Uploading' : 'Checking'} />}
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
              <button
                key={a.id}
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
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
