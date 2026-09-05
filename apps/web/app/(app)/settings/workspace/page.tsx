'use client';
/**
 * Workspace — its name, who is in it, and the door out.
 *
 * Roles are shown in words a shop owner uses ("can make things", "can see
 * the money") rather than the enum. The owner is the only one who can make
 * admins, hand the workspace over, or delete it, and the screen only offers
 * what the signed-in person can actually do.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type GrantableRole, type InviteRow, type MemberRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Avatar, Badge, Button, ConfirmDialog, Dialog, Input, Select, Skeleton, useToast } from '@/components/ui';
import styles from '../settings.module.css';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member', BILLING: 'Billing', AUDITOR: 'Viewer' };
const ROLE_HELP: Record<GrantableRole, string> = {
  ADMIN: 'Changes settings, invites people, spends credits.',
  MEMBER: 'Makes things and spends credits.',
  BILLING: 'Sees and tops up credits. Makes nothing.',
  AUDITOR: 'Sees everything. Changes nothing.',
};

export default function WorkspacePage() {
  const { me, workspace, workspaces, refreshMe, switchWorkspace } = useApp();
  const { toast } = useToast();
  const myRole = workspace.role;
  const isOwner = myRole === 'OWNER';
  const isAdmin = isOwner || myRole === 'ADMIN';

  const [name, setName] = useState(workspace.name);
  const [saving, setSaving] = useState(false);
  useEffect(() => setName(workspace.name), [workspace.name]);

  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const load = useCallback(async () => {
    try {
      const r = await api.members.list(workspace.id);
      setMembers(r.members);
      setInvites(r.invites);
    } catch {
      setMembers([]);
    }
  }, [workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState<{ email: string; role: GrantableRole }>({ email: '', role: 'MEMBER' });
  const [busy, setBusy] = useState(false);
  const [transferTo, setTransferTo] = useState<MemberRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const rename = async () => {
    setSaving(true);
    try {
      await api.workspace.rename(workspace.id, name.trim());
      await refreshMe();
      toast({ title: 'Renamed', tone: 'ok' });
    } catch (e) {
      toast({ title: 'Could not rename', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };
  const sendInvite = async () => {
    setBusy(true);
    try {
      await api.members.invite(workspace.id, invite.email.trim(), invite.role);
      toast({ title: 'Invitation sent', body: `${invite.email.trim()} has 7 days to accept.`, tone: 'ok' });
      setInviteOpen(false);
      setInvite({ email: '', role: 'MEMBER' });
      await load();
    } catch (e) {
      toast({ title: 'Could not invite', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const setRole = async (m: MemberRow, role: GrantableRole) => {
    try {
      await api.members.setRole(workspace.id, m.userId, role);
      await load();
    } catch (e) {
      toast({ title: 'Could not change that', body: e instanceof Error ? e.message : undefined, tone: 'warn' });
    }
  };
  const remove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    const leaving = removeTarget.userId === me.user.id;
    try {
      await api.members.remove(workspace.id, removeTarget.userId);
      setRemoveTarget(null);
      if (leaving) {
        await refreshMe();
        const next = workspaces.find((w) => w.id !== workspace.id);
        if (next) switchWorkspace(next.id);
        window.location.assign('/today');
      } else await load();
    } catch (e) {
      toast({ title: 'Could not do that', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const transfer = async () => {
    if (!transferTo) return;
    setBusy(true);
    try {
      await api.members.transfer(workspace.id, transferTo.userId);
      setTransferTo(null);
      await Promise.all([load(), refreshMe()]);
      toast({ title: `${transferTo.name ?? transferTo.email} now owns this workspace`, body: 'You are an admin here.', tone: 'ok' });
    } catch (e) {
      toast({ title: 'Could not transfer', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.workspace.remove(workspace.id, confirmName);
      const next = workspaces.find((w) => w.id !== workspace.id);
      if (next) switchWorkspace(next.id);
      window.location.assign('/today');
    } catch (e) {
      toast({ title: 'Could not delete', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
      setBusy(false);
    }
  };

  return (
    <>
      <section className={styles.group} aria-labelledby="w-name">
        <div className={styles.groupHead}>
          <div>
            <h2 id="w-name" className={styles.groupTitle}>
              Workspace
            </h2>
            <p className={styles.groupLede}>
              {workspace.type === 'PERSONAL' ? 'Your own studio.' : 'A shared studio: everyone in it uses the same credits and brand.'}
            </p>
          </div>
          <Badge mono>{workspace.type}</Badge>
        </div>
        <div className={styles.grid2}>
          <Input
            label="Name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            readOnly={!isAdmin}
            hint={isAdmin ? undefined : 'Only an admin can rename it.'}
          />
          <Input label="Currency" value={workspace.currency} readOnly hint="Changing currency or region is a support request." />
        </div>
        {isAdmin && (
          <div className={styles.saveBar}>
            <Button onClick={() => void rename()} loading={saving} disabled={name.trim() === workspace.name || !name.trim()}>
              Save
            </Button>
          </div>
        )}
      </section>

      <section className={styles.group} aria-labelledby="w-people">
        <div className={styles.groupHead}>
          <div>
            <h2 id="w-people" className={styles.groupTitle}>
              People
            </h2>
            <p className={styles.groupLede}>Everyone here shares this workspace&apos;s credits, brand kit and library.</p>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              Invite someone
            </Button>
          )}
        </div>
        <div className={styles.rows}>
          {members === null ? (
            <Skeleton style={{ height: 56 }} />
          ) : (
            members.map((m) => {
              const self = m.userId === me.user.id;
              const canEdit = !self && m.role !== 'OWNER' && (isOwner || (isAdmin && m.role !== 'ADMIN'));
              return (
                <div key={m.userId} className={styles.row}>
                  <Avatar name={m.name ?? m.email ?? '?'} />
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>
                      <span>{m.name ?? m.email}</span>
                      {self && <Badge tone="accent">You</Badge>}
                      {m.role === 'OWNER' && <Badge>Owner</Badge>}
                    </div>
                    <div className={styles.rowSub}>
                      {m.email}
                      {m.lastLoginAt ? ` · last seen ${new Date(m.lastLoginAt).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                  <div className={styles.rowEnd}>
                    {canEdit ? (
                      <Select
                        aria-label={`Role for ${m.name ?? m.email}`}
                        value={m.role}
                        onChange={(e) => void setRole(m, e.target.value as GrantableRole)}
                        options={(isOwner ? ['ADMIN', 'MEMBER', 'BILLING', 'AUDITOR'] : ['MEMBER', 'BILLING', 'AUDITOR']).map((r) => ({
                          value: r,
                          label: ROLE_LABEL[r]!,
                        }))}
                      />
                    ) : (
                      m.role !== 'OWNER' && <span className={styles.rowSub}>{ROLE_LABEL[m.role] ?? m.role}</span>
                    )}
                    {isOwner && !self && (
                      <Button variant="ghost" size="sm" onClick={() => setTransferTo(m)}>
                        Make owner
                      </Button>
                    )}
                    {canEdit && (
                      <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(m)}>
                        Remove
                      </Button>
                    )}
                    {self && m.role !== 'OWNER' && (
                      <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(m)}>
                        Leave
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {invites.map((i) => (
            <div key={i.id} className={styles.row}>
              <div className={styles.rowIcon} aria-hidden="true">
                ✉️
              </div>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span>{i.email}</span>
                  <Badge tone="warn">Invited</Badge>
                </div>
                <div className={styles.rowSub}>
                  as {ROLE_LABEL[i.role] ?? i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}
                </div>
              </div>
              <div className={styles.rowEnd}>
                {isAdmin && (
                  <Button variant="ghost" size="sm" onClick={() => void api.members.cancelInvite(workspace.id, i.id).then(load)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {isOwner && (
        <section className={styles.group} data-danger="true" aria-labelledby="w-danger">
          <div className={styles.groupHead}>
            <div>
              <h2 id="w-danger" className={styles.groupTitle}>
                Delete this workspace
              </h2>
              <p className={styles.groupLede}>Its photos, videos, copy and remaining credits go with it. Everyone in it loses access. This cannot be undone.</p>
            </div>
            <Button
              variant="danger"
              onClick={() => setDeleteOpen(true)}
              disabled={workspaces.length < 2}
              title={workspaces.length < 2 ? 'This is your only workspace' : undefined}
            >
              Delete workspace
            </Button>
          </div>
          {workspaces.length < 2 && <p className={styles.rowSub}>This is your only workspace. To close everything, delete your account under Your data.</p>}
        </section>
      )}

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite someone"
        description="They get an email with a link that works for 7 days. Only that address can accept it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void sendInvite()} loading={busy} disabled={!invite.email.includes('@')}>
              Send invitation
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          <Input
            label="Email"
            type="email"
            autoComplete="off"
            value={invite.email}
            onChange={(e) => setInvite((v) => ({ ...v, email: e.target.value }))}
            autoFocus
          />
          <Select
            label="What they can do"
            value={invite.role}
            onChange={(e) => setInvite((v) => ({ ...v, role: e.target.value as GrantableRole }))}
            hint={ROLE_HELP[invite.role]}
            options={(isOwner ? ['ADMIN', 'MEMBER', 'BILLING', 'AUDITOR'] : ['MEMBER', 'BILLING', 'AUDITOR']).map((r) => ({ value: r, label: ROLE_LABEL[r]! }))}
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={transferTo !== null}
        onClose={() => setTransferTo(null)}
        onConfirm={() => void transfer()}
        busy={busy}
        title={`Make ${transferTo?.name ?? transferTo?.email ?? 'them'} the owner?`}
        description="They will be the only one who can delete this workspace or hand it on. You stay as an admin."
        confirmLabel="Transfer ownership"
        danger
      />
      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void remove()}
        busy={busy}
        title={removeTarget?.userId === me.user.id ? 'Leave this workspace?' : `Remove ${removeTarget?.name ?? removeTarget?.email ?? 'them'}?`}
        description={
          removeTarget?.userId === me.user.id
            ? 'You lose access to everything in it. An admin can invite you back.'
            : 'They lose access straight away. Anything they made stays here.'
        }
        confirmLabel={removeTarget?.userId === me.user.id ? 'Leave' : 'Remove'}
        danger
      />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this workspace?"
        description={`Type “${workspace.name}” to confirm. Any generation still running has to finish or be cancelled first.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void del()} loading={busy} disabled={confirmName.trim() !== workspace.name}>
              Delete for good
            </Button>
          </>
        }
      >
        <Input label="Workspace name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoFocus />
      </Dialog>
    </>
  );
}
