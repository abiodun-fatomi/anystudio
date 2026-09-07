'use client';
/**
 * The tool's controls, the quote, and the one button.
 *
 * The quote is shown before anything is committed: what it costs, what the
 * balance will be after. Out of credits is a conversion moment, not an
 * error — the panel says what this would cost and offers the two ways to
 * fix it, and the button stays visible but disabled so the intent is kept.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, type DubLanguages, type Genre, type Idea, type IdeasOut, type MediaAssetRow, type Quote } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { voicesCache } from '@/lib/studio/voices-cache';
import { PLATFORM_OPTIONS, SIZE_OPTIONS, missingFor, type Field, type Tool } from '@/lib/studio/tools';
import { PRESENTERS, PRESET_GROUPS, PRODUCT_MODES, PRODUCT_MODE_KEYS, presetsIn, type PhotoPreset, type PresetGroup } from '@anystudio/shared';
import { Button, Combobox, Input, Progress, SegmentedControl, Select, Skeleton, Slider, Switch, Textarea } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

const BUTTON_LABEL: Record<string, string> = {
  copy: 'Write it',
  music: 'Make the song',
  voice: 'Record it',
  translate: 'Translate it',
  lipsync: 'Sync it',
  collage: 'Put them together',
};

export function ToolPanel({
  tool,
  values,
  onChange,
  hasSource,
  sourceKey,
  onGenerate,
  busy,
}: {
  tool: Tool;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  hasSource: boolean;
  /** The photo on the canvas, for the ideas the copy model proposes. */
  sourceKey?: string | null;
  onGenerate: (quote: Quote) => void;
  busy: boolean;
}) {
  const { workspace, balance, postpaid } = useApp();
  const [quote, setQuote] = useState<Quote | null>(null);
  const costCode = tool.costCodeFor?.(values);
  // A tool whose capability depends on the chosen look must quote the one it
  // will actually send — otherwise "Plain white" shows the price of a scene.
  const capability = tool.capabilityFor?.(values) ?? tool.capability;
  useEffect(() => {
    let live = true;
    setQuote(null);
    api.generations
      .quote(workspace.id, capability, costCode)
      .then((q) => {
        if (live) setQuote(q);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace.id, capability, costCode]);

  const credits = quote?.credits ?? null;
  const after = credits !== null && balance !== null ? balance - credits : null;
  const short = after !== null && after < 0;
  const missing = missingFor(tool, values);
  const blocked = busy || !quote || short || (tool.needsSource && !hasSource) || Boolean(missing);
  const why = !hasSource && tool.needsSource ? 'Add a photo first.' : (missing ?? (short ? 'Not enough credits.' : null));
  const label = BUTTON_LABEL[tool.id] ?? (tool.id === 'video' ? (Number(values.shots) > 1 ? 'Make the ad' : 'Make the reel') : 'Make it');

  return (
    <section className={`${styles.pane}`} aria-label={`${tool.label} settings`}>
      <div className={styles.paneBody}>
        <div className={styles.panel}>
          <div>
            <div className={styles.panelTitle}>{tool.label}</div>
            <div className={styles.panelLede}>{quote ? `${quote.label} · ${quote.credits} credits · about ${Math.round(quote.expectedMs / 1000)}s` : ' '}</div>
          </div>

          <div className={styles.fields}>
            {tool.fields
              .filter((f) => !f.showIf || f.showIf(values))
              .map((f) => (
                <Fragment key={f.key}>
                  <FieldControl
                    field={f}
                    value={values[f.key]}
                    values={values}
                    onChange={(v) => onChange(f.key, v)}
                    onFill={(params) => {
                      for (const [k, v] of Object.entries(params)) onChange(k, v);
                    }}
                  />
                  {tool.ideas && tool.ideas.under === f.key && (
                    <Ideas tool={tool} values={values} sourceKey={sourceKey ?? null} onPick={(idea) => pickIdea(tool, values, idea, onChange)} />
                  )}
                </Fragment>
              ))}
          </div>

          <div className={styles.quote} data-short={short || undefined} aria-live="polite">
            <div className={styles.quoteRow}>
              <span>This will cost</span>
              <strong>{credits ?? '—'} credits</strong>
            </div>
            <div className={styles.quoteRow}>
              <span>Balance after</span>
              <strong>{after === null ? '—' : after.toLocaleString()}</strong>
            </div>
            {short && (
              <div className={styles.quoteNote}>
                {postpaid ? (
                  <>
                    That is {(-after!).toLocaleString()} past the credit line. <a href="/billing">See billing</a> to pay an open invoice or ask for more room.
                  </>
                ) : (
                  <>
                    You need {(-after!).toLocaleString()} more. <a href="/billing/plans">Top up</a> or <a href="/billing">see your plan</a>.
                  </>
                )}
              </div>
            )}
            {!short && <div className={styles.quoteNote}>If it fails, the credits come straight back.</div>}
          </div>

          <div className={styles.generate}>
            <Button full size="lg" loading={busy} disabled={blocked} onClick={() => quote && onGenerate(quote)} title={why ?? undefined}>
              {label}
            </Button>
            {why && (
              <p className={styles.quoteNote} style={{ marginTop: 'var(--s-2)', textAlign: 'center' }}>
                {why}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Phone: the cost and the button stay in thumb reach. */}
      <div className={styles.generateBar}>
        <span className={styles.quoteInline}>
          <strong>{credits === null ? tool.label : `${credits} credits`}</strong>
          <span>{why ?? (after === null ? 'The cost shows once it can be priced' : `${after.toLocaleString()} after`)}</span>
        </span>
        <Button loading={busy} disabled={blocked} onClick={() => quote && onGenerate(quote)}>
          {label}
        </Button>
      </div>
    </section>
  );
}

/** Genres, voices and dub languages come from the server; the first option is chosen when nothing is. */
type Option = { value: string; label: string; sub?: string; keywords?: string };
const catalogueCache: { genres?: Promise<Genre[]>; languages?: Promise<DubLanguages> } = {};
const EMPTY_HINT: Record<string, string> = {
  voices: 'No voice vendor is configured in this environment yet.',
  myVoices: 'You have not recorded your voice yet. Settings → Your voice takes a minute.',
  languages: 'No dubbing vendor is configured in this environment yet.',
  sourceLanguages: 'No dubbing vendor is configured in this environment yet.',
  genres: 'The catalogue is empty.',
};
function CatalogueField({ field, value, onChange }: { field: Extract<Field, { kind: 'catalogue' }>; value: string; onChange: (v: unknown) => void }) {
  const { workspace } = useApp();
  const [options, setOptions] = useState<Option[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const done = (o: Option[]) => {
      if (live) setOptions(o);
    };
    const fail = () => {
      if (live) setOptions([]);
    };
    if (field.source === 'genres') {
      catalogueCache.genres ??= api.audio.genres();
      catalogueCache.genres
        .then((gs) =>
          done(
            gs.map((g) => ({
              value: g.key,
              label: g.name,
              sub: `${g.region} · ${g.description}`,
              keywords: `${g.family} ${g.region} ${g.languages.join(' ')}`,
            })),
          ),
        )
        .catch(fail);
    } else if (field.source === 'voices' || field.source === 'myVoices') {
      // The workspace's own voices ride along with the catalogue; the "myVoices" pick shows only those.
      voicesCache[workspace.id] ??= api.audio.workspaceVoices(workspace.id).then((r) => r.voices);
      voicesCache[workspace.id]!.then((all) => {
        const vs = field.source === 'myVoices' ? all.filter((v) => v.mine) : all;
        done(
          vs.map((v) => ({
            value: v.key,
            label: v.mine ? `${v.name} (yours)` : v.name,
            sub: [v.accent ? `${v.accent} ${v.language.startsWith('en') ? 'English' : v.language}` : v.language, v.gender, ...v.tags]
              .filter(Boolean)
              .join(' · '),
            keywords: `${v.language} ${v.accent ?? ''} ${v.gender ?? ''} ${v.tags.join(' ')} ${v.provider} ${v.mine ? 'mine yours my voice' : ''}`,
          })),
        );
      }).catch(fail);
    } else {
      catalogueCache.languages ??= api.audio.dubLanguages();
      catalogueCache.languages
        .then((d) => {
          if (field.source === 'sourceLanguages') done(d.sources.map((l) => ({ value: l.code, label: l.name })));
          else {
            done(
              d.languages.map((l) => ({
                value: l.code,
                label: l.name,
                sub: l.lipsync ? `${l.region} · lips can be matched` : l.region,
                keywords: `${l.region} ${l.code}`,
              })),
            );
            if (live) setNote(d.missing);
          }
        })
        .catch(fail);
    }
    return () => {
      live = false;
    };
  }, [field.source, workspace.id]);
  useEffect(() => {
    if (!value && options?.[0]) onChange(options[0].value);
  }, [value, options, onChange]);
  if (options && options.length === 0) return <Input label={field.label} value="" readOnly hint={EMPTY_HINT[field.source]} />;
  if (field.source === 'sourceLanguages')
    return (
      <Select
        label={field.label}
        options={(options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <Combobox
      label={field.label}
      hint={note ?? field.hint}
      options={options ?? []}
      value={value}
      onChange={onChange}
      placeholder={options ? 'Search…' : 'Loading…'}
      emptyText={
        field.source === 'languages' ? 'Nothing matches — try a region or a country' : "Nothing matches — try a region or a word like 'church' or 'club'"
      }
    />
  );
}

/**
 * A video or audio file for the tool, uploaded straight to storage from the
 * panel. The param holds the storage key; the field shows the name, the
 * progress, and a small player once it is in.
 */
function FileField({ field, value, onChange }: { field: Extract<Field, { kind: 'file' }>; value: string; onChange: (v: unknown) => void }) {
  const { workspace } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const accept =
    field.accept === 'video'
      ? 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm'
      : field.accept === 'image'
        ? 'image/jpeg,image/png,image/webp,image/heic,.jpg,.jpeg,.png,.webp,.heic'
        : 'audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/x-m4a,.mp3,.m4a,.wav,.ogg';

  // A key that arrived without a file (a "do it again", a prefill) still gets its player.
  useEffect(() => {
    let live = true;
    if (!value) {
      setUrl(null);
      return;
    }
    api.media
      .urls(workspace.id, [value])
      .then(({ urls }) => {
        if (live) setUrl(urls[value] ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace.id, value]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setName(file.name);
    setPct(0);
    try {
      const asset = await uploadFile(workspace.id, file, (p) => setPct(p.pct));
      setPct(null);
      onChange(asset.key);
    } catch (err) {
      setPct(null);
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  return (
    <div>
      <span className={styles.fieldLabel}>{field.label}</span>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {value && url ? (
        <div className={styles.fileIn}>
          {field.accept === 'video' ? (
            <video src={url} controls playsInline preload="metadata" />
          ) : field.accept === 'image' ? (
            <img src={url} alt="" className={styles.fileImg} />
          ) : (
            <audio src={url} controls preload="metadata" />
          )}
          <div className={styles.fileRow}>
            <span className={styles.fileName}>{name ?? 'Your file'}</span>
            <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>
              Change
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.fileDrop}
          onClick={() => input.current?.click()}
          disabled={pct !== null}
          aria-label={field.label}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void pick(e.dataTransfer.files?.[0]);
          }}
        >
          <span className={styles.dropIcon}>{field.accept === 'video' ? <Icon.film /> : <Icon.mic />}</span>
          {pct !== null ? (
            <div style={{ width: '100%' }}>
              <div className={styles.uploadName}>{name}</div>
              <Progress value={pct} label={pct < 100 ? 'Uploading' : 'Checking'} />
            </div>
          ) : (
            <>
              <strong>{value ? 'Loading your file…' : `Add ${field.accept === 'video' ? 'a video' : 'an audio file'}`}</strong>
              <span>{error ?? field.hint ?? 'Drop it here or tap to choose.'}</span>
            </>
          )}
        </button>
      )}
      {error && value && <div className={styles.uploadErr}>{error}</div>}
    </div>
  );
}

/**
 * Several photos, in the order they are tapped.
 *
 * The order is the whole point of the control: the number on a thumbnail is
 * where that photo lands in the collage, so tapping is both "use this" and
 * "put it here". Tapping a chosen photo again takes it out and closes the
 * gap. New photos can be added from the device without leaving the panel —
 * an upload goes straight to the end of the list, which is what someone
 * photographing a batch expects.
 */
function PhotosField({ field, value, onChange }: { field: Extract<Field, { kind: 'photos' }>; value: string[]; onChange: (v: unknown) => void }) {
  const { workspace } = useApp();
  const [rows, setRows] = useState<MediaAssetRow[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const chosen = value.filter(Boolean);

  const load = useCallback(async () => {
    try {
      const list = await api.media.list(workspace.id, { kind: 'SOURCE', take: 30 });
      setRows(list);
      if (list.length) {
        const { urls: u } = await api.media.urls(
          workspace.id,
          list.map((r) => r.key),
        );
        setUrls((prev) => ({ ...prev, ...u }));
      }
    } catch {
      setRows([]);
    }
  }, [workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  // A key that arrived without the strip having loaded it — a "do it again",
  // a prefill — still needs a picture to show.
  useEffect(() => {
    const unknown = chosen.filter((k) => !urls[k]);
    if (unknown.length === 0) return;
    let live = true;
    api.media
      .urls(workspace.id, unknown)
      .then(({ urls: u }) => {
        if (live) setUrls((prev) => ({ ...prev, ...u }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace.id, chosen.join(','), urls]);

  const toggle = (key: string) => {
    const at = chosen.indexOf(key);
    if (at >= 0) onChange(chosen.filter((k) => k !== key));
    else if (chosen.length < field.max) onChange([...chosen, key]);
  };

  const upload = async (files: FileList | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith('image/') || /\.(heic|jpe?g|png|webp)$/i.test(f.name));
    if (list.length === 0) return;
    setError(null);
    const added: string[] = [];
    for (const file of list) {
      if (chosen.length + added.length >= field.max) break;
      try {
        setPct(0);
        const asset = await uploadFile(workspace.id, file, (p) => setPct(p.pct));
        added.push(asset.key);
        setRows((r) => [asset, ...(r ?? []).filter((x) => x.id !== asset.id)]);
        const { urls: u } = await api.media.urls(workspace.id, [asset.key]);
        setUrls((prev) => ({ ...prev, ...u }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      }
    }
    setPct(null);
    if (added.length) onChange([...chosen, ...added]);
  };

  const full = chosen.length >= field.max;
  return (
    <div>
      <span className={styles.fieldLabel}>
        {field.label}
        <span className={styles.photoCount}>
          {chosen.length} of {field.max}
          {chosen.length < field.min ? ` · ${field.min} minimum` : ''}
        </span>
      </span>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files).finally(() => (e.target.value = ''))} />
      {rows === null ? (
        <Skeleton style={{ height: 132 }} />
      ) : (
        <div className={styles.photoGrid} role="group" aria-label={field.label}>
          <button type="button" className={styles.photoAdd} onClick={() => input.current?.click()} disabled={pct !== null || full}>
            {pct !== null ? <Progress value={pct} label="" /> : <Icon.plus />}
            <span>{full ? 'Full' : pct !== null ? 'Adding…' : 'Add'}</span>
          </button>
          {rows.map((r) => {
            const at = chosen.indexOf(r.key);
            return (
              <button
                key={r.id}
                type="button"
                className={styles.photoTile}
                aria-pressed={at >= 0}
                disabled={at < 0 && full}
                onClick={() => toggle(r.key)}
                title={at >= 0 ? `Photo ${at + 1} — tap to take it out` : full ? `${field.max} is the most that fits` : 'Add to the collage'}
              >
                {urls[r.key] ? <img src={urls[r.key]} alt="" loading="lazy" /> : <span className={styles.photoBlank} />}
                {at >= 0 && <span className={styles.photoNum}>{at + 1}</span>}
              </button>
            );
          })}
        </div>
      )}
      <span className={styles.fieldHint}>{error ?? field.hint}</span>
    </div>
  );
}

/** One short line per photo picked, in the same order, each next to its thumbnail so there is no counting. */
function PhotoLabelsField({
  field,
  value,
  keys,
  onChange,
}: {
  field: Extract<Field, { kind: 'photoLabels' }>;
  value: string[];
  keys: string[];
  onChange: (v: unknown) => void;
}) {
  const { workspace } = useApp();
  const [urls, setUrls] = useState<Record<string, string>>({});
  // The keys themselves, not the array's identity: the panel rebuilds this
  // array on every keystroke, and refetching the same thumbnails each time
  // would be a request per letter typed.
  const joined = keys.join(',');
  useEffect(() => {
    const wanted = joined ? joined.split(',') : [];
    if (wanted.length === 0) return;
    let live = true;
    api.media
      .urls(workspace.id, wanted)
      .then(({ urls: u }) => {
        if (live) setUrls(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace.id, joined]);
  if (keys.length === 0) return null;
  const set = (i: number, text: string) => {
    const next = keys.map((_, n) => value[n] ?? '');
    next[i] = text;
    onChange(next);
  };
  return (
    <div>
      <span className={styles.fieldLabel}>{field.label}</span>
      <div className={styles.photoLabels}>
        {keys.map((k, i) => (
          <label key={k} className={styles.photoLabelRow}>
            {urls[k] ? <img src={urls[k]} alt="" /> : <span className={styles.photoBlank} />}
            <input
              type="text"
              value={value[i] ?? ''}
              maxLength={28}
              placeholder={i === 0 ? 'Before' : i === 1 ? 'After' : `Photo ${i + 1}`}
              onChange={(e) => set(i, e.target.value)}
              aria-label={`Word on photo ${i + 1}`}
            />
          </label>
        ))}
      </div>
      {field.hint && <span className={styles.fieldHint}>{field.hint}</span>}
    </div>
  );
}

/**
 * Looks as tiles. The tile IS the choice — a seller sees a blush studio, a
 * wooden table, a market stall, and taps. Nothing is typed, and nothing is
 * imagined from a sentence.
 *
 * Tapping fills the preset's params into the panel underneath, so the words
 * are still there to edit and the ideas chips still work on top of them.
 * Tapping the chosen tile again clears it and hands the seller the empty box
 * back, which is the old behaviour and occasionally what someone wants.
 */
function PresetsField({
  field,
  value,
  onChange,
  onFill,
}: {
  field: Extract<Field, { kind: 'presets' }>;
  value: string;
  onChange: (v: unknown) => void;
  onFill: (params: Record<string, unknown>) => void;
}) {
  const pick = (p: PhotoPreset) => {
    if (value === p.key) {
      onChange('');
      return;
    }
    onChange(p.key);
    onFill(p.params);
  };
  return (
    <div>
      <span className={styles.fieldLabel}>{field.label}</span>
      <div className={styles.presetGroups}>
        {(Object.keys(PRESET_GROUPS) as PresetGroup[]).map((g) => (
          <div key={g}>
            <div className={styles.presetGroupHead}>
              <strong>{PRESET_GROUPS[g].label}</strong>
              <span>{PRESET_GROUPS[g].note}</span>
            </div>
            <div className={styles.presetRow} role="radiogroup" aria-label={PRESET_GROUPS[g].label}>
              {presetsIn(g).map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={value === p.key}
                  className={styles.preset}
                  onClick={() => pick(p)}
                  title={`${p.name} — ${p.note}`}
                >
                  <span
                    className={styles.presetSwatch}
                    data-transparent={p.swatch.transparent || undefined}
                    style={
                      p.swatch.transparent
                        ? undefined
                        : {
                            background:
                              p.swatch.colors.length === 2 ? `linear-gradient(160deg, ${p.swatch.colors[0]}, ${p.swatch.colors[1]})` : p.swatch.colors[0],
                          }
                    }
                  >
                    {/* A stand-in for the seller's product, so a tile reads as a photo and not a colour chip. */}
                    <span className={styles.presetProduct} data-ink={p.swatch.ink} />
                  </span>
                  <span className={styles.presetName}>{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {field.hint && <span className={styles.fieldHint}>{field.hint}</span>}
    </div>
  );
}

/**
 * The merchant shots, as tiles with their own words on them.
 *
 * "On a model", "Ghost mannequin", "Press it" — a person selling clothes
 * knows all three on sight. A dropdown of the same words would be shorter and
 * worse: the tile can carry the sentence that says which one to reach for.
 */
function ModesField({ field, value, onChange }: { field: Extract<Field, { kind: 'modes' }>; value: string; onChange: (v: unknown) => void }) {
  return (
    <div>
      <span className={styles.fieldLabel}>{field.label}</span>
      <div className={styles.modes} role="radiogroup" aria-label={field.label}>
        {PRODUCT_MODE_KEYS.map((k) => {
          const m = PRODUCT_MODES[k];
          return (
            <button key={k} type="button" role="radio" aria-checked={value === k} className={styles.mode} onClick={() => onChange(k)} title={m.hint}>
              <strong>{m.label}</strong>
              <span>{m.note}</span>
            </button>
          );
        })}
      </div>
      {field.hint && <span className={styles.fieldHint}>{field.hint}</span>}
    </div>
  );
}

/**
 * More photos of the same product.
 *
 * This is the quality control that costs nothing: a model asked to keep a bag
 * exact does far better when it has seen the back of it. Never required, and
 * the copy says what each extra photo buys rather than just "add files".
 */
function AnglesField({ field, value, onChange }: { field: Extract<Field, { kind: 'angles' }>; value: string[]; onChange: (v: unknown) => void }) {
  const { workspace } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const keys = value.filter(Boolean);
  const joined = keys.join(',');
  useEffect(() => {
    const wanted = joined ? joined.split(',') : [];
    if (!wanted.length) return;
    let live = true;
    api.media
      .urls(workspace.id, wanted)
      .then(({ urls: u }) => {
        if (live) setUrls((prev) => ({ ...prev, ...u }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace.id, joined]);

  const add = async (files: FileList | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setBusy(true);
    const added: string[] = [];
    for (const file of list) {
      if (keys.length + added.length >= field.max) break;
      try {
        const asset = await uploadFile(workspace.id, file);
        added.push(asset.key);
        const { urls: u } = await api.media.urls(workspace.id, [asset.key]);
        setUrls((prev) => ({ ...prev, ...u }));
      } catch {
        /* one bad file must not lose the others */
      }
    }
    setBusy(false);
    if (added.length) onChange([...keys, ...added]);
  };

  return (
    <div>
      <span className={styles.fieldLabel}>
        {field.label}
        <span className={styles.photoCount}>
          {keys.length} of {field.max}
        </span>
      </span>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files).finally(() => (e.target.value = ''))} />
      <div className={styles.photoGrid}>
        <button type="button" className={styles.photoAdd} onClick={() => input.current?.click()} disabled={busy || keys.length >= field.max}>
          <Icon.plus />
          <span>{keys.length >= field.max ? 'Full' : busy ? 'Adding…' : 'Add'}</span>
        </button>
        {keys.map((k, i) => (
          <button
            key={k}
            type="button"
            className={styles.photoTile}
            aria-pressed
            onClick={() => onChange(keys.filter((x) => x !== k))}
            title="Take this one out"
          >
            {urls[k] ? <img src={urls[k]} alt="" loading="lazy" /> : <span className={styles.photoBlank} />}
            <span className={styles.photoNum}>{i + 1}</span>
          </button>
        ))}
      </div>
      {field.hint && <span className={styles.fieldHint}>{field.hint}</span>}
    </div>
  );
}

/** An idea lands in the prompt, and its camera move in the camera field when that one is still empty. */
function pickIdea(tool: Tool, values: Record<string, unknown>, idea: Idea, onChange: (key: string, value: unknown) => void) {
  if (!tool.ideas) return;
  onChange(tool.ideas.fills.prompt, idea.prompt);
  if (tool.ideas.fills.motion && idea.motion && !String(values[tool.ideas.fills.motion] ?? '').trim()) onChange(tool.ideas.fills.motion, idea.motion);
}

/**
 * Three directions for THIS product, proposed by the copy model from the
 * photo and what the seller told us about themselves; a tap fills the
 * field. Refetched when the photo, the format or the length changes;
 * "More" asks for a different three.
 */
function Ideas({ tool, values, sourceKey, onPick }: { tool: Tool; values: Record<string, unknown>; sourceKey: string | null; onPick: (idea: Idea) => void }) {
  const { workspace } = useApp();
  const [out, setOut] = useState<IdeasOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [round, setRound] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const format = tool.id === 'video' ? String(values.format ?? 'reveal') : undefined;
  const shots = tool.id === 'video' ? Number(values.shots ?? 1) : undefined;
  // A new photo or a new format is a new question; a new product name or price is not worth a refetch on every keystroke,
  // so those are read at call time rather than watched.
  const extras = useRef<{ productName?: string; price?: string }>({});
  extras.current = {
    productName: typeof values.productName === 'string' && values.productName.trim() ? values.productName : undefined,
    price: typeof values.price === 'string' && values.price.trim() ? values.price : undefined,
  };
  useEffect(() => {
    setRound(0);
  }, [sourceKey, format, shots, tool.id]);
  useEffect(() => {
    if (tool.needsSource && !sourceKey) {
      setOut(null);
      return;
    }
    let live = true;
    setLoading(true);
    api.studio
      .ideas(workspace.id, { tool: tool.id, sourceKey: sourceKey ?? undefined, format, shots, ...extras.current, round })
      .then((r) => {
        if (live) setOut(r);
      })
      .catch(() => {
        if (live) setOut(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspace.id, tool.id, tool.needsSource, sourceKey, format, shots, round]);

  if (tool.needsSource && !sourceKey) return null;
  return (
    <div className={styles.ideas} aria-live="polite">
      <div className={styles.ideasHead}>
        <span>
          {out?.product ? `Ideas for your ${out.product.toLowerCase()}` : 'Ideas for this product'}
          {out?.source === 'stock' && (
            <span className={styles.ideasNote} title={out.reason}>
              {' '}
              · general suggestions
            </span>
          )}
        </span>
        <button type="button" className={styles.ideasMore} onClick={() => setRound((r) => r + 1)} disabled={loading}>
          {loading ? 'Thinking…' : 'More'}
        </button>
      </div>
      {out ? (
        <div className={styles.ideaList}>
          {out.ideas.map((idea) => (
            <button
              key={idea.title + idea.prompt}
              type="button"
              className={styles.idea}
              aria-pressed={picked === idea.prompt}
              onClick={() => {
                setPicked(idea.prompt);
                onPick(idea);
              }}
            >
              <strong>{idea.title}</strong>
              <span>{idea.prompt}</span>
              <em>{idea.why}</em>
            </button>
          ))}
        </div>
      ) : loading ? (
        <Skeleton style={{ height: 96 }} />
      ) : null}
    </div>
  );
}

function FieldControl({
  field,
  value,
  values,
  onChange,
  onFill,
}: {
  field: Field;
  value: unknown;
  /** The whole panel, for the fields whose options or contents depend on another one. */
  values: Record<string, unknown>;
  onChange: (v: unknown) => void;
  /** Write several fields at once — a preset filling in the look it stands for. */
  onFill: (params: Record<string, unknown>) => void;
}) {
  switch (field.kind) {
    case 'text':
      if (field.suggestions && !field.rows) {
        const current = String(value ?? '')
          .split(/[,·]/)
          .map((w) => w.trim().toLowerCase())
          .filter(Boolean);
        const toggle = (word: string) => {
          const next = current.includes(word) ? current.filter((w) => w !== word) : [...current, word];
          const joined = next.join(', ');
          if (field.maxLength && joined.length > field.maxLength) return;
          onChange(joined);
        };
        return (
          <div>
            <Input
              label={field.label}
              placeholder={field.placeholder}
              hint={field.hint}
              maxLength={field.maxLength}
              value={String(value ?? '')}
              onChange={(e) => onChange(e.target.value)}
              optional={!field.required}
            />
            <div className={styles.chips} style={{ marginTop: 'var(--s-2)' }}>
              {field.suggestions.map((word) => (
                <button key={word} type="button" className={styles.chip} aria-pressed={current.includes(word)} onClick={() => toggle(word)}>
                  {word}
                </button>
              ))}
            </div>
          </div>
        );
      }
      return field.rows ? (
        <Textarea
          label={field.label}
          placeholder={field.placeholder}
          hint={field.hint}
          rows={field.rows}
          maxLength={field.maxLength}
          showCount={Boolean(field.maxLength && field.maxLength > 100)}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          optional={!field.required}
        />
      ) : (
        <Input
          label={field.label}
          placeholder={field.placeholder}
          hint={field.hint}
          maxLength={field.maxLength}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          optional={!field.required}
        />
      );
    case 'segment':
      return (
        <div>
          <span className={styles.fieldLabel}>{field.label}</span>
          <SegmentedControl label={field.label} value={String(value ?? field.options[0]!.id)} onChange={onChange} items={field.options} />
        </div>
      );
    case 'select': {
      const options = field.optionsFor?.(values) ?? field.options;
      return (
        <Select
          label={field.label}
          options={options.length ? options : field.options}
          hint={field.hintFor?.(values)}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case 'modes':
      return <ModesField field={field} value={String(value ?? '')} onChange={onChange} />;
    case 'angles':
      return <AnglesField field={field} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
    case 'presets':
      return <PresetsField field={field} value={String(value ?? '')} onChange={onChange} onFill={onFill} />;
    case 'photos':
      return <PhotosField field={field} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
    case 'photoLabels':
      return (
        <PhotoLabelsField
          field={field}
          value={Array.isArray(value) ? (value as string[]) : []}
          keys={Array.isArray(values[field.forKey]) ? (values[field.forKey] as string[]) : []}
          onChange={onChange}
        />
      );
    case 'switch':
      return <Switch label={field.label} hint={field.hint} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
    case 'slider':
      return (
        <Slider
          label={field.label}
          min={field.min}
          max={field.max}
          step={field.step}
          value={Number(value ?? field.min)}
          onChange={onChange}
          format={field.format}
        />
      );
    case 'catalogue':
      return <CatalogueField field={field} value={String(value ?? '')} onChange={onChange} />;
    case 'presenter':
      return (
        <div>
          <span className={styles.fieldLabel}>{field.label}</span>
          <div className={styles.presenters} role="radiogroup" aria-label={field.label}>
            {PRESENTERS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={value === p.key}
                className={styles.presenter}
                onClick={() => onChange(p.key)}
                title={`${p.name} — ${p.look}`}
              >
                <img src={p.previewUrl} alt="" loading="lazy" />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          {field.hint && <span className={styles.fieldHint}>{field.hint}</span>}
        </div>
      );
    case 'file':
      return <FileField field={field} value={String(value ?? '')} onChange={onChange} />;
    case 'consent':
      return (
        <label className={styles.consent}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>
            <strong>{field.label}</strong>
            {field.hint && <span>{field.hint}</span>}
          </span>
        </label>
      );
    case 'sizes': {
      const chosen = new Set((value as string[] | undefined) ?? []);
      return (
        <div>
          <span className={styles.fieldLabel}>{field.label}</span>
          <div className={styles.chips} role="group" aria-label={field.label}>
            {SIZE_OPTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.chip}
                aria-pressed={chosen.has(s.id)}
                onClick={() => {
                  const n = new Set(chosen);
                  if (n.has(s.id)) n.delete(s.id);
                  else n.add(s.id);
                  onChange([...n]);
                }}
                title={s.label}
              >
                {s.short}
              </button>
            ))}
          </div>
        </div>
      );
    }
    case 'platforms': {
      const chosen = new Set((value as string[] | undefined) ?? []);
      return (
        <div>
          <span className={styles.fieldLabel}>{field.label}</span>
          <div className={styles.chips} role="group" aria-label={field.label}>
            {PLATFORM_OPTIONS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.chip}
                aria-pressed={chosen.has(p.id)}
                onClick={() => {
                  const n = new Set(chosen);
                  if (n.has(p.id)) n.delete(p.id);
                  else n.add(p.id);
                  onChange([...n]);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      );
    }
  }
}
