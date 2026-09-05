'use client';
/**
 * The developer section belongs to organizations. A personal or business
 * workspace that lands here is told so and offered the one way through:
 * create an organization workspace (its own wallet, its own keys), which
 * the switcher then shows beside the others.
 */
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Button, Dialog, EmptyState, Input, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';

export function OrganizationGate({ children }: { children: ReactNode }) {
  const { workspace, refreshMe, switchWorkspace } = useApp();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (workspace.type === 'ORGANIZATION') return <>{children}</>;

  const create = async () => {
    setBusy(true);
    try {
      const ws = await api.workspace.create({ name: name.trim(), type: 'ORGANIZATION' });
      await refreshMe();
      switchWorkspace(ws.id);
      setOpen(false);
      toast({ title: `${ws.name} created`, body: 'You are now in it. Create a project and mint a key.', tone: 'ok' });
    } catch (e) {
      toast({ title: 'Could not create it', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <EmptyState
        icon={<Icon.code />}
        title="The API is for organizations"
        body={`${workspace.name} is a ${workspace.type === 'BUSINESS' ? 'business' : 'personal'} workspace. Building a storefront, a marketplace or an app on top of the studio? Create an organization workspace — it gets its own credits, projects, API keys and webhooks, and this section.`}
        actions={
          <>
            <Button onClick={() => setOpen(true)}>Create an organization</Button>
            <Button variant="ghost" href="/studio">
              Back to the studio
            </Button>
          </>
        }
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New organization"
        description="A workspace for your company's integration. You own it; invite your engineers from Settings → Workspace."
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
        <Input label="Organization name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Commerce" maxLength={80} autoFocus />
      </Dialog>
    </>
  );
}
