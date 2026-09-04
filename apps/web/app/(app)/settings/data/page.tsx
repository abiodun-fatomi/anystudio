'use client';
/**
 * Your data — what we hold, and the door out.
 *
 * Export is a JSON file built in the browser from one API call. Deletion
 * is a date: thirty days out, cancellable by signing in and pressing one
 * button, refused while the person still owns a workspace with other
 * people in it.
 */
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Button, Dialog, Input, Skeleton, useToast } from '@/components/ui';
import { useProfile, fieldErrors } from '../useProfile';
import { ReauthField, type ReauthValue } from '../ReauthField';
import styles from '../settings.module.css';

export default function DataPage() {
  const { toast } = useToast();
  const { refreshMe } = useApp();
  const { profile, reload } = useProfile();
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(false);
  const [reauth, setReauth] = useState<ReauthValue>({});
  const [typed, setTyped] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!profile) return <div className={styles.group}><Skeleton style={{ height: 180 }} /></div>;

  const exportAll = async () => {
    setExporting(true);
    try {
      const data = await api.account.export();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `anystudio-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { toast({ title: 'Could not export', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setExporting(false); }
  };
  const requestDeletion = async () => {
    setBusy(true); setErrors({});
    try {
      const r = await api.account.requestDeletion(reauth);
      setOpen(false); setReauth({}); setTyped('');
      await Promise.all([reload(), refreshMe()]);
      toast({ title: 'Deletion scheduled', body: `Everything goes on ${new Date(r.deleteOn).toLocaleDateString()}. Sign in before then to keep it.`, tone: 'warn', durationMs: 10_000 });
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setErrors(fieldErrors(e));
      else toast({ title: 'Could not schedule that', body: e instanceof Error ? e.message : undefined, tone: 'danger', durationMs: 0 });
    } finally { setBusy(false); }
  };
  const keep = async () => {
    setBusy(true);
    try { await api.account.cancelDeletion(); await Promise.all([reload(), refreshMe()]); toast({ title: 'Your account stays', tone: 'ok' }); }
    finally { setBusy(false); }
  };

  return (
    <>
      {profile.deletion && (
        <div className={styles.notice} data-tone="danger" role="alert">
          <strong>This account is scheduled for deletion on {new Date(profile.deletion.deleteOn).toLocaleDateString()}.</strong>
          <span>Everything — photos, videos, copy, credits — goes that day. Change your mind any time before then.</span>
          <div><Button size="sm" onClick={() => void keep()} loading={busy}>Keep my account</Button></div>
        </div>
      )}

      <section className={styles.group} aria-labelledby="d-export">
        <div className={styles.groupHead}><div><h2 id="d-export" className={styles.groupTitle}>Download your data</h2><p className={styles.groupLede}>One file with your profile, sign-in history, consent record, workspaces, every generation and the credit ledger. Media files are listed by name; download those from the Library.</p></div><Button variant="subtle" onClick={() => void exportAll()} loading={exporting}>Download JSON</Button></div>
      </section>

      <section className={styles.group} aria-labelledby="d-keep">
        <div className={styles.groupHead}><div><h2 id="d-keep" className={styles.groupTitle}>What we keep, and for how long</h2></div></div>
        <div style={{ display: 'grid', gap: 'var(--s-2)', fontSize: 'var(--t-2)', color: 'var(--ink-soft)', lineHeight: 'var(--lh-body)' }}>
          <p>Your uploads and the things made from them stay until you delete them or your account. Provider copies of a source photo are deleted after the generation finishes.</p>
          <p>The credit ledger is kept for seven years after the account closes, because it is a financial record. It is anonymised — no name, no email — the day the account is deleted.</p>
          <p>Security events are kept for ninety days. Consent records are kept as long as the account exists and for two years after.</p>
        </div>
      </section>

      {!profile.deletion && (
        <section className={styles.group} data-danger="true" aria-labelledby="d-del">
          <div className={styles.groupHead}><div><h2 id="d-del" className={styles.groupTitle}>Delete your account</h2><p className={styles.groupLede}>Thirty days after you ask, everything is gone: workspaces you own, their media, their credits. Signing in before then and pressing one button cancels it.</p></div><Button variant="danger" onClick={() => setOpen(true)}>Delete my account</Button></div>
        </section>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="Delete your account?" description="We wait thirty days, then delete everything. Unused credits are not refunded. If you own a workspace that other people use, hand it over first."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Keep it</Button><Button variant="danger" onClick={() => void requestDeletion()} loading={busy} disabled={typed !== 'DELETE'}>Schedule deletion</Button></>}>
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          <ReauthField profile={profile} value={reauth} onChange={setReauth} errors={errors} autoFocus />
          <Input label="Type DELETE to confirm" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} autoComplete="off" />
        </div>
      </Dialog>
    </>
  );
}
