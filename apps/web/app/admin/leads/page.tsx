'use client';
/**
 * Platform leads: everything a platform typed into the contact form on
 * /org, newest first, with a way to say "I've answered this". The form is
 * the reason for the call back, so the whole of it is here — organization,
 * who wrote, what they move a month, when they want to be live, and what
 * they think would stop it. Reply by email; the address is a mailto.
 */
import { useState } from 'react';
import { api, type AdminLead } from '@/lib/api';
import { PageHeader, Section } from '@/components/shell/Page';
import { Badge, Button, Pager, Select, Skeleton, Table, tableCell, useCursorPages, useToast } from '@/components/ui';
import styles from '../admin.module.css';

export default function LeadsAdminPage() {
  const { toast } = useToast();
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [open, setOpen] = useState<string | null>(null);
  const leads = useCursorPages<AdminLead>((cursor, take) => api.admin.leads({ show, cursor, take }), { size: 25, deps: [show] });

  const setHandled = async (l: AdminLead, handled: boolean) => {
    try {
      await api.admin.setLeadHandled(l.id, handled);
      toast({ title: handled ? 'Marked handled' : 'Opened again', body: l.organization, tone: 'ok' });
      void leads.reload();
    } catch (e) {
      toast({ title: 'Not changed', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };

  return (
    <div className="rise">
      <PageHeader
        title="Platform leads"
        lede="What platforms wrote in the contact form on /org, whole. A copy goes to the MAIL_FROM inbox; this page has them either way."
      />
      <Section title="Leads">
        <div className={styles.toolbar}>
          <Select
            label="Show"
            value={show}
            onChange={(e) => setShow(e.target.value as 'open' | 'all')}
            options={[
              { value: 'open', label: 'Waiting for a reply' },
              { value: 'all', label: 'Everything, handled too' },
            ]}
          />
        </div>
        {leads.rows === null ? (
          <Skeleton height={120} />
        ) : leads.rows.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>
            {show === 'open' ? 'Nothing waiting. Every lead has been answered.' : 'No platform has written in yet.'}
          </p>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Organization</th>
                  <th>Volume</th>
                  <th>Live by</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leads.rows.map((l) => {
                  const expanded = open === l.id;
                  return (
                    <tr key={l.id} data-lead={l.id}>
                      <td className={tableCell.shrink}>{new Date(l.createdAt).toLocaleString()}</td>
                      <td>
                        <strong>{l.organization}</strong>
                        <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>
                          <a href={`mailto:${l.email}?subject=${encodeURIComponent(`AnyStudio — ${l.organization}`)}`}>{l.email}</a>
                          {l.role ? ` · ${l.role}` : ''}
                        </div>
                        {expanded && (
                          <div style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-2)', whiteSpace: 'pre-wrap' }}>
                            <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>Anything that would stop this working</div>
                            {l.notes ?? '—'}
                          </div>
                        )}
                      </td>
                      <td>{l.volume ?? '—'}</td>
                      <td>{l.timeline ?? '—'}</td>
                      <td className={tableCell.shrink}>
                        <Badge tone={l.handledAt ? undefined : 'accent'}>{l.handledAt ? 'handled' : 'new'}</Badge>
                      </td>
                      <td className={tableCell.shrink}>
                        <span style={{ display: 'inline-flex', gap: 'var(--s-1)', flexWrap: 'wrap' }}>
                          <Button size="sm" variant="ghost" onClick={() => setOpen(expanded ? null : l.id)}>
                            {expanded ? 'Less' : 'Read'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void setHandled(l, !l.handledAt)}>
                            {l.handledAt ? 'Open again' : 'Mark handled'}
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager
              page={leads.page}
              count={leads.rows.length}
              noun="leads"
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
    </div>
  );
}
