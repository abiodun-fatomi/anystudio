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
import { uploadFile } from '@/lib/upload';
import { renderMissingExamples, type RenderProgress } from './renderExamples';
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
  /**
   * Which workspace pays for the renders.
   *
   * The console is not a workspace app — it has no "current workspace", and
   * reaching for the customer app's provider here is what crashed this page
   * the first time. It is also the better question: these renders cost real
   * credits, so the operator names the account that is charged rather than
   * having one chosen for them silently.
   */
  const billTo = useAdmin().me.workspaces;
  const [payer, setPayer] = useState<string>(() => billTo[0]?.id ?? '');
  const [setup, setSetup] = useState<{ reason: string } | null>(null);
  const { toast } = useToast();
  const [render, setRender] = useState<RenderProgress | null>(null);
  const stock = useRef<HTMLInputElement>(null);
  const stop = useRef<AbortController | null>(null);
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

  /**
   * Fill the empty tiles by actually making the pictures.
   *
   * One stock product photo in, one ordinary generation per template out,
   * each promoted to that template's example. Charged to the workspace the
   * operator named, like any other job, because it is one.
   */
  const renderAll = async (product: File, workspaceId: string, reason: string) => {
    const missing = (rows ?? []).filter((r) => r.active && !r.thumbnailKey);
    if (missing.length === 0) {
      toast({ title: 'Nothing to render', body: 'Every live template already has an example.', tone: 'ok' });
      return;
    }
    const controller = new AbortController();
    stop.current = controller;
    setRender({ done: 0, total: missing.length, current: null, failures: [] });
    try {
      const asset = await uploadFile(workspaceId, product);
      const out = await renderMissingExamples({
        workspaceId,
        sourceKey: asset.key,
        templates: missing,
        reason,
        onProgress: setRender,
        signal: controller.signal,
      });
      toast({
        title: `${out.done - out.failures.length} of ${out.total} rendered`,
        body: out.failures.length ? `${out.failures.length} failed — the list is under the button.` : 'Every tile is a photograph now.',
        tone: out.failures.length ? 'danger' : 'ok',
      });
      load();
    } catch (e) {
      toast({ title: 'Rendering stopped', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      stop.current = null;
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

      <input
        ref={stock}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const product = e.target.files?.[0];
          e.target.value = '';
          const chosen = setup;
          setSetup(null);
          if (product && chosen) void renderAll(product, payer, chosen.reason.trim());
        }}
      />

      {render && (
        <div className={styles.card}>
          <strong>
            Rendering examples — {render.done} of {render.total}
          </strong>
          <p className={styles.small}>
            {render.current ? `Working on “${render.current}”.` : 'Finishing.'} Keep this tab open; closing it stops after the jobs already running, and
            re-running skips whatever finished.
          </p>
          {render.failures.length > 0 && (
            <p className={styles.warn}>
              {render.failures.length} failed: {render.failures.map((f) => `${f.code} (${f.why})`).join(', ')}
            </p>
          )}
          {render.done < render.total && (
            <Button variant="ghost" onClick={() => stop.current?.abort()}>
              Stop
            </Button>
          )}
        </div>
      )}

      {missingRenders > 0 && (
        // Not a warning tucked in a corner: a template with no photograph is
        // a preset with extra steps, and the whole point of the catalogue is
        // that the seller chooses by looking.
        <p className={styles.warn}>
          {missingRenders} live {missingRenders === 1 ? 'template has' : 'templates have'} no example render yet and show a plain gradient in the picker. A
          template without one is a preset with extra steps — the seller is back to choosing by reading.{' '}
          {!render && (
            <Button variant="ghost" onClick={() => setSetup({ reason: '' })}>
              Render them all from one product photo
            </Button>
          )}
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
        open={setup !== null}
        onClose={() => setSetup(null)}
        title={`Render ${missingRenders} example${missingRenders === 1 ? '' : 's'}`}
        footer={
          <Button disabled={!setup || setup.reason.trim().length < 4 || !payer} onClick={() => stock.current?.click()}>
            Choose a product photo and start
          </Button>
        }
      >
        {setup && (
          <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
            <p className={styles.small}>
              Each template becomes one ordinary generation — same prompt, same providers, same fidelity check a seller would get — and the picture it produces
              becomes that template&rsquo;s tile. It spends credits, roughly one scene each. Templates that already have a render are skipped, so running this
              again only costs what it has not reached.
            </p>
            {billTo.length === 0 ? (
              <p className={styles.warn}>
                Your staff account has no workspace to bill these to. Renders have to be charged somewhere, so make or join one first.
              </p>
            ) : (
              <Select
                label="Charge these to"
                hint="These are real credits, from a real balance. Pick the account that should pay."
                value={payer}
                onChange={(e) => setPayer(e.target.value)}
                options={billTo.map((w) => ({ value: w.id, label: `${w.name} · ${w.type.toLowerCase()}` }))}
              />
            )}
            <Textarea
              label="Why (on the record)"
              rows={2}
              hint="Goes in the audit log against every template this touches."
              value={setup.reason}
              onChange={(e) => setSetup({ reason: e.target.value })}
            />
          </div>
        )}
      </Dialog>

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
