'use client';
/**
 * Careers in the console: write an opening, publish it (it appears on
 * /careers the same minute), close it; read the applications that came
 * back, move them along, keep notes, open the CV.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminApplication, type AdminJob, type ApplicationStatus, type JobStatus, type JobType } from '@/lib/api';
import { PageHeader, Section } from '@/components/shell/Page';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Pager,
  Select,
  Skeleton,
  Switch,
  Table,
  Textarea,
  tableCell,
  useCursorPages,
  useToast,
} from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

const JOB_TONE: Record<JobStatus, 'ok' | 'warn' | undefined> = { OPEN: 'ok', DRAFT: 'warn', CLOSED: undefined };
const APP_STATUSES: ApplicationStatus[] = ['NEW', 'REVIEWING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'];
const APP_TONE: Record<ApplicationStatus, 'accent' | 'ok' | 'warn' | 'danger' | 'cyan' | undefined> = {
  NEW: 'accent',
  REVIEWING: 'cyan',
  INTERVIEW: 'warn',
  OFFER: 'ok',
  HIRED: 'ok',
  REJECTED: undefined,
};
const TYPES: Array<{ value: JobType; label: string }> = [
  { value: 'FULL_TIME', label: 'Full time' },
  { value: 'PART_TIME', label: 'Part time' },
  { value: 'CONTRACT', label: 'Contract' },
  { value: 'INTERNSHIP', label: 'Internship' },
];
const EMPTY: Partial<AdminJob> = {
  title: '',
  team: '',
  location: '',
  remote: true,
  type: 'FULL_TIME',
  summary: '',
  description: '',
  salary: '',
  status: 'DRAFT',
};

export default function CareersAdminPage() {
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  const [editing, setEditing] = useState<Partial<AdminJob> | null>(null);
  const [deleting, setDeleting] = useState<AdminJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobFilter, setJobFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [open, setOpen] = useState<AdminApplication | null>(null);
  const [notes, setNotes] = useState('');

  const [waitlist, setWaitlist] = useState<Array<{ source: string; count: number }> | null>(null);
  const load = useCallback(() => {
    api.admin
      .jobs()
      .then(setJobs)
      .catch(() => setJobs([]));
    api.admin
      .waitlist()
      .then((w) => setWaitlist(w.bySource))
      .catch(() => setWaitlist([]));
  }, []);
  useEffect(load, [load]);

  const apps = useCursorPages<AdminApplication>(
    (cursor, take) => api.admin.applications({ jobId: jobFilter || undefined, status: statusFilter || undefined, cursor, take }),
    {
      size: 25,
      deps: [jobFilter, statusFilter],
    },
  );

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const body = { ...editing, salary: editing.salary?.trim() || null } as Parameters<typeof api.admin.createJob>[0];
      if (editing.id) await api.admin.updateJob(editing.id, body);
      else await api.admin.createJob(body);
      toast({
        title: editing.id ? 'Opening saved' : 'Opening created',
        body: editing.status === 'OPEN' ? 'It is live on /careers.' : 'It is a draft until you open it.',
        tone: 'ok',
      });
      setEditing(null);
      load();
    } catch (e) {
      toast({ title: 'Not saved', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (j: AdminJob, status: JobStatus) => {
    try {
      await api.admin.updateJob(j.id, { status });
      toast({ title: status === 'OPEN' ? 'Published' : status === 'CLOSED' ? 'Closed' : 'Back to draft', tone: 'ok' });
      load();
    } catch (e) {
      toast({ title: 'Not changed', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.admin.deleteJob(deleting.id);
      toast({ title: 'Deleted', tone: 'ok' });
      setDeleting(null);
      load();
    } catch (e) {
      toast({ title: 'Not deleted', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const openApplication = async (a: AdminApplication) => {
    setOpen(a);
    setNotes(a.notes ?? '');
    try {
      const full = await api.admin.application(a.id);
      setOpen(full);
    } catch {
      /* the row is enough to read */
    }
  };
  const patchApplication = async (patch: { status?: ApplicationStatus; notes?: string | null }) => {
    if (!open) return;
    try {
      const updated = await api.admin.updateApplication(open.id, patch);
      setOpen({ ...open, ...updated });
      void apps.reload();
      load();
    } catch (e) {
      toast({ title: 'Not saved', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };

  const f = editing ?? EMPTY;
  const set = (k: keyof AdminJob, v: unknown) => setEditing((cur) => ({ ...(cur ?? EMPTY), [k]: v }));
  const canSave =
    (f.title?.trim().length ?? 0) >= 3 &&
    (f.team?.trim().length ?? 0) >= 2 &&
    (f.location?.trim().length ?? 0) >= 2 &&
    (f.summary?.trim().length ?? 0) >= 10 &&
    (f.description?.trim().length ?? 0) >= 40;

  return (
    <div className="rise">
      <PageHeader
        title="Careers"
        lede="Openings appear on /careers the minute they are opened. Applications arrive here with the CV; every applicant gets a confirmation email."
        actions={atLeast('ADMIN') ? <Button onClick={() => setEditing({ ...EMPTY })}>New opening</Button> : undefined}
      />

      {waitlist && waitlist.length > 0 && (
        <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>
          Mobile-app waitlist: {waitlist.map((w) => `${w.count.toLocaleString()} (${w.source})`).join(' · ')}.
        </p>
      )}

      <Section title="Openings">
        {jobs === null ? (
          <Skeleton height={80} />
        ) : jobs.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>No openings yet. Write one and open it when it is ready.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Team</th>
                <th>Where</th>
                <th>Status</th>
                <th className={tableCell.num}>Applications</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <strong>{j.title}</strong>
                    <div className={styles.mono} style={{ color: 'var(--muted)', fontSize: 11 }}>
                      /careers/{j.slug}
                    </div>
                  </td>
                  <td>{j.team}</td>
                  <td>
                    {j.location}
                    {j.remote ? ' · remote' : ''}
                  </td>
                  <td className={tableCell.shrink}>
                    <Badge tone={JOB_TONE[j.status]}>{j.status.toLowerCase()}</Badge>
                  </td>
                  <td className={tableCell.num}>
                    {j.applications}
                    {j.newApplications > 0 && <span style={{ color: 'var(--accent)', fontSize: 'var(--t-1)' }}> · {j.newApplications} new</span>}
                  </td>
                  <td className={tableCell.shrink}>
                    {atLeast('ADMIN') && (
                      <span style={{ display: 'inline-flex', gap: 'var(--s-1)', flexWrap: 'wrap' }}>
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ ...j })}>
                          Edit
                        </Button>
                        {j.status !== 'OPEN' && (
                          <Button size="sm" variant="ghost" onClick={() => void setStatus(j, 'OPEN')}>
                            Open
                          </Button>
                        )}
                        {j.status === 'OPEN' && (
                          <Button size="sm" variant="ghost" onClick={() => void setStatus(j, 'CLOSED')}>
                            Close
                          </Button>
                        )}
                        {j.applications === 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setDeleting(j)}>
                            Delete
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setJobFilter(j.id)}>
                          Applications
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Applications">
        <div className={styles.toolbar}>
          <Select
            label="Opening"
            value={jobFilter}
            onChange={(e) => setJobFilter(e.target.value)}
            options={[{ value: '', label: 'Any opening' }, ...(jobs ?? []).map((j) => ({ value: j.id, label: j.title }))]}
          />
          <Select
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[{ value: '', label: 'Any status' }, ...APP_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))]}
          />
        </div>
        {apps.rows === null ? (
          <Skeleton height={120} />
        ) : apps.rows.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Nothing here yet.</p>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Applicant</th>
                  <th>Opening</th>
                  <th>Status</th>
                  <th>CV</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {apps.rows.map((a) => (
                  <tr key={a.id}>
                    <td className={tableCell.shrink}>{new Date(a.createdAt).toLocaleString()}</td>
                    <td>
                      <strong>{a.name}</strong>
                      <div style={{ color: 'var(--muted)', fontSize: 'var(--t-1)' }}>{a.email}</div>
                    </td>
                    <td>{a.job.title}</td>
                    <td className={tableCell.shrink}>
                      <Badge tone={APP_TONE[a.status]}>{a.status.toLowerCase()}</Badge>
                    </td>
                    <td className={tableCell.shrink}>{a.hasCv ? (a.cvName ?? 'yes') : '—'}</td>
                    <td className={tableCell.shrink}>
                      <Button size="sm" variant="ghost" onClick={() => void openApplication(a)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              page={apps.page}
              count={apps.rows.length}
              noun="applications"
              size={apps.size}
              hasOlder={apps.hasOlder}
              hasNewer={apps.hasNewer}
              busy={apps.busy}
              onOlder={() => void apps.older()}
              onNewer={() => void apps.newer()}
              onSize={(n) => void apps.changeSize(n)}
            />
          </>
        )}
      </Section>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit opening' : 'New opening'}
        description="Paragraphs separated by a blank line. A line ending with a colon becomes a heading; lines starting with “- ” become a list."
        wide
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={busy} disabled={!canSave}>
              {editing?.status === 'OPEN' ? 'Save & publish' : 'Save draft'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          <Input
            label="Title"
            value={f.title ?? ''}
            onChange={(e) => set('title', e.target.value)}
            maxLength={120}
            placeholder="Founding engineer, studio pipeline"
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
            <Input label="Team" value={f.team ?? ''} onChange={(e) => set('team', e.target.value)} maxLength={60} placeholder="Engineering" />
            <Input
              label="Location"
              value={f.location ?? ''}
              onChange={(e) => set('location', e.target.value)}
              maxLength={80}
              placeholder="Lagos or remote (WAT ±3)"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--s-3)', alignItems: 'end' }}>
            <Select label="Type" value={f.type ?? 'FULL_TIME'} onChange={(e) => set('type', e.target.value)} options={TYPES} />
            <Input
              label="Salary"
              optional
              value={f.salary ?? ''}
              onChange={(e) => set('salary', e.target.value)}
              maxLength={120}
              placeholder="₦18m–₦30m + equity"
            />
            <Switch label="Remote ok" checked={f.remote ?? true} onChange={(e) => set('remote', e.target.checked)} />
          </div>
          <Input
            label="Summary"
            value={f.summary ?? ''}
            onChange={(e) => set('summary', e.target.value)}
            maxLength={300}
            hint="One or two sentences for the list."
          />
          <Textarea
            label="The posting"
            value={f.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
            rows={12}
            maxLength={20000}
            showCount
          />
          {editing?.id && (
            <Input label="URL name" value={f.slug ?? ''} onChange={(e) => set('slug', e.target.value)} hint="Changing it breaks links already shared." />
          )}
          <Select
            label="Status"
            value={f.status ?? 'DRAFT'}
            onChange={(e) => set('status', e.target.value)}
            options={[
              { value: 'DRAFT', label: 'Draft — not shown' },
              { value: 'OPEN', label: 'Open — live on /careers' },
              { value: 'CLOSED', label: 'Closed' },
            ]}
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        busy={busy}
        title={`Delete “${deleting?.title}”?`}
        description="It has no applications, so nothing is lost."
        confirmLabel="Delete"
        danger
      />

      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.name ?? ''}
        description={open ? `${open.job.title} · applied ${new Date(open.createdAt).toLocaleString()}` : undefined}
        sheet="right"
        wide
      >
        {open && (
          <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
            <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap', alignItems: 'end' }}>
              <Select
                label="Status"
                value={open.status}
                onChange={(e) => void patchApplication({ status: e.target.value as ApplicationStatus })}
                options={APP_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
                disabled={!atLeast('OPERATOR')}
              />
              {open.cvUrl ? (
                <a className={styles.pill} href={open.cvUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', fontWeight: 600 }}>
                  Open CV{open.cvName ? ` · ${open.cvName}` : ''} ↗
                </a>
              ) : open.hasCv ? (
                <span style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>Fetching the CV link…</span>
              ) : (
                <span style={{ color: 'var(--muted)', fontSize: 'var(--t-2)' }}>No CV attached</span>
              )}
            </div>
            <div style={{ fontSize: 'var(--t-2)', display: 'grid', gap: 4 }}>
              <div>
                <a href={`mailto:${open.email}`}>{open.email}</a>
                {open.phone ? ` · ${open.phone}` : ''}
              </div>
              {open.links && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--f-mono)', fontSize: 'var(--t-1)' }}>{open.links}</pre>}
            </div>
            {open.coverNote && (
              <div>
                <div className={styles.cardTitle}>In their words</div>
                <p style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--t-2)', lineHeight: 1.6, margin: 0 }}>{open.coverNote}</p>
              </div>
            )}
            <Textarea
              label="Notes (staff only)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              maxLength={4000}
              disabled={!atLeast('OPERATOR')}
            />
            {atLeast('OPERATOR') && (
              <Button size="sm" variant="subtle" onClick={() => void patchApplication({ notes })} disabled={notes === (open.notes ?? '')}>
                Save notes
              </Button>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
