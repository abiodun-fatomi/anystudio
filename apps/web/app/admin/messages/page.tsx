'use client';
/** Messages from the platform to everyone's bell: write, publish, expire. */
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminMessage } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Select, Skeleton, Table, Textarea, tableCell, useToast } from '@/components/ui';
import styles from '../admin.module.css';

export default function MessagesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<AdminMessage[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', href: '', audience: 'ALL', expiresAt: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.admin.messages().then(setRows).catch(() => setRows([])); }, []);
  useEffect(() => { load(); }, [load]);
  const create = async (publish: boolean) => {
    setBusy(true);
    try { await api.admin.createMessage({ title: form.title.trim(), body: form.body.trim(), href: form.href.trim() || undefined, audience: form.audience, publish, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined }); toast({ title: publish ? 'Published' : 'Saved as draft', tone: 'ok' }); setOpen(false); setForm({ title: '', body: '', href: '', audience: 'ALL', expiresAt: '' }); load(); }
    catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const setPublished = async (m: AdminMessage, published: boolean) => { try { await api.admin.updateMessage(m.id, { published }); load(); } catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); } };
  const remove = async (m: AdminMessage) => { if (!window.confirm(`Delete "${m.title}"?`)) return; try { await api.admin.deleteMessage(m.id); load(); } catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); } };
  return (
    <div className="rise">
      <PageHeader title="Platform messages" lede="One row, read by everyone in the audience, in their bell. Publish when ready; unpublish to pull it back." actions={<Button onClick={() => setOpen(true)}>New message</Button>} />
      {rows === null ? <Skeleton height={200} /> : rows.length === 0 ? <p style={{ color: 'var(--muted)' }}>Nothing written yet.</p> : (
        <Table>
          <thead><tr><th>Title</th><th>Audience</th><th>State</th><th className={tableCell.num}>Read by</th><th /></tr></thead>
          <tbody>{rows.map((m) => (
            <tr key={m.id}>
              <td><strong>{m.title}</strong><div style={{ fontSize: 'var(--t-1)', color: 'var(--muted)' }}>{m.body.slice(0, 120)}</div></td>
              <td>{m.audience.toLowerCase()}</td>
              <td>{m.publishedAt ? <span className={styles.pill} data-tone="ok">live since {new Date(m.publishedAt).toLocaleDateString()}</span> : <span className={styles.pill}>draft</span>}{m.expiresAt && <div style={{ fontSize: 'var(--t-1)', color: 'var(--muted)' }}>until {new Date(m.expiresAt).toLocaleDateString()}</div>}</td>
              <td className={tableCell.num}>{m._count?.reads ?? 0}</td>
              <td style={{ whiteSpace: 'nowrap' }}><Button variant="ghost" size="sm" onClick={() => setPublished(m, !m.publishedAt)}>{m.publishedAt ? 'Unpublish' : 'Publish'}</Button> <Button variant="ghost" size="sm" onClick={() => remove(m)}>Delete</Button></td>
            </tr>
          ))}</tbody>
        </Table>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="New platform message" locked={busy}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="ghost" onClick={() => create(false)} loading={busy} disabled={form.title.trim().length < 2 || form.body.trim().length < 2}>Save draft</Button><Button onClick={() => create(true)} loading={busy} disabled={form.title.trim().length < 2 || form.body.trim().length < 2}>Publish now</Button></>}>
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Input label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} autoFocus />
          <Textarea label="Message" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={4} maxLength={2000} />
          <Input label="Link (optional app path)" value={form.href} onChange={(e) => setForm({ ...form, href: e.target.value })} placeholder="/billing/plans" />
          <Select label="Audience" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} options={[{ value: 'ALL', label: 'Everyone' }, { value: 'PERSONAL', label: 'Personal workspaces' }, { value: 'BUSINESS', label: 'Business workspaces' }, { value: 'ORGANIZATION', label: 'Organizations' }]} />
          <Input label="Expires (optional)" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        </div>
      </Dialog>
    </div>
  );
}
