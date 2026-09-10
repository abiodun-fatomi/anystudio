'use client';
/** Who can open this console, at what rank, granted by whom, until when. */
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminStaffGrant } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Select, Skeleton, Table, Textarea, useToast } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

export default function StaffPage() {
  const { atLeast, me } = useAdmin();
  const { toast } = useToast();
  const [rows, setRows] = useState<AdminStaffGrant[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'SUPPORT', reason: '', expiresAt: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.admin
      .staff()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const grant = async () => {
    setBusy(true);
    try {
      await api.admin.grantStaff({
        email: form.email.trim(),
        role: form.role,
        reason: form.reason.trim(),
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
      });
      toast({ title: 'Granted', body: 'They sign in at this host with their second factor.', tone: 'ok' });
      setOpen(false);
      setForm({ email: '', role: 'SUPPORT', reason: '', expiresAt: '' });
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (g: AdminStaffGrant) => {
    if (!window.confirm(`Revoke ${g.user.email}'s ${g.role} access?`)) return;
    try {
      await api.admin.revokeStaff(g.id);
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  return (
    <div className="rise">
      <PageHeader
        title="Staff"
        lede="SUPPORT reads. OPERATOR turns providers on and off, adjusts credits, refunds, suspends. ADMIN changes prices, writes platform messages and grants access. Nobody grants themselves."
        actions={<Button onClick={() => setOpen(true)}>Grant access</Button>}
      />
      {rows === null ? (
        <Skeleton height={200} />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Rank</th>
              <th>Reason</th>
              <th>Granted by</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id}>
                <td>
                  <strong>{g.user.name ?? g.user.email}</strong>
                  <div style={{ fontSize: 'var(--t-1)', color: 'var(--muted)' }}>{g.user.email}</div>
                </td>
                <td className={styles.mono}>{g.role}</td>
                <td style={{ fontSize: 'var(--t-1)' }}>{g.reason}</td>
                <td>{g.grantedBy}</td>
                <td>{g.expiresAt ? new Date(g.expiresAt).toLocaleDateString() : 'never'}</td>
                <td>
                  {g.user.id !== me.user.id && (
                    <Button variant="ghost" size="sm" onClick={() => revoke(g)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Grant staff access"
        description="They need an account with a confirmed second factor; the console refuses a session without one."
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={grant} loading={busy} disabled={!form.email.includes('@') || form.reason.trim().length < 4}>
              Grant
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Input label="Email of an existing account" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoFocus />
          <Select
            label="Rank"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            options={[
              { value: 'SUPPORT', label: 'SUPPORT — read' },
              { value: 'OPERATOR', label: 'OPERATOR — providers, credits, refunds' },
              { value: 'ADMIN', label: 'ADMIN — prices, messages, staff' },
              ...(atLeast('SUPERADMIN') ? [{ value: 'SUPERADMIN', label: 'SUPERADMIN' }] : []),
            ]}
          />
          <Textarea
            label="Reason (on the record)"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            rows={2}
            maxLength={300}
          />
          <Input label="Expires (optional)" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
        </div>
      </Dialog>
    </div>
  );
}
