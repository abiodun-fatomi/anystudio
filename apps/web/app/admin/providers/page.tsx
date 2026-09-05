'use client';
/** Which vendor serves what, on or off, in what order; the breakers; and what each thing costs in credits. */
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminProvider } from '@/lib/api';
import { PageHeader } from '@/components/shell/Page';
import { Button, Dialog, Input, Skeleton, Switch, Table, Textarea, tableCell, useToast } from '@/components/ui';
import { useAdmin } from '../AdminShell';
import styles from '../admin.module.css';

export default function ProvidersPage() {
  const { atLeast } = useAdmin();
  const { toast } = useToast();
  const [data, setData] = useState<{ capabilities: string[]; providers: AdminProvider[] } | null>(null);
  const [prices, setPrices] = useState<Array<{ code: string; credits: number; label: string }> | null>(null);
  const [edit, setEdit] = useState<{ code: string; credits: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.admin
      .providers()
      .then(setData)
      .catch(() => setData(null));
    if (atLeast('ADMIN'))
      api.admin
        .prices()
        .then(setPrices)
        .catch(() => setPrices([]));
  }, [atLeast]);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (p: AdminProvider) => {
    const reason = window.prompt(`${p.enabled ? 'Turn off' : 'Turn on'} ${p.key} for ${p.capability}. Why? (on the record)`);
    if (!reason || reason.trim().length < 4) return;
    try {
      await api.admin.patchProvider(p.capability, p.key, { enabled: !p.enabled, reason: reason.trim() });
      toast({ title: `${p.key} ${p.enabled ? 'off' : 'on'} for ${p.capability}`, tone: 'ok' });
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const priority = async (p: AdminProvider) => {
    const v = window.prompt(`Priority for ${p.key} (${p.capability}); lower is tried first`, String(p.priority));
    if (!v || !Number(v)) return;
    try {
      await api.admin.patchProvider(p.capability, p.key, { priority: Number(v), reason: 'reordered from the console' });
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const reset = async (p: AdminProvider) => {
    try {
      await api.admin.resetBreaker(p.capability, p.key);
      toast({ title: 'Breaker closed', body: 'The next request is a probe.', tone: 'ok' });
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const savePrice = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api.admin.patchPrice(edit.code, Number(edit.credits), edit.reason.trim());
      toast({ title: 'Price changed', body: 'New requests pay the new price; rows already made keep theirs.', tone: 'ok' });
      setEdit(null);
      load();
    } catch (e) {
      toast({ title: 'Refused', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rise">
      <PageHeader
        title="Providers & prices"
        lede="A row is a vendor serving a capability. The router tries enabled rows by priority; a breaker opens on repeated failures and closes itself after ten minutes, or here, now."
      />
      {!data ? (
        <Skeleton height={300} />
      ) : (
        data.capabilities.map((cap) => {
          const rows = data.providers.filter((p) => p.capability === cap);
          if (rows.length === 0) return null;
          return (
            <div key={cap} className={styles.card} style={{ marginBottom: 'var(--s-4)' }}>
              <div className={styles.cardTitle}>{cap}</div>
              <Table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Priority</th>
                    <th>Adapter</th>
                    <th>Breaker</th>
                    <th className={tableCell.num}>Calls, 24h</th>
                    <th>Tier</th>
                    <th>Note</th>
                    <th>On</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.key}>
                      <td className={styles.mono}>
                        <strong>{p.key}</strong>
                      </td>
                      <td>
                        <button type="button" className={styles.pill} onClick={() => atLeast('OPERATOR') && priority(p)} title="Change">
                          {p.priority}
                        </button>
                      </td>
                      <td>{p.registered ? <span className={styles.ok}>ready</span> : <span className={styles.warn}>no key here</span>}</td>
                      <td>
                        {p.breakerOpen ? (
                          <>
                            <span className={styles.danger}>open</span>{' '}
                            {atLeast('OPERATOR') && (
                              <Button variant="ghost" size="sm" onClick={() => reset(p)}>
                                Close it
                              </Button>
                            )}
                          </>
                        ) : (
                          <span className={styles.ok}>closed</span>
                        )}
                      </td>
                      <td className={tableCell.num}>{p.callsLast24h}</td>
                      <td>{p.workspaceType?.toLowerCase() ?? 'all'}</td>
                      <td style={{ fontSize: 'var(--t-1)', color: 'var(--muted)', maxWidth: 360 }}>{p.licenceNote}</td>
                      <td>
                        <Switch label="" checked={p.enabled} onChange={() => toggle(p)} disabled={!atLeast('OPERATOR')} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          );
        })
      )}
      {prices && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Prices in credits</div>
          <Table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th className={tableCell.num}>Credits</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {prices.map((c) => (
                <tr key={c.code}>
                  <td className={styles.mono}>{c.code}</td>
                  <td>{c.label}</td>
                  <td className={tableCell.num}>{c.credits}</td>
                  <td>
                    {atLeast('ADMIN') && (
                      <Button variant="ghost" size="sm" onClick={() => setEdit({ code: c.code, credits: String(c.credits), reason: '' })}>
                        Change
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={`Change ${edit?.code}`}
        description="Takes effect for new requests immediately. Rows already made keep the price they were charged."
        locked={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={savePrice} loading={busy} disabled={!edit || !edit.credits || edit.reason.trim().length < 4}>
              Change price
            </Button>
          </>
        }
      >
        {edit && (
          <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
            <Input label="Credits" type="number" value={edit.credits} onChange={(e) => setEdit({ ...edit, credits: e.target.value })} />
            <Textarea
              label="Reason (on the record)"
              value={edit.reason}
              onChange={(e) => setEdit({ ...edit, reason: e.target.value })}
              rows={2}
              maxLength={300}
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}
