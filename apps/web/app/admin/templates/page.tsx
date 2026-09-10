'use client';
/**
 * The template catalogue, from the inside.
 *
 * This page is the reason the catalogue is a table. A template that comes out
 * wrong is visible to every seller at once, and the fix — reword the prompt,
 * drop it down the order, retire it — has to be a minute's work at two in the
 * morning rather than a release. Everything here is arranged around that:
 * retire is the first control, not the last, and it never asks twice.
 *
 * Two things this page has to keep honest, because nothing else will:
 *
 *   THE RENDER IS THE PRODUCT. A template without its example photograph is
 *   a preset with extra steps — the seller is back to choosing by reading.
 *   So a missing render is called out in the row rather than left to be
 *   noticed, and uploading one is a single control on the row itself.
 *
 *   EDITING IS A ONE-WAY DOOR. The first edit to a row's copy or prompt
 *   stamps `operatorEdited` and the seed stops maintaining it forever after.
 *   That is the right trade — a deploy must never revert a production fix —
 *   but it is invisible from here unless the page says so, so it does.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_KEYS, type TemplateCategory } from '@anystudio/shared';
import { api, type AdminTemplate } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Select, Skeleton, Table, Textarea, tableCell, useToast } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

/** Under five megabytes, matching the DTO — the API refuses anything larger. */
const MAX_BYTES = 5_000_000;

interface Draft {
  code: string;
  name: string;
  note: string;
  category: TemplateCategory;
  kind: 'cut' | 'scene';
  prompt: string;
  keywords: string;
  sort: string;
  reason: string;
  /** Empty when adding; the row's code when editing, which is also what makes `code` read-only. */
  editing: string | null;
}

const blank = (): Draft => ({
  code: '',
  name: '',
  note: '',
  category: 'general',
  kind: 'scene',
  prompt: '',
  keywords: '',
  sort: '100',
  reason: '',
  editing: null,
});

export default function TemplatesPage() {
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [rows, setRows] = useState<AdminTemplate[] | null>(null);
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<string | null>(null);

  const load = useCallback(() => {
    api.admin
      .templates()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => (rows ?? []).filter((r) => category === 'all' || r.category === category), [rows, category]);
  const missingRenders = useMemo(() => (rows ?? []).filter((r) => r.active && !r.thumbnailKey).length, [rows]);

  const save = async () => {
    if (!draft) return;
    const reason = draft.reason.trim();
    if (reason.length < 4) return;
    setBusy(true);
    try {
      const body = {
        name: draft.name.trim(),
        note: draft.note.trim(),
        category: draft.category,
        kind: draft.kind,
        prompt: draft.kind === 'scene' ? draft.prompt.trim() : '',
        keywords: draft.keywords.trim(),
        sort: Number(draft.sort) || 100,
        reason,
      };
      if (draft.editing) await api.admin.patchTemplate(draft.editing, body);
      else await api.admin.createTemplate({ ...body, code: draft.code.trim() });
      setDraft(null);
      toast({
        title: draft.editing ? 'Template saved' : 'Template added',
        body: 'Sellers see it on their next reload. It is now operator-owned: the seed will not overwrite this copy.',
        tone: 'ok',
      });
      load();
    } catch (e) {
      toast({ title: 'Not saved', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const retire = async (row: AdminTemplate) => {
    const reason = window.prompt(`${row.active ? 'Retire' : 'Bring back'} “${row.name}”. Why? (on the record)`);
    if (!reason || reason.trim().length < 4) return;
    try {
      await api.admin.patchTemplate(row.code, { active: !row.active, reason: reason.trim() });
      toast({ title: `“${row.name}” ${row.active ? 'retired' : 'back in the picker'}`, tone: 'ok' });
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };

  /**
   * The bytes go browser → storage, never through the API.
   *
   * The signature names the key, and the key came from the template's code on
   * the server, so nothing here chooses where the object lands. A failed PUT
   * leaves the row pointing at a key with nothing behind it, which the studio
   * already draws as a gradient rather than a broken tile — so the recovery
   * is simply to upload again.
   */
  const upload = async (row: AdminTemplate, chosen: File) => {
    if (chosen.size > MAX_BYTES) {
      toast({ title: 'Too large', body: 'Renders must be under 5 MB. A 1600px webp is usually well under.', tone: 'danger' });
      return;
    }
    const reason = window.prompt(`Upload an example render for “${row.name}”. Why? (on the record)`);
    if (!reason || reason.trim().length < 4) return;
    setUploading(row.code);
    try {
      const signed = await api.admin.templateThumbnailUpload(row.code, { mime: chosen.type, bytes: chosen.size, reason: reason.trim() });
      const put = await fetch(signed.url, { method: 'PUT', body: chosen, headers: { 'Content-Type': chosen.type } });
      if (!put.ok) throw new Error(`Storage refused the upload (${put.status}).`);
      toast({ title: 'Render uploaded', body: `“${row.name}” now shows a photograph instead of a gradient.`, tone: 'ok' });
      load();
    } catch (e) {
      toast({ title: 'Not uploaded', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setUploading(null);
    }
  };

  if (!atLeast('ADMIN')) {
    return (
      <>
        <PageHeader title="Templates" lede="The settings sellers pick by looking." />
        <p className={styles.small}>Editing the catalogue needs an admin. Ask someone with the rank, or read the audit log for what changed.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Templates"
        lede="The settings sellers pick by looking. Editing one takes effect on the next reload."
        actions={<Button onClick={() => setDraft(blank())}>Add a template</Button>}
      />

      {missingRenders > 0 && (
        // Not a warning tucked in a corner: a template with no photograph is
        // a preset with extra steps, and the whole point of the catalogue is
        // that the seller chooses by looking.
        <p className={styles.warn}>
          {missingRenders} live {missingRenders === 1 ? 'template has' : 'templates have'} no example render yet and show a plain gradient in the picker.
          Uploading one is the single biggest thing that makes this catalogue worth having.
        </p>
      )}

      <div className={styles.toolbar}>
        <Select
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as TemplateCategory | 'all')}
          options={[
            { value: 'all', label: `All (${rows?.length ?? 0})` },
            ...TEMPLATE_CATEGORY_KEYS.map((c) => ({
              value: c,
              label: `${TEMPLATE_CATEGORIES[c].label} (${(rows ?? []).filter((r) => r.category === c).length})`,
            })),
          ]}
        />
      </div>

      {rows === null ? (
        <Skeleton height={320} />
      ) : (
        <Table>
          <thead>
            <tr>
              <th scope="col">Template</th>
              <th scope="col">Category</th>
              <th scope="col">Kind</th>
              <th scope="col" className={tableCell.num}>
                Order
              </th>
              <th scope="col">Render</th>
              <th scope="col">Maintained by</th>
              <th scope="col" className={tableCell.shrink}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.code}>
                <td>
                  <strong>
                    {row.name}
                    {!row.active && ' — retired'}
                  </strong>
                  <br />
                  <small>{row.note}</small>
                  <br />
                  <code>{row.code}</code>
                </td>
                <td>{TEMPLATE_CATEGORIES[row.category as TemplateCategory]?.label ?? `${row.category} (unknown)`}</td>
                <td>{row.kind === 'cut' ? 'Cut-out' : 'Scene'}</td>
                <td className={tableCell.num}>{row.sort}</td>
                {/* The single most useful column on the page: a template with
                    no photograph is a preset with extra steps. */}
                <td>{row.thumbnailKey ? 'Uploaded' : '— none yet'}</td>
                {/* The one-way door, said out loud rather than left to be discovered. */}
                <td>{row.operatorEdited ? 'This console' : 'The seed'}</td>
                <td className={tableCell.shrink}>
                  <Button
                    variant="ghost"
                    loading={uploading === row.code}
                    onClick={() => {
                      uploadFor.current = row.code;
                      file.current?.click();
                    }}
                  >
                    {row.thumbnailKey ? 'Replace render' : 'Add render'}
                  </Button>{' '}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        code: row.code,
                        name: row.name,
                        note: row.note,
                        category: row.category in TEMPLATE_CATEGORIES ? (row.category as TemplateCategory) : 'general',
                        kind: row.kind,
                        prompt: typeof row.params.prompt === 'string' ? row.params.prompt : '',
                        keywords: row.keywords ?? '',
                        sort: String(row.sort),
                        reason: '',
                        editing: row.code,
                      })
                    }
                  >
                    Edit
                  </Button>{' '}
                  <Button variant="ghost" onClick={() => retire(row)}>
                    {row.active ? 'Retire' : 'Bring back'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <input
        ref={file}
        type="file"
        accept="image/webp,image/jpeg,image/png"
        hidden
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          const row = (rows ?? []).find((r) => r.code === uploadFor.current);
          // Cleared before the await so picking the same file twice still fires.
          e.target.value = '';
          if (chosen && row) void upload(row, chosen);
        }}
      />

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.editing ? `Edit “${draft.name}”` : 'Add a template'}
        locked={busy}
        footer={
          <Button
            onClick={save}
            loading={busy}
            disabled={!draft || draft.reason.trim().length < 4 || !draft.name.trim() || !draft.note.trim() || (!draft.editing && draft.code.trim().length < 3)}
          >
            Save
          </Button>
        }
      >
        {draft && (
          <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
            {!draft.editing && (
              <Input
                label="Code"
                hint="Lowercase, digits and underscores. It becomes the storage key for the render and can never be changed."
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              />
            )}
            <Input label="Name" hint="What a seller would call it." value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Input
              label="Note"
              hint="One line under the tile: “Oak floor, linen curtains, morning light.”"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            <Select
              label="Category"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value as TemplateCategory })}
              options={TEMPLATE_CATEGORY_KEYS.map((c) => ({ value: c, label: TEMPLATE_CATEGORIES[c].label }))}
            />
            <Select
              label="Kind"
              hint="A scene asks a model for a setting. A cut drops the product on flat white and costs less."
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'cut' | 'scene' })}
              options={[
                { value: 'scene', label: 'Scene' },
                { value: 'cut', label: 'Cut-out' },
              ]}
            />
            {draft.kind === 'scene' && (
              <Textarea
                label="Prompt"
                rows={5}
                hint="Describe ground, walls, light and depth — never the product, which the model must not invent. Say “no people, no text, no signage”."
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            )}
            <Input
              label="Search words"
              hint="What a seller might type: “living room lounge parlour”. Optional — the name and note are searched anyway."
              value={draft.keywords}
              onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
            />
            <Input
              label="Order"
              hint="Lower shows first inside its category. Leave gaps of ten."
              value={draft.sort}
              onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
            />
            <Textarea
              label="Why (on the record)"
              rows={2}
              hint={
                draft.editing && !rowIsOperatorOwned(rows, draft.editing)
                  ? 'Saving takes this row out of the seed’s hands for good — future releases will no longer update its copy or prompt.'
                  : 'Goes in the audit log with your name.'
              }
              value={draft.reason}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            />
          </div>
        )}
      </Dialog>
    </>
  );
}

function rowIsOperatorOwned(rows: AdminTemplate[] | null, code: string): boolean {
  return Boolean(rows?.find((r) => r.code === code)?.operatorEdited);
}
