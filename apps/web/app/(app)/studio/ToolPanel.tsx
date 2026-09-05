'use client';
/**
 * The tool's controls, the quote, and the one button.
 *
 * The quote is shown before anything is committed: what it costs, what the
 * balance will be after. Out of credits is a conversion moment, not an
 * error — the panel says what this would cost and offers the two ways to
 * fix it, and the button stays visible but disabled so the intent is kept.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type DubLanguages, type Genre, type Quote, type Voice } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { PLATFORM_OPTIONS, SIZE_OPTIONS, missingFor, type Field, type Tool } from '@/lib/studio/tools';
import { Button, Combobox, Input, Progress, SegmentedControl, Select, Slider, Switch, Textarea } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './studio.module.css';

const BUTTON_LABEL: Record<string, string> = { copy: 'Write it', music: 'Make the song', voice: 'Record it', translate: 'Translate it', lipsync: 'Sync it' };

export function ToolPanel({
  tool,
  values,
  onChange,
  hasSource,
  onGenerate,
  busy,
}: {
  tool: Tool;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  hasSource: boolean;
  onGenerate: (quote: Quote) => void;
  busy: boolean;
}) {
  const { workspace, balance } = useApp();
  const [quote, setQuote] = useState<Quote | null>(null);
  const costCode = tool.costCodeFor?.(values);
  useEffect(() => {
    let live = true;
    setQuote(null);
    api.generations
      .quote(workspace.id, tool.capability, costCode)
      .then((q) => {
        if (live) setQuote(q);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspace.id, tool.capability, costCode]);

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
                <FieldControl key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} />
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
                You need {(-after!).toLocaleString()} more. <a href="/billing/plans">Top up</a> or <a href="/billing">see your plan</a>.
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
const catalogueCache: { genres?: Promise<Genre[]>; voices?: Promise<Voice[]>; languages?: Promise<DubLanguages> } = {};
const EMPTY_HINT: Record<string, string> = {
  voices: 'No voice vendor is configured in this environment yet.',
  languages: 'No dubbing vendor is configured in this environment yet.',
  sourceLanguages: 'No dubbing vendor is configured in this environment yet.',
  genres: 'The catalogue is empty.',
};
function CatalogueField({ field, value, onChange }: { field: Extract<Field, { kind: 'catalogue' }>; value: string; onChange: (v: unknown) => void }) {
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
    } else if (field.source === 'voices') {
      catalogueCache.voices ??= api.audio.voices();
      catalogueCache.voices
        .then((vs) =>
          done(
            vs.map((v) => ({
              value: v.key,
              label: v.name,
              sub: [v.accent ? `${v.accent} ${v.language.startsWith('en') ? 'English' : v.language}` : v.language, v.gender, ...v.tags]
                .filter(Boolean)
                .join(' · '),
              keywords: `${v.language} ${v.accent ?? ''} ${v.gender ?? ''} ${v.tags.join(' ')} ${v.provider}`,
            })),
          ),
        )
        .catch(fail);
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
  }, [field.source]);
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
          {field.accept === 'video' ? <video src={url} controls playsInline preload="metadata" /> : <audio src={url} controls preload="metadata" />}
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

function FieldControl({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.kind) {
    case 'text':
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
    case 'select':
      return <Select label={field.label} options={field.options} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
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
