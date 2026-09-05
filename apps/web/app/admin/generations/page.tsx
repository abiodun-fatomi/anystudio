'use client';
/** Every generation, filterable; one opens with its inputs, outputs, provider job id and the operator-facing failure reason. */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, type AdminGeneration } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Pagination, Select, Skeleton, Table, Textarea, tableCell, useToast } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

const CAPS = ['', 'IMAGE_EDIT', 'IMAGE_GENERATE', 'BACKGROUND_REMOVE', 'BACKGROUND_REPLACE', 'UPSCALE', 'IMAGE_TO_VIDEO', 'TEXT_GENERATE', 'VOICEOVER', 'MUSIC', 'DUB', 'LIPSYNC'];

export default function GenerationsPage() { return <Suspense fallback={null}><Generations /></Suspense>; }

function Generations() {
  const params = useSearchParams();
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState('');
  const [capability, setCapability] = useState('');
  const [rows, setRows] = useState<AdminGeneration[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<Awaited<ReturnType<typeof api.admin.generation>> | null>(null);
  const [action, setAction] = useState<'fail' | 'refund' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (after?: string) => {
    if (!after) setRows(null);
    try { const r = await api.admin.generations({ q: q.trim() || undefined, status: status || undefined, capability: capability || undefined, cursor: after }); setRows((cur) => (after && cur ? [...cur, ...r.generations] : r.generations)); setCursor(r.nextCursor); } catch { setRows([]); }
  }, [q, status, capability]);
  useEffect(() => { void search(); }, [status, capability]);
  const show = (id: string) => api.admin.generation(id).then(setOpen).catch(() => toast({ title: 'Could not load it', tone: 'danger' }));
  const act = async () => {
    if (!open || !action) return; setBusy(true);
    try {
      if (action === 'fail') await api.admin.failGeneration(open.id, reason.trim()); else await api.admin.refundGeneration(open.id, reason.trim());
      toast({ title: action === 'fail' ? 'Ended; credits returned' : 'Refunded', tone: 'ok' }); setAction(null); setReason(''); void show(open.id); void search();
    } catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="rise">
      <PageHeader title="Generations" lede="Newest first. Search by id, workspace id, provider job id or title." />
      <form className={styles.toolbar} onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="id · workspace id · provider job id" />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={['', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((s) => ({ value: s, label: s || 'Any status' }))} />
        <Select label="Capability" value={capability} onChange={(e) => setCapability(e.target.value)} options={CAPS.map((c) => ({ value: c, label: c || 'Any capability' }))} />
        <Button type="submit">Search</Button>
      </form>
      {rows === null ? <Skeleton height={240} /> : (
        <>
          <Table>
            <thead><tr><th>When</th><th>What</th><th>Status</th><th>Via</th><th>Provider</th><th>Failure</th><th className={tableCell.num}>Credits</th><th className={tableCell.num}>Vendor cost</th></tr></thead>
            <tbody>{rows.map((g) => (
              <tr key={g.id} className={styles.clickRow} onClick={() => void show(g.id)}>
                <td className={tableCell.shrink}>{new Date(g.createdAt).toLocaleString()}</td>
                <td><strong>{g.title ?? g.capability}</strong><div className={styles.mono} style={{ color: 'var(--muted)' }}>{g.capability} · {g.id.slice(0, 8)}</div></td>
                <td><span className={styles.pill} data-tone={g.status === 'SUCCEEDED' ? 'ok' : g.status === 'FAILED' ? 'danger' : 'warn'}>{g.status}</span>{g.stage && g.status === 'RUNNING' ? <div className={styles.mono} style={{ color: 'var(--muted)' }}>{g.stage}</div> : null}</td>
                <td>{g.channel.toLowerCase()}</td>
                <td className={styles.mono}>{g.providerKey ?? '—'}</td>
                <td style={{ fontSize: 'var(--t-1)', color: 'var(--muted)', maxWidth: 280 }}>{g.failureKind ? <><span className={styles.danger}>{g.failureKind}</span> {g.failureReason?.slice(0, 100)}</> : ''}</td>
                <td className={tableCell.num}>{g.credits}</td>
                <td className={tableCell.num}>{g.providerCostMinor != null ? `${(g.providerCostMinor / 100).toFixed(2)}` : '—'}</td>
              </tr>
            ))}</tbody>
          </Table>
          <Pagination><span>{rows.length} shown</span>{cursor && <Button variant="ghost" size="sm" onClick={() => void search(cursor)}>More</Button>}</Pagination>
        </>
      )}
      <Dialog open={open !== null} onClose={() => { setOpen(null); setAction(null); }} title={open ? (open.title ?? open.capability) : ''} wide sheet="right"
        footer={open && atLeast('OPERATOR') ? <>
          {(open.status === 'RUNNING' || open.status === 'QUEUED') && <Button variant="danger" onClick={() => setAction('fail')}>End it, credits back</Button>}
          {open.status === 'SUCCEEDED' && open.credits > 0 && <Button variant="ghost" onClick={() => setAction('refund')}>Goodwill refund</Button>}
        </> : undefined}>
        {open && (
          <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
            <dl className={styles.kv}>
              <dt>Id</dt><dd className={styles.mono}>{open.id}</dd>
              <dt>Workspace</dt><dd><a href={`/admin/workspaces/${open.workspaceId}`}>{open.workspace.name}</a> ({open.workspace.type.toLowerCase()})</dd>
              <dt>Asked by</dt><dd><a href={`/admin/customers/${open.requestedBy.id}`}>{open.requestedBy.name ?? open.requestedBy.email ?? open.requestedBy.phone}</a> via {open.channel.toLowerCase()}</dd>
              <dt>Status</dt><dd>{open.status} · {open.stage ?? ''} · attempt {open.attempts}</dd>
              <dt>Provider</dt><dd className={styles.mono}>{open.providerKey ?? '—'} {open.providerJobId ? `· job ${open.providerJobId}` : ''}</dd>
              <dt>Credits</dt><dd>{open.credits} charged{open.providerCostMinor != null ? ` · vendor ${(open.providerCostMinor / 100).toFixed(2)}` : ''}</dd>
              <dt>Timing</dt><dd>{new Date(open.createdAt).toLocaleString()} → {open.finishedAt ? new Date(open.finishedAt).toLocaleString() : '…'}</dd>
              {open.failureKind && <><dt>Failure</dt><dd className={styles.danger}>{open.failureKind}: {open.failureReason}</dd></>}
            </dl>
            {action && (
              <div className={styles.card}>
                <div className={styles.cardTitle}>{action === 'fail' ? 'End this generation and return the credits' : 'Refund the credits as goodwill (outputs stay)'}</div>
                <Textarea label="Reason (on the record)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} />
                <div style={{ display: 'flex', gap: 'var(--s-2)' }}><Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button><Button variant="danger" onClick={act} loading={busy} disabled={reason.trim().length < 4}>Confirm</Button></div>
              </div>
            )}
            <div><div className={styles.cardTitle}>Input</div><pre className="json">{JSON.stringify(open.input, null, 2)}</pre></div>
            <div><div className={styles.cardTitle}>Outputs</div><pre className="json">{JSON.stringify(open.outputs, null, 2)}</pre></div>
            {open.children.length > 0 && <div><div className={styles.cardTitle}>Shots</div><pre className="json">{JSON.stringify(open.children.map((c) => { const x = c as { id: string; status: string; providerKey: string | null; failureKind: string | null }; return { id: x.id, status: x.status, providerKey: x.providerKey, failureKind: x.failureKind }; }), null, 2)}</pre></div>}
          </div>
        )}
      </Dialog>
    </div>
  );
}
