'use client';
/**
 * The workspace switcher in the top bar. Always a menu — even with one
 * workspace there is somewhere to go from here: the workspace's settings,
 * and a new business or organization workspace (its own credits, its own
 * members, and for an organization the developer section).
 */
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Avatar, Button, Dialog, Input, MenuHeading, MenuItem, MenuSeparator, Popover, SegmentedControl, useToast } from '@/components/ui';
import { Icon } from './icons';
import styles from './AppShell.module.css';

const WS_TYPE: Record<string, string> = { PERSONAL: 'Personal', BUSINESS: 'Business', ORGANIZATION: 'Organization' };

type NewType = 'BUSINESS' | 'ORGANIZATION';

export function WorkspaceSwitcher() {
  const { workspace, workspaces, switchWorkspace, refreshMe } = useApp();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<NewType>('BUSINESS');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const ws = await api.workspace.create({ name: name.trim(), type });
      await refreshMe();
      setOpen(false);
      setName('');
      toast({
        title: `${ws.name} created`,
        body: type === 'ORGANIZATION' ? 'Opening it on the organization portal. The Developer section is yours.' : 'You are in it now.',
        tone: 'ok',
      });
      // An organization lives on the org. host; this walks across when it must.
      switchWorkspace(ws.id, type);
    } catch (e) {
      toast({ title: 'Could not create it', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const trigger = (
    <button type="button" className={styles.wsBtn} data-tour="workspace" aria-label={`Workspace: ${workspace.name}. Switch or create a workspace`}>
      <Avatar name={workspace.name} size="sm" square />
      <span className={styles.wsText}>
        <span className={styles.wsName}>{workspace.name}</span>
        <span className={styles.wsType}>{WS_TYPE[workspace.type] ?? workspace.type}</span>
      </span>
      <Icon.chevron width={16} height={16} />
    </button>
  );

  return (
    <>
      <Popover menu trigger={trigger}>
        {(close) => (
          <>
            <MenuHeading>{workspaces.length > 1 ? 'Switch workspace' : 'Your workspace'}</MenuHeading>
            {workspaces.map((w) => (
              <MenuItem
                key={w.id}
                onSelect={() => {
                  if (w.id !== workspace.id) switchWorkspace(w.id);
                  close();
                }}
                leading={w.id === workspace.id ? <Icon.check width={16} height={16} /> : <span style={{ width: 16, display: 'inline-block' }} />}
              >
                <span style={{ display: 'grid', lineHeight: 1.2 }}>
                  <span>{w.name}</span>
                  <span className={styles.wsType}>{WS_TYPE[w.type] ?? w.type}</span>
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem href="/settings/workspace" onSelect={close} leading={<Icon.settings width={16} height={16} />}>
              Workspace settings
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                setOpen(true);
              }}
              leading={<Icon.plus width={16} height={16} />}
            >
              New workspace…
            </MenuItem>
          </>
        )}
      </Popover>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="New workspace"
        description="A workspace has its own credits, brand kit, library and members. You own it; invite people from Settings → Workspace."
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={name.trim().length < 2}>
              Create
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <SegmentedControl<NewType>
            label="Kind of workspace"
            value={type}
            onChange={setType}
            items={[
              { id: 'BUSINESS', label: 'Business' },
              { id: 'ORGANIZATION', label: 'Organization' },
            ]}
          />
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'var(--t-2)' }}>
            {type === 'BUSINESS'
              ? 'For a shop or a brand: the studio, WhatsApp and publishing, with a team if you want one.'
              : 'For a company building on the studio: everything a business has, plus projects, API keys and webhooks in the Developer section.'}
          </p>
          <Input
            label="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'BUSINESS' ? 'Ada Fabrics' : 'Acme Commerce'}
            maxLength={80}
            autoFocus
          />
        </div>
      </Dialog>
    </>
  );
}
