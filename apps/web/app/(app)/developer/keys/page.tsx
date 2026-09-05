'use client';
/**
 * API keys — minted here, shown once, listed by prefix afterwards. The
 * one-time reveal stays on screen until the person dismisses it, because a
 * key that vanished behind a toast is a key that gets minted again.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, type DevKey, type DevProject } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Input, Select, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from '../developer.module.css';

const SCOPES: Array<{ id: string; label: string; help: string }> = [
  { id: 'generations:write', label: 'Make things', help: 'Create and cancel generations, unlock songs' },
  { id: 'generations:read', label: 'Read results', help: 'List and fetch generations and their files' },
  { id: 'media:write', label: 'Upload files', help: 'Presigned uploads and fetch-from-URL' },
  { id: 'catalogue:read', label: 'Read catalogues', help: 'Capabilities, prices, genres, voices, languages' },
  { id: 'balance:read', label: 'Read the balance', help: 'Credits left' },
];

export default function KeysPage() {
  return <Suspense fallback={null}><Keys /></Suspense>;
}

function Keys() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const params = useSearchParams();
  const isAdmin = workspace.role === 'OWNER' || workspace.role === 'ADMIN';
  const [keys, setKeys] = useState<DevKey[] | null>(null);
  const [projects, setProjects] = useState<DevProject[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ projectId: params.get('project') ?? '', name: '', scopes: SCOPES.map((s) => s.id), expiresInDays: '' });
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<(DevKey & { key: string }) | null>(null);
  const [revoke, setRevoke] = useState<DevKey | null>(null);

  const load = useCallback(async () => {
    try { const [k, p] = await Promise.all([api.developer.keys(workspace.id), api.developer.projects(workspace.id)]); setKeys(k); setProjects(p); }
    catch { setKeys([]); setProjects([]); }
  }, [workspace.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!form.projectId && projects?.length) setForm((f) => ({ ...f, projectId: projects.find((p) => !p.archivedAt)?.id ?? '' })); }, [projects, form.projectId]);

  const mint = async () => {
    setBusy(true);
    try {
      const k = await api.developer.createKey(workspace.id, { projectId: form.projectId, name: form.name.trim(), scopes: form.scopes, expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : undefined });
      setMinted(k); setOpen(false); setForm((f) => ({ ...f, name: '' })); await load();
    } catch (e) { toast({ title: 'Could not create the key', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const doRevoke = async () => {
    if (!revoke) return;
    setBusy(true);
    try { await api.developer.revokeKey(workspace.id, revoke.id); setRevoke(null); await load(); toast({ title: 'Key revoked', body: 'Requests with it now get 401.', tone: 'ok' }); }
    catch (e) { toast({ title: 'Could not revoke', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); toast({ title: 'Copied', tone: 'ok', durationMs: 1500 }); } catch { toast({ title: 'Select it and copy by hand', tone: 'warn' }); } };

  const liveProjects = (projects ?? []).filter((p) => !p.archivedAt);

  return (
    <>
      {minted && (
        <div className={styles.reveal} role="alert">
          <strong>Your new key, {minted.name}. Copy it now — it will not be shown again.</strong>
          <div className={styles.secret}><code>{minted.key}</code><Button size="sm" leading={<Icon.copy width={14} height={14} />} onClick={() => copy(minted.key)}>Copy</Button></div>
          <div className={styles.rowSub}>Send it as <span style={{ fontFamily: 'var(--f-mono)' }}>Authorization: Bearer {minted.prefix}…</span>. Keep it in your server&apos;s secrets, never in a browser or an app.</div>
          <div><Button variant="ghost" size="sm" onClick={() => setMinted(null)}>I have saved it</Button></div>
        </div>
      )}

      <section className={styles.group}>
        <div className={styles.groupHead}>
          <div><div className={styles.groupTitle}>API keys</div><div className={styles.groupLede}>A key belongs to a project and does only what its scopes allow. Revoking is immediate and permanent.</div></div>
          {isAdmin && <Button leading={<Icon.plus />} onClick={() => setOpen(true)} disabled={liveProjects.length === 0} title={liveProjects.length === 0 ? 'Create a project first' : undefined}>New key</Button>}
        </div>
        {keys === null ? <Skeleton height={120} /> : keys.length === 0 ? (
          <EmptyState icon={<Icon.key />} title="No keys yet" body={liveProjects.length ? 'Mint one, paste it into your server, make a request.' : 'Create a project first; keys live in projects.'} actions={liveProjects.length === 0 ? <Button href="/developer/projects">Create a project</Button> : undefined} />
        ) : (
          <div className={styles.rows}>
            {keys.map((k) => {
              const dead = Boolean(k.revokedAt) || (k.expiresAt ? new Date(k.expiresAt) < new Date() : false);
              return (
                <div key={k.id} className={`${styles.row} ${dead ? styles.rowMuted : ''}`}>
                  <div className={styles.rowIcon}><Icon.key width={18} height={18} /></div>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}><span>{k.name}</span><span style={{ fontFamily: 'var(--f-mono)', fontWeight: 400 }}>{k.prefix}…</span>{k.revokedAt ? <Badge tone="danger">Revoked</Badge> : k.expiresAt && new Date(k.expiresAt) < new Date() ? <Badge tone="warn">Expired</Badge> : <Badge tone="ok">Active</Badge>}</div>
                    <div className={styles.rowSub}>{k.project.name} · {k.scopes.length === SCOPES.length ? 'all scopes' : k.scopes.join(', ')} · {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : 'never used'}{k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''} · by {k.createdBy ?? 'someone'}</div>
                  </div>
                  {isAdmin && !k.revokedAt && <div className={styles.rowEnd}><Button variant="ghost" size="sm" onClick={() => setRevoke(k)}>Revoke</Button></div>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <Dialog open={open} onClose={() => setOpen(false)} title="New API key" description="Scopes limit what a leaked key could do. Give a server only what it needs." locked={busy}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button onClick={mint} loading={busy} disabled={form.name.trim().length < 2 || !form.projectId || form.scopes.length === 0}>Create key</Button></>}>
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Select label="Project" value={form.projectId} onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))} options={liveProjects.map((p) => ({ value: p.id, label: p.name }))} />
          <Input label="Name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Production server" maxLength={80} autoFocus />
          <div>
            <span className={styles.groupLede} style={{ display: 'block', marginBottom: 'var(--s-2)', fontWeight: 600, color: 'var(--ink)' }}>Scopes</span>
            <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
              {SCOPES.map((s) => (
                <Checkbox key={s.id} label={s.label} hint={s.help} checked={form.scopes.includes(s.id)} onChange={(e) => setForm((f) => ({ ...f, scopes: e.target.checked ? [...f.scopes, s.id] : f.scopes.filter((x) => x !== s.id) }))} />
              ))}
            </div>
          </div>
          <Select label="Expires" value={form.expiresInDays} onChange={(e) => setForm((f) => ({ ...f, expiresInDays: e.target.value }))} options={[{ value: '', label: 'Never' }, { value: '30', label: 'In 30 days' }, { value: '90', label: 'In 90 days' }, { value: '365', label: 'In a year' }]} />
        </div>
      </Dialog>

      <ConfirmDialog open={Boolean(revoke)} onClose={() => setRevoke(null)} onConfirm={doRevoke} busy={busy} danger confirmLabel="Revoke key"
        title={`Revoke ${revoke?.name}?`} description="Every request using it fails from this moment. The generations it made stay in your history." />
    </>
  );
}
