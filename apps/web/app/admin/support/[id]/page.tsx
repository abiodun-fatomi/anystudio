'use client';
/**
 * One help chat: the whole thread — the person, the assistant, the team —
 * with a reply box that lands in the person's floater and rings their bell.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, type AdminSupportDetail } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Skeleton, Textarea, useToast } from '@/components/ui';
import styles from '../../admin.module.css';
import chat from './thread.module.css';

const WHO: Record<string, string> = { USER: 'Person', ASSISTANT: 'Assistant', STAFF: 'Team', SYSTEM: 'Greeting' };

export default function SupportThreadPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [d, setD] = useState<AdminSupportDetail | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api.admin.supportOne(id).then(setD).catch(() => setD(null)), [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [d?.messages.length]);

  const reply = async () => {
    const t = text.trim(); if (!t || !d) return;
    setBusy(true);
    try { await api.admin.supportReply(d.id, t); setText(''); await load(); toast({ title: 'Sent — it is in their chat and their bell', tone: 'ok' }); }
    catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const resolve = async () => { if (!d) return; try { await api.admin.supportResolve(d.id); await load(); } catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); } };
  const close = async () => {
    if (!d || !window.confirm('Close this chat? The person gets a transcript by email.')) return;
    try { await api.admin.supportClose(d.id); await load(); toast({ title: 'Closed — transcript sent', tone: 'ok' }); } catch (e) { toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void reply(); } };

  if (!d) return <div className="rise"><PageHeader title="Help chat" /><Skeleton height={320} /></div>;
  const meta = new Map(d.messagesMeta.map((m) => [m.id, m.meta as { model?: string; fallback?: string } | null]));
  return (
    <div className="rise">
      <PageHeader title={d.topic ?? 'Help chat'} lede={`${d.user.name ?? d.user.email ?? 'Someone'} · opened ${new Date(d.createdAt).toLocaleString()}${d.closedAt ? ` · closed ${new Date(d.closedAt).toLocaleString()}` : ''}`}
        actions={d.status === 'OPEN' ? <>{d.needsHuman && <Button variant="ghost" onClick={resolve}>Mark handled</Button>}<Button variant="ghost" onClick={close}>Close &amp; send transcript</Button></> : undefined} />
      <div className={styles.two} style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
        <div className={styles.card} style={{ gap: 0, padding: 0, overflow: 'hidden' }}>
          <div className={chat.thread}>
            {d.messages.map((m) => {
              const mm = meta.get(m.id);
              return (
                <div key={m.id} className={chat.msg} data-role={m.role}>
                  <div className={chat.who}>{m.role === 'STAFF' ? `${m.who ?? 'Team'} · team` : WHO[m.role]}<span>{new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>{mm?.fallback && <em className={styles.warn}>assistant unavailable ({mm.fallback})</em>}</div>
                  <div className={chat.bubble}>{m.text}</div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          {d.status === 'OPEN' ? (
            <div className={chat.reply}>
              <Textarea label="Reply as the team" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={3} maxLength={4000} placeholder="Lands in their chat and their bell. ⌘/Ctrl+Enter to send." />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button onClick={reply} loading={busy} disabled={!text.trim()}>Send reply</Button></div>
            </div>
          ) : <div className={chat.reply} style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Closed{d.transcriptSentAt ? ` · transcript emailed ${new Date(d.transcriptSentAt).toLocaleString()}` : ' · no transcript sent'}.</div>}
        </div>
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <div className={styles.card}>
            <div className={styles.cardTitle}>State</div>
            <dl className={styles.kv}>
              <dt>Status</dt><dd>{d.status === 'CLOSED' ? <span className={styles.pill}>closed</span> : d.needsHuman ? <span className={styles.pill} data-tone="warn">needs a person</span> : <span className={styles.pill} data-tone="ok">with the assistant</span>}</dd>
              <dt>Team</dt><dd>{d.staffJoined ? 'has written in it' : 'not yet'}</dd>
              <dt>Page</dt><dd className={styles.mono}>{d.page ?? '—'}</dd>
              <dt>Messages</dt><dd>{d.messages.filter((m) => m.role !== 'SYSTEM').length}</dd>
            </dl>
          </div>
          <div className={styles.card}>
            <div className={styles.cardTitle}>Person</div>
            <dl className={styles.kv}>
              <dt>Name</dt><dd><Link href={`/admin/customers/${d.user.id}`}>{d.user.name ?? '—'}</Link></dd>
              <dt>Email</dt><dd className={styles.mono}>{d.user.email ?? '—'}</dd>
              <dt>Phone</dt><dd className={styles.mono}>{d.user.phone ?? '—'}</dd>
              <dt>Account</dt><dd>{d.user.status.toLowerCase()} · since {new Date(d.user.createdAt).toLocaleDateString()}</dd>
              {d.workspace && <><dt>Workspace</dt><dd><Link href={`/admin/workspaces/${d.workspace.id}`}>{d.workspace.name}</Link> <span style={{ color: 'var(--muted)' }}>({d.workspace.type.toLowerCase()})</span></dd></>}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
