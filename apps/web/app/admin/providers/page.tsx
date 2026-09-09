'use client';
/** Which vendor serves what, on or off, in what order; the breakers; and what each thing costs in credits. */
import { useCallback, useEffect, useState } from 'react';
import {
  SCENE_PROVIDERS,
  SCENE_ACCEPTANCE_DEFAULT,
  sceneConfig,
  PRESERVATION_POLICIES,
  PRESERVATION_NOT_APPLICABLE,
  preservationAcceptance,
} from '@anystudio/shared';
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
  const [policyEdit, setPolicyEdit] = useState<{
    key: string;
    capability: string;
    field: 'scenePriority' | 'sceneAcceptance' | 'preservationAcceptance';
    useCase?: string;
    value: string;
    reason: string;
  } | null>(null);
  const savePolicy = async () => {
    if (!policyEdit) return;
    setBusy(true);
    try {
      await api.admin.patchProvider(policyEdit.capability, policyEdit.key, {
        [policyEdit.field]: Number(policyEdit.value),
        ...(policyEdit.useCase ? { preservationUseCase: policyEdit.useCase } : {}),
        reason: policyEdit.reason.trim(),
      });
      setPolicyEdit(null);
      toast({ title: 'Policy saved', body: 'Takes effect for the next job; running jobs keep their policy.', tone: 'ok' });
      load();
    } catch (e) {
      toast({ title: 'Not saved', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
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
      {data && (
        <section className={styles.card} style={{ marginBottom: 'var(--s-4)' }} aria-label="New Scene policy">
          <h2 className={styles.cardTitle}>New Scene — quality & provider order</h2>
          <p>
            Lower acceptance allows more changes to the subject. Higher acceptance rejects more results. This does not change Merchant Shots or design checks.
          </p>
          <p>
            Preservation acceptance:{' '}
            <strong>
              {(
                sceneConfig(data.providers.find((p) => p.key === SCENE_PROVIDERS[0].key && p.capability === 'IMAGE_EDIT')?.config).sceneAcceptance ??
                SCENE_ACCEPTANCE_DEFAULT
              ).toFixed(2)}
            </strong>{' '}
            {atLeast('OPERATOR') && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!data.providers.some((p) => p.key === SCENE_PROVIDERS[0].key && p.capability === 'IMAGE_EDIT')}
                onClick={() =>
                  setPolicyEdit({
                    key: SCENE_PROVIDERS[0].key,
                    capability: 'IMAGE_EDIT',
                    field: 'sceneAcceptance',
                    value: String(
                      sceneConfig(data.providers.find((p) => p.key === SCENE_PROVIDERS[0].key && p.capability === 'IMAGE_EDIT')?.config).sceneAcceptance ??
                        SCENE_ACCEPTANCE_DEFAULT,
                    ),
                    reason: '',
                  })
                }
              >
                Change acceptance
              </Button>
            )}
          </p>
          <p>
            Lower rank is tried first. Equal ranks use FLUX, Gemini, Photoroom order. Disabled or unavailable providers are skipped. General priorities below do
            not override these New Scene ranks.
          </p>
          <Table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>New Scene rank</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {SCENE_PROVIDERS.map((defaults) => {
                const row = data.providers.find((p) => p.key === defaults.key && p.capability === defaults.capability);
                return { ...defaults, row, rank: sceneConfig(row?.config).scenePriority ?? defaults.priority };
              })
                .sort((a, b) => a.rank - b.rank || a.priority - b.priority)
                .map((p) => (
                  <tr key={p.key}>
                    <td>{p.key}</td>
                    <td>{p.rank}</td>
                    <td>{!p.row ? 'Awaiting deployment seed' : p.row.enabled ? 'Enabled' : 'Disabled'}</td>
                    <td>
                      {atLeast('OPERATOR') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!p.row}
                          onClick={() => setPolicyEdit({ key: p.key, capability: p.capability, field: 'scenePriority', value: String(p.rank), reason: '' })}
                        >
                          Change rank
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </Table>
        </section>
      )}
      {data && (
        <section className={styles.card} style={{ marginBottom: 'var(--s-4)' }} aria-label="Preservation settings by use case">
          <h2 className={styles.cardTitle}>Preservation acceptance by use case</h2>
          <p>
            <strong>Higher = stricter.</strong> Higher scores are required to accept the generated subject unchanged. Lower values allow more variation and may
            let unwanted changes through. The score is a similarity heuristic, not a percentage guarantee.
          </p>
          <p>
            Start with the defaults, change by 0.05, then review several outputs. Safe original-pixel repair may still rescue a lower-scoring image.
            Repair-location safeguards are not weakened by this setting. Checks apply only when the workflow requests preservation.
          </p>
          <Table>
            <thead>
              <tr>
                <th>Use case</th>
                <th>Acceptance</th>
                <th>Tips / advice</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {PRESERVATION_POLICIES.map((p) => {
                const row = data.providers.find((r) => r.key === p.key && r.capability === p.capability);
                const value = preservationAcceptance(row?.config, p.id);
                return (
                  <tr key={p.id}>
                    <td>{p.label}</td>
                    <td>{value.toFixed(2)}</td>
                    <td>{p.advice}</td>
                    <td>
                      {atLeast('OPERATOR') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!row}
                          onClick={() =>
                            setPolicyEdit({
                              key: p.key,
                              capability: p.capability,
                              field: 'preservationAcceptance',
                              useCase: p.id,
                              value: String(value),
                              reason: '',
                            })
                          }
                        >
                          Change
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {PRESERVATION_NOT_APPLICABLE.map((p) => (
                <tr key={p.label}>
                  <td>{p.label}</td>
                  <td>Not applicable</td>
                  <td>{p.advice}</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
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
                    <th>Configuration tips</th>
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
                      <td style={{ maxWidth: 300 }}>
                        Lower priority runs first among eligible providers. Keep a tested backup enabled.{' '}
                        {cap === 'IMAGE_EDIT'
                          ? 'New Scene uses its dedicated ranks above; design edits have model preferences.'
                          : 'A provider needs a configured adapter and credentials.'}
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
        open={policyEdit !== null}
        onClose={() => setPolicyEdit(null)}
        title={policyEdit?.field === 'scenePriority' ? 'New Scene provider rank' : 'Preservation acceptance'}
        locked={busy}
        footer={
          <Button
            onClick={savePolicy}
            loading={busy}
            disabled={
              !policyEdit ||
              !policyEdit.value.trim() ||
              !Number.isFinite(Number(policyEdit.value)) ||
              Number(policyEdit.value) < (policyEdit.field !== 'scenePriority' ? 0.1 : 1) ||
              Number(policyEdit.value) > (policyEdit.field !== 'scenePriority' ? 1 : 1000) ||
              (policyEdit.field === 'scenePriority' && !Number.isInteger(Number(policyEdit.value))) ||
              policyEdit.reason.trim().length < 4
            }
          >
            Save policy
          </Button>
        }
      >
        {policyEdit && (
          <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
            <Input
              label={policyEdit.field !== 'scenePriority' ? 'Acceptance (0.10–1.00; higher is stricter)' : 'Rank (1–1000; lower runs first)'}
              type="number"
              min={policyEdit.field !== 'scenePriority' ? 0.1 : 1}
              max={policyEdit.field !== 'scenePriority' ? 1 : 1000}
              step={policyEdit.field !== 'scenePriority' ? 0.01 : 1}
              value={policyEdit.value}
              onChange={(e) => setPolicyEdit({ ...policyEdit, value: e.target.value })}
            />
            <Textarea
              label="Reason (on the record)"
              value={policyEdit.reason}
              onChange={(e) => setPolicyEdit({ ...policyEdit, reason: e.target.value })}
              maxLength={300}
            />
          </div>
        )}
      </Dialog>
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
