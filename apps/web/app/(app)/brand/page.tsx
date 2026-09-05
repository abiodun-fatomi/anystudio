'use client';
/**
 * Brand — the kit every image and caption picks up automatically.
 *
 * The preview on the right is the same badge the worker composites, drawn
 * live from the fields, so what is saved is what will be on the images.
 * Palette swatches warn when a colour would not carry white text: the price
 * pill is white on the primary colour, and a pale primary makes it
 * unreadable.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type BrandKitRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { PageHeader } from '@/components/shell/Page';
import { Button, Input, Select, Skeleton, Switch, Textarea, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { SIZE_OPTIONS } from '@/lib/studio/tools';
import styles from './brand.module.css';
import studio from '../studio/studio.module.css';

const FONTS = ['Bricolage Grotesque', 'Hanken Grotesk', 'Inter', 'Playfair Display', 'DM Serif Display', 'Space Grotesk', 'Nunito', 'Lora'];

/** WCAG contrast of white text on a hex colour. Under 3 is unreadable on a price pill. */
function whiteContrast(hex: string): number {
  const c = hex.replace('#', '');
  const ch = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  return 1.05 / (L + 0.05);
}

export default function BrandPage() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const [kit, setKit] = useState<BrandKitRow | null>(null);
  const [draft, setDraft] = useState<Partial<BrandKitRow>>({});
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    api.brand
      .get(workspace.id)
      .then(async (k) => {
        if (!live) return;
        setKit(k);
        if (k.logoKey) {
          const { urls } = await api.media.urls(workspace.id, [k.logoKey]);
          if (live) setLogoUrl(urls[k.logoKey] ?? null);
        }
      })
      .catch(() => {
        if (live) setKit({ workspaceId: workspace.id, empty: true });
      });
    return () => {
      live = false;
    };
  }, [workspace.id]);

  const v = { ...kit, ...draft } as BrandKitRow;
  const set = <K extends keyof BrandKitRow>(k: K, val: BrandKitRow[K]) => setDraft((d) => ({ ...d, [k]: val }));
  const dirty = Object.keys(draft).length > 0;
  const palette = v.palette ?? [];
  const primary = palette[0] ?? '#D6006E';
  const sizes = new Set(v.defaultSizes ?? ['feed_square', 'story']);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await api.brand.patch(workspace.id, draft);
      setKit(saved);
      setDraft({});
      setSavedAt(Date.now());
      toast({ title: 'Brand kit saved', body: 'Every new image and caption uses it.', tone: 'ok' });
    } catch (err) {
      toast({ title: 'Could not save', body: err instanceof ApiError ? err.message : 'Try again in a moment.', tone: 'danger' });
    } finally {
      setSaving(false);
    }
  }, [workspace.id, draft, toast]);

  const pickLogo = async (file: File) => {
    setUploading(true);
    try {
      const asset = await uploadFile(workspace.id, file);
      const { urls } = await api.media.urls(workspace.id, [asset.key]);
      setLogoUrl(urls[asset.key] ?? null);
      set('logoKey', asset.key);
    } catch (err) {
      toast({ title: 'Logo not uploaded', body: err instanceof Error ? err.message : 'Try a PNG with a transparent background.', tone: 'danger' });
    } finally {
      setUploading(false);
    }
  };

  if (!kit)
    return (
      <div className="rise">
        <PageHeader title="Brand" />
        <Skeleton height={320} />
      </div>
    );

  return (
    <div className="rise">
      <PageHeader
        title="Brand"
        lede="Your name, logo, colours and tone — applied to every image and caption automatically."
        actions={
          <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
            Save
          </Button>
        }
      />
      <div className={styles.layout}>
        <div className={styles.form}>
          <section className={styles.group}>
            <div>
              <div className={styles.groupTitle}>Name and logo</div>
              <div className={styles.groupLede}>The logo replaces the name on images when both exist.</div>
            </div>
            <Input
              label="Business name"
              value={v.businessName ?? ''}
              onChange={(e) => set('businessName', e.target.value)}
              placeholder="Bimbo Fabrics"
              maxLength={80}
            />
            <div className={styles.logoRow}>
              <div className={styles.logoBox}>{logoUrl ? <img src={logoUrl} alt="Your logo" /> : <Icon.brand />}</div>
              <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
                <Button variant="ghost" size="sm" loading={uploading} onClick={() => fileInput.current?.click()}>
                  {logoUrl ? 'Replace logo' : 'Upload a logo'}
                </Button>
                {v.logoKey && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      set('logoKey', null);
                      setLogoUrl(null);
                    }}
                  >
                    Remove
                  </Button>
                )}
                <span className={styles.groupLede}>PNG with a transparent background works best.</span>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickLogo(f);
                  e.target.value = '';
                }}
              />
            </div>
          </section>

          <section className={styles.group}>
            <div>
              <div className={styles.groupTitle}>Colours</div>
              <div className={styles.groupLede}>The first colour is the price pill. It needs to carry white text.</div>
            </div>
            <div className={styles.swatches}>
              {palette.map((c, i) => {
                const ratio = whiteContrast(c);
                return (
                  <div key={i} className={styles.swatch}>
                    <div className={styles.swatchColor} style={{ background: c }}>
                      <input
                        type="color"
                        value={c}
                        aria-label={`Colour ${i + 1}`}
                        onChange={(e) => {
                          const n = [...palette];
                          n[i] = e.target.value.toUpperCase();
                          set('palette', n);
                        }}
                      />
                    </div>
                    <span className={`${styles.swatchLabel} ${i === 0 && ratio < 3 ? styles.swatchWarn : ''}`}>{i === 0 && ratio < 3 ? 'too pale' : c}</span>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() =>
                        set(
                          'palette',
                          palette.filter((_, j) => j !== i),
                        )
                      }
                      aria-label={`Remove colour ${i + 1}`}
                    >
                      ×
                    </Button>
                  </div>
                );
              })}
              {palette.length < 6 && (
                <button
                  type="button"
                  className={styles.addSwatch}
                  aria-label="Add a colour"
                  onClick={() => set('palette', [...palette, palette.length === 0 ? '#D6006E' : '#17131A'])}
                >
                  <Icon.plus />
                </button>
              )}
            </div>
          </section>

          <section className={styles.group}>
            <div>
              <div className={styles.groupTitle}>Type and tone</div>
              <div className={styles.groupLede}>Fonts shape flyers and end cards; tone shapes every caption.</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 'var(--s-4)' }}>
              <Select
                label="Display font"
                options={FONTS.map((f) => ({ value: f, label: f }))}
                value={v.fontDisplay ?? 'Bricolage Grotesque'}
                onChange={(e) => set('fontDisplay', e.target.value)}
              />
              <Select
                label="Body font"
                options={FONTS.map((f) => ({ value: f, label: f }))}
                value={v.fontBody ?? 'Hanken Grotesk'}
                onChange={(e) => set('fontBody', e.target.value)}
              />
            </div>
            <Textarea
              label="Tone of voice"
              optional
              hint="Two or three words, or a sentence. The copywriter reads this."
              placeholder="Warm and direct. No slang. We speak to busy mums."
              rows={2}
              maxLength={300}
              showCount
              value={v.tone ?? ''}
              onChange={(e) => set('tone', e.target.value)}
            />
          </section>

          <section className={styles.group}>
            <div>
              <div className={styles.groupTitle}>On every image</div>
            </div>
            <Switch
              label="Show the price"
              hint="When one is given for the image"
              checked={v.showPrice ?? true}
              onChange={(e) => set('showPrice', e.target.checked)}
            />
            <Switch
              label="Watermark"
              hint="A small “made on studo” in the corner"
              checked={Boolean(v.watermark?.enabled)}
              onChange={(e) => set('watermark', { ...(v.watermark ?? {}), enabled: e.target.checked })}
            />
            <div>
              <span className={studio.fieldLabel}>Default export sizes</span>
              <div className={studio.chips} role="group" aria-label="Default export sizes">
                {SIZE_OPTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={studio.chip}
                    aria-pressed={sizes.has(s.id)}
                    onClick={() => {
                      const n = new Set(sizes);
                      if (n.has(s.id)) n.delete(s.id);
                      else n.add(s.id);
                      set('defaultSizes', [...n]);
                    }}
                    title={s.label}
                  >
                    {s.short}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <div className={styles.saveBar}>
            {savedAt && !dirty && <span className={styles.saved}>Saved</span>}
            <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
              Save brand kit
            </Button>
          </div>
        </div>

        <aside className={styles.preview} aria-label="Preview">
          <span className={styles.previewTitle}>How it lands on an image</span>
          <div className={styles.previewImg}>
            <div className={styles.previewProduct} />
            {(v.showPrice ?? true) && (
              <div className={styles.previewPrice} style={{ background: primary }}>
                ₦12,000
              </div>
            )}
            {logoUrl ? (
              <img className={styles.previewLogo} src={logoUrl} alt="" />
            ) : v.businessName ? (
              <div className={styles.previewName}>{v.businessName}</div>
            ) : null}
            {v.watermark?.enabled && <div className={styles.previewMark}>made on studo</div>}
          </div>
          <span className={styles.groupLede}>
            Price pill in your first colour, logo or name bottom right, watermark top right. The product is never touched.
          </span>
        </aside>
      </div>
    </div>
  );
}
