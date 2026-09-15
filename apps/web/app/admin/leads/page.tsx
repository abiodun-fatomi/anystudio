'use client';
/**
 * Platform leads: every message from the contact form on /org, newest
 * first. The list is for scanning — who, how much, how soon, answered or
 * not — and narrows by status and by the days it came in. A row opens the
 * whole message in a dialog, where the reply is one click (a mailto with
 * the subject filled in) and "Mark handled" is the other.
 */
import { useState } from 'react';
import { api, type AdminLead } from '@/lib/api';
import { PageHeader, Section } from '@/components/shell/Page';
import { Badge, Button, Dialog, EmptyState, Input, Pager, Select, Skeleton, Table, tableCell, useCursorPages, useToast } from '@/components/ui';
import styles from '../admin.module.css';

type Status = 'all' | 'new' | 'handled';

const STATUS: Array<{ value: Status; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'Needs a reply' },
  { value: 'handled', label: 'Handled' },
];

/** "15 Sep 2026, 02:26" — the day first, because that is what you scan for. */
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const replyHref = (l: AdminLead) => `mailto:${l.email}?subject=${encodeURIComponent(`AnyStudio — ${l.organization}`)}`;

export default function LeadsAdminPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<AdminLead | null>(null);
  const [busy, setBusy] = useState(false);
  const filtered = status !== 'all' || from !== '' || to !== '';

  const leads = useCursorPages<AdminLead>((cursor, take) => api.admin.leads({ status, from: from || undefined, to: to || undefined, cursor, take }), {
    size: 25,
    deps: [status, from, to],
  });

  const setHandled = async (l: AdminLead, handled: boolean) => {
    setBusy(true);
    try {
      const updated = await api.admin.setLeadHandled(l.id, handled);
      toast({ title: handled ? 'Marked handled' : 'Opened again', body: l.organization, tone: 'ok' });
      setOpen((cur) => (cur && cur.id === l.id ? { ...cur, ...updated } : cur));
      void leads.reload();
    } catch (e) {
      toast({ title: 'Not changed', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    setStatus('all');
    setFrom('');
    setTo('');
  };

  return (
    <div className="rise">
      <PageHeader
        title="Platform leads"
        lede="Every message from the contact form on /org, whole. Open one to read it and reply; mark it handled once you have. A copy of each also lands in the team inbox."
      />
      <Section title="Messages">
        <div className={styles.toolbar}>
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status)} options={STATUS} />
          <Input label="From" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          {filtered && (
            <Button variant="ghost" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>

        {leads.rows === null ? (
          <Skeleton height={160} />
        ) : leads.rows.length === 0 ? (
          <EmptyState
            title={filtered ? 'Nothing matches' : 'No platform has written in yet'}
            body={
              filtered
                ? 'Widen the dates or set the status back to All.'
                : 'When one fills in the form on /org, it appears here the same second, and a copy goes to the team inbox.'
            }
            actions={
              filtered ? (
                <Button variant="ghost" onClick={clear}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Organization</th>
                  <th>Per month</th>
                  <th>Live by</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leads.rows.map((l) => (
                  <tr key={l.id} data-lead={l.id} className={styles.clickRow} onClick={() => setOpen(l)}>
                    <td className={tableCell.shrink}>{when(l.createdAt)}</td>
                    <td>
                      <strong>{l.organization}</strong>
                      <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>
                        {l.email}
                        {l.role ? ` · ${l.role}` : ''}
                      </div>
                    </td>
                    <td>{l.volume ?? '—'}</td>
                    <td>{l.timeline ?? '—'}</td>
                    <td className={tableCell.shrink}>
                      <Badge tone={l.handledAt ? 'ok' : 'accent'} dot>
                        {l.handledAt ? 'Handled' : 'Needs a reply'}
                      </Badge>
                    </td>
                    <td className={tableCell.shrink}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(l);
                        }}
                      >
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              page={leads.page}
              count={leads.rows.length}
              noun="messages"
              size={leads.size}
              hasOlder={leads.hasOlder}
              hasNewer={leads.hasNewer}
              busy={leads.busy}
              onOlder={() => void leads.older()}
              onNewer={() => void leads.newer()}
              onSize={(n) => void leads.changeSize(n)}
            />
          </>
        )}
      </Section>

      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.organization ?? ''}
        description={open ? `Received ${when(open.createdAt)}${open.handledAt ? ` · handled ${when(open.handledAt)}` : ''}` : undefined}
        locked={busy}
        footer={
          open && (
            <>
              <Button variant="ghost" onClick={() => setOpen(null)} disabled={busy}>
                Close
              </Button>
              <Button variant={open.handledAt ? 'ghost' : 'subtle'} onClick={() => void setHandled(open, !open.handledAt)} disabled={busy}>
                {open.handledAt ? 'Open again' : 'Mark handled'}
              </Button>
              <Button href={replyHref(open)}>Reply by email</Button>
            </>
          )
        }
      >
        {open && (
          <>
            <dl className={styles.kv}>
              <dt>From</dt>
              <dd>
                <a href={`mailto:${open.email}`}>{open.email}</a>
                {open.role ? <span style={{ color: 'var(--muted)' }}> · {open.role}</span> : null}
              </dd>
              <dt>Images and reels per month</dt>
              <dd>{open.volume ?? '—'}</dd>
              <dt>Wants to be live</dt>
              <dd>{open.timeline ?? '—'}</dd>
              <dt>Status</dt>
              <dd>
                <Badge tone={open.handledAt ? 'ok' : 'accent'} dot>
                  {open.handledAt ? 'Handled' : 'Needs a reply'}
                </Badge>
              </dd>
            </dl>
            <div style={{ marginTop: 'var(--s-4)' }}>
              <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)', marginBottom: 'var(--s-1)' }}>Anything that would stop this working</div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
                {open.notes ?? <span style={{ color: 'var(--muted)' }}>Nothing added.</span>}
              </p>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
