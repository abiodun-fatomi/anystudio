'use client';
/**
 * Webhooks — where to hear that a generation finished. The secret shows
 * once. Each endpoint opens into its deliveries, with the body that was
 * signed and a replay for anything that did not land.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type DevDelivery, type DevProject, type DevWebhook } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Input, Select, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from '../developer.module.css';

const EVENTS = [
  { id: 'generation.succeeded', label: 'Generation succeeded', help: 'Outputs are ready; the body carries signed URLs' },
  { id: 'generation.failed', label: 'Generation failed', help: 'What went wrong, in words you can show a merchant; credits already returned' },
];

export default function WebhooksPage() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const isAdmin = workspace.role === 'OWNER' || workspace.role === 'ADMIN';
  const [hooks, setHooks] = useState<DevWebhook[] | null>(null);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ url: '', projectId: '', events: EVENTS.map((e) => e.id) });
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<DevWebhook | null>(null);
  const [remove, setRemove] = useState<DevWebhook | null>(null);
  const [viewing, setViewing] = useState<DevWebhook | null>(null);
  const [deliveries, setDeliveries] = useState<DevDelivery[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [h, p] = await Promise.all([api.developer.webhooks(workspace.id), api.developer.projects(workspace.id)]);
      setHooks(h);
      setProjects(p);
    } catch {
      setHooks([]);
    }
  }, [workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const loadDeliveries = useCallback(
    async (h: DevWebhook) => {
      setDeliveries(null);
      try {
        setDeliveries(await api.developer.deliveries(workspace.id, h.id));
      } catch {
        setDeliveries([]);
      }
    },
    [workspace.id],
  );
  useEffect(() => {
    if (viewing) void loadDeliveries(viewing);
  }, [viewing, loadDeliveries]);

  const create = async () => {
    setBusy(true);
    try {
      const h = await api.developer.createWebhook(workspace.id, { url: form.url.trim(), projectId: form.projectId || undefined, events: form.events });
      setSecret(h);
      setOpen(false);
      setForm({ url: '', projectId: '', events: EVENTS.map((e) => e.id) });
      await load();
    } catch (e) {
      toast({ title: 'Could not add the endpoint', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (h: DevWebhook) => {
    try {
      await api.developer.updateWebhook(workspace.id, h.id, { active: !h.active });
      await load();
    } catch (e) {
      toast({ title: 'Could not change that', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const test = async (h: DevWebhook) => {
    try {
      const { delivery } = await api.developer.testWebhook(workspace.id, h.id);
      toast({
        title: delivery.status === 'SENT' ? `Delivered · HTTP ${delivery.responseStatus}` : `Not delivered · ${delivery.lastError ?? 'no answer'}`,
        body:
          delivery.status === 'SENT'
            ? 'Your endpoint answered 2xx to a signed ping.'
            : 'It will be retried with backoff. Check the endpoint and the signature check.',
        tone: delivery.status === 'SENT' ? 'ok' : 'warn',
      });
      if (viewing?.id === h.id) void loadDeliveries(h);
    } catch (e) {
      toast({ title: 'Could not send the test', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const doRemove = async () => {
    if (!remove) return;
    setBusy(true);
    try {
      await api.developer.deleteWebhook(workspace.id, remove.id);
      setRemove(null);
      if (viewing?.id === remove.id) setViewing(null);
      await load();
    } catch (e) {
      toast({ title: 'Could not remove', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const redeliver = async (d: DevDelivery) => {
    if (!viewing) return;
    try {
      const { delivery } = await api.developer.redeliver(workspace.id, viewing.id, d.id);
      toast({ title: delivery.status === 'SENT' ? 'Delivered' : `Still failing · ${delivery.lastError}`, tone: delivery.status === 'SENT' ? 'ok' : 'warn' });
      void loadDeliveries(viewing);
    } catch (e) {
      toast({ title: 'Could not resend', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      toast({ title: 'Copied', tone: 'ok', durationMs: 1500 });
    } catch {
      toast({ title: 'Select it and copy by hand', tone: 'warn' });
    }
  };

  return (
    <>
      {secret && (
        <div className={styles.reveal} role="alert">
          <strong>Signing secret for {secret.url}. Copy it now — it will not be shown again.</strong>
          <div className={styles.secret}>
            <code>{secret.secret}</code>
            <Button size="sm" leading={<Icon.copy width={14} height={14} />} onClick={() => copy(secret.secret!)}>
              Copy
            </Button>
          </div>
          <div className={styles.rowSub}>
            Verify <span style={{ fontFamily: 'var(--f-mono)' }}>X-AnyStudio-Signature</span> (t=…,v1=…) as HMAC-SHA256 of{' '}
            <span style={{ fontFamily: 'var(--f-mono)' }}>{'"<t>.<raw body>"'}</span>. The quick start has the code.
          </div>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setSecret(null)}>
              I have saved it
            </Button>
          </div>
        </div>
      )}

      <section className={styles.group}>
        <div className={styles.groupHead}>
          <div>
            <div className={styles.groupTitle}>Endpoints</div>
            <div className={styles.groupLede}>
              A signed POST when a generation your key asked for finishes. Failures retry with backoff for a day; twenty in a row pause the endpoint.
            </div>
          </div>
          {isAdmin && (
            <Button leading={<Icon.plus />} onClick={() => setOpen(true)}>
              Add endpoint
            </Button>
          )}
        </div>
        {hooks === null ? (
          <Skeleton height={120} />
        ) : hooks.length === 0 ? (
          <EmptyState icon={<Icon.webhook />} title="No endpoints yet" body="Add one and we will tell it when work is done, instead of you polling." />
        ) : (
          <div className={styles.rows}>
            {hooks.map((h) => (
              <div key={h.id} className={`${styles.row} ${h.active ? '' : styles.rowMuted}`}>
                <div className={styles.rowIcon}>
                  <Icon.webhook width={18} height={18} />
                </div>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <span style={{ fontFamily: 'var(--f-mono)', fontWeight: 500 }}>{h.url}</span>
                    {h.active ? <Badge tone="ok">Active</Badge> : <Badge tone="warn">{h.failures >= 20 ? 'Paused after failures' : 'Paused'}</Badge>}
                  </div>
                  <div className={styles.rowSub}>
                    {h.project ? h.project.name : 'All projects'} ·{' '}
                    {h.events.length === EVENTS.length || h.events.length === 0 ? 'all events' : h.events.join(', ')} ·{' '}
                    {h.lastDeliveryAt ? `last delivery ${new Date(h.lastDeliveryAt).toLocaleString()}` : 'nothing delivered yet'}
                    {h.failures ? ` · ${h.failures} failing` : ''}
                  </div>
                </div>
                <div className={styles.rowEnd}>
                  <Button variant="ghost" size="sm" onClick={() => setViewing(h)}>
                    Deliveries
                  </Button>
                  {isAdmin && (
                    <Button variant="ghost" size="sm" onClick={() => test(h)}>
                      Send test
                    </Button>
                  )}
                  {isAdmin && (
                    <Button variant="ghost" size="sm" onClick={() => toggle(h)}>
                      {h.active ? 'Pause' : 'Resume'}
                    </Button>
                  )}
                  {isAdmin && (
                    <Button variant="ghost" size="sm" onClick={() => setRemove(h)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add an endpoint"
        description="HTTPS only. Answer 2xx quickly and do the work afterwards."
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!/^https:\/\/.+/.test(form.url.trim()) || form.events.length === 0}>
              Add endpoint
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Input
            label="URL"
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            placeholder="https://example.com/anystudio/webhook"
            maxLength={500}
            autoFocus
          />
          <Select
            label="Project"
            value={form.projectId}
            onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
            options={[{ value: '', label: 'All projects' }, ...projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name }))]}
          />
          <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
            {EVENTS.map((e) => (
              <Checkbox
                key={e.id}
                label={e.label}
                hint={e.help}
                checked={form.events.includes(e.id)}
                onChange={(ev) => setForm((f) => ({ ...f, events: ev.target.checked ? [...f.events, e.id] : f.events.filter((x) => x !== e.id) }))}
              />
            ))}
          </div>
        </div>
      </Dialog>

      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} title="Deliveries" description={viewing?.url} wide sheet="right">
        {deliveries === null ? (
          <Skeleton height={200} />
        ) : deliveries.length === 0 ? (
          <EmptyState title="Nothing delivered yet" body="Send a test from the list, or make a request with a key." />
        ) : (
          <div className={styles.rows}>
            {deliveries.map((d) => (
              <div key={d.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <div className={styles.row} style={{ borderBottom: 0 }}>
                  <div className={styles.rowIcon}>{d.status === 'SENT' ? <Icon.check width={18} height={18} /> : <Icon.bell width={18} height={18} />}</div>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>
                      <span style={{ fontFamily: 'var(--f-mono)' }}>{d.event}</span>
                      <Badge tone={d.status === 'SENT' ? 'ok' : d.status === 'FAILED' ? 'danger' : 'warn'}>
                        {d.status === 'SENT' ? `HTTP ${d.responseStatus}` : d.status === 'FAILED' ? 'Gave up' : 'Retrying'}
                      </Badge>
                    </div>
                    <div className={styles.rowSub}>
                      {new Date(d.createdAt).toLocaleString()} · {d.attempts} {d.attempts === 1 ? 'attempt' : 'attempts'}
                      {d.lastError ? ` · ${d.lastError}` : ''}
                      {d.nextAttemptAt ? ` · next ${new Date(d.nextAttemptAt).toLocaleTimeString()}` : ''}
                    </div>
                  </div>
                  <div className={styles.rowEnd}>
                    <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                      {expanded === d.id ? 'Hide body' : 'Body'}
                    </Button>
                    {isAdmin && (
                      <Button variant="ghost" size="sm" onClick={() => redeliver(d)}>
                        Resend
                      </Button>
                    )}
                  </div>
                </div>
                {expanded === d.id && (
                  <pre className={styles.code} style={{ marginBottom: 'var(--s-3)', maxHeight: 320 }}>
                    {JSON.stringify(d.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(remove)}
        onClose={() => setRemove(null)}
        onConfirm={doRemove}
        busy={busy}
        danger
        confirmLabel="Remove endpoint"
        title="Remove this endpoint?"
        description="Pending deliveries are dropped. Your servers stop hearing from us."
      />
    </>
  );
}
