'use client';
/** Projects — one per storefront, environment or team. Archiving keeps history and stops the keys. */
import { useCallback, useEffect, useState } from 'react';
import { api, type DevProject } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Badge, Button, Dialog, EmptyState, Input, Skeleton, Textarea, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from '../developer.module.css';

export default function ProjectsPage() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const isAdmin = workspace.role === 'OWNER' || workspace.role === 'ADMIN';
  const [projects, setProjects] = useState<DevProject[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DevProject | null>(null);
  const [form, setForm] = useState({ name: '', description: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { try { setProjects(await api.developer.projects(workspace.id)); } catch { setProjects([]); } }, [workspace.id]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      if (editing) await api.developer.updateProject(workspace.id, editing.id, { name: form.name.trim(), description: form.description.trim() });
      else await api.developer.createProject(workspace.id, { name: form.name.trim(), description: form.description.trim() || undefined });
      toast({ title: editing ? 'Project updated' : 'Project created', tone: 'ok' });
      setOpen(false); setEditing(null); setForm({ name: '', description: '' }); await load();
    } catch (e) { toast({ title: 'Could not save', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const archive = async (p: DevProject, archived: boolean) => {
    try { await api.developer.updateProject(workspace.id, p.id, { archived }); await load(); toast({ title: archived ? 'Archived — its keys stop working' : 'Restored', tone: 'ok' }); }
    catch (e) { toast({ title: 'Could not do that', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
  };

  return (
    <>
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <div><div className={styles.groupTitle}>Projects</div><div className={styles.groupLede}>Keys and usage are grouped by project. One per storefront, one per environment — whatever you want to see separately.</div></div>
          {isAdmin && <Button leading={<Icon.plus />} onClick={() => { setEditing(null); setForm({ name: '', description: '' }); setOpen(true); }}>New project</Button>}
        </div>
        {projects === null ? <Skeleton height={120} /> : projects.length === 0 ? (
          <EmptyState icon={<Icon.code />} title="No projects yet" body="A project is where keys live. Create one, then mint a key in it." />
        ) : (
          <div className={styles.rows}>
            {projects.map((p) => (
              <div key={p.id} className={`${styles.row} ${p.archivedAt ? styles.rowMuted : ''}`}>
                <div className={styles.rowIcon}><Icon.code width={18} height={18} /></div>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}><span>{p.name}</span>{p.archivedAt ? <Badge tone="warn">Archived</Badge> : <Badge tone="ok">{p.activeKeys ?? 0} active {p.activeKeys === 1 ? 'key' : 'keys'}</Badge>}</div>
                  <div className={styles.rowSub}><span style={{ fontFamily: 'var(--f-mono)' }}>{p.slug}</span>{p.description ? ` · ${p.description}` : ''} · created {new Date(p.createdAt).toLocaleDateString()}</div>
                </div>
                {isAdmin && (
                  <div className={styles.rowEnd}>
                    <Button variant="ghost" size="sm" href={`/developer/keys?project=${p.id}`}>Keys</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setEditing(p); setForm({ name: p.name, description: p.description ?? '' }); setOpen(true); }}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => archive(p, !p.archivedAt)}>{p.archivedAt ? 'Restore' : 'Archive'}</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? 'Edit project' : 'New project'} locked={busy}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} disabled={form.name.trim().length < 2}>{editing ? 'Save' : 'Create'}</Button></>}>
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Input label="Name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Jumia storefront" maxLength={80} autoFocus />
          <Textarea label="What it is for" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} maxLength={300} optional />
        </div>
      </Dialog>
    </>
  );
}
