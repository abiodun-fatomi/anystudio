'use client';
/**
 * Profile — the person, not the business. Name and picture show up in the
 * workspace member list and on invitations; language sets the default for
 * copy; the time zone makes timestamps on the security screen readable.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { Button, Input, Select, Skeleton, useToast, LoadError } from '@/components/ui';
import { useProfile, fieldErrors } from '../useProfile';
import { ReauthField, type ReauthValue } from '../ReauthField';
import styles from '../settings.module.css';

const LOCALES = [
  { value: '', label: 'Same as my browser' }, { value: 'en', label: 'English' }, { value: 'en-NG', label: 'English (Nigeria)' }, { value: 'en-GH', label: 'English (Ghana)' },
  { value: 'en-KE', label: 'English (Kenya)' }, { value: 'en-ZA', label: 'English (South Africa)' }, { value: 'fr', label: 'Français' }, { value: 'pt', label: 'Português' },
  { value: 'pt-BR', label: 'Português (Brasil)' }, { value: 'yo', label: 'Yorùbá' }, { value: 'ha', label: 'Hausa' }, { value: 'ig', label: 'Igbo' }, { value: 'sw', label: 'Kiswahili' },
];
const ZONES = ['Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Addis_Ababa', 'Africa/Kinshasa', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Kolkata'];

export default function ProfilePage() {
  const { workspace, refreshMe } = useApp();
  const { toast } = useToast();
  const { profile, error, reload } = useProfile();
  const [draft, setDraft] = useState<{ name?: string; locale?: string; timezone?: string }>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [reauth, setReauth] = useState<ReauthValue>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const browserZone = useRef<string>('');
  useEffect(() => { try { browserZone.current = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* fine */ } }, []);

  if (!profile && error) return <div className={styles.group}><LoadError what="your profile" message={error} onRetry={() => void reload()} /></div>;
  if (!profile) return <div className={styles.group}><Skeleton style={{ height: 180 }} /></div>;

  const v = { name: profile.name ?? '', locale: profile.locale ?? '', timezone: profile.timezone ?? '', ...draft };
  const dirty = Object.keys(draft).length > 0;
  const zones = ZONES.includes(browserZone.current) || !browserZone.current ? ZONES : [browserZone.current, ...ZONES];

  const save = async () => {
    setSaving(true);
    try {
      await api.account.updateProfile({ name: v.name.trim() || undefined, locale: v.locale || null, timezone: v.timezone || null });
      setDraft({});
      await Promise.all([reload(), refreshMe()]);
      toast({ title: 'Profile saved', tone: 'ok' });
    } catch (e) {
      toast({ title: 'Could not save', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally { setSaving(false); }
  };

  const pickPicture = async (file: File) => {
    setUploading(true);
    try {
      const asset = await uploadFile(workspace.id, file);
      await api.account.updateProfile({ avatarKey: asset.key });
      await Promise.all([reload(), refreshMe()]);
    } catch (e) {
      toast({ title: 'That picture did not upload', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally { setUploading(false); }
  };

  const changeEmail = async () => {
    setSending(true); setErrors({});
    try {
      await api.account.requestEmailChange(newEmail.trim(), reauth);
      toast({ title: 'Check the new inbox', body: `We sent a link to ${newEmail.trim()}. Nothing changes until it is opened.`, tone: 'ok', durationMs: 8000 });
      setNewEmail(''); setReauth({});
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setErrors(fieldErrors(e));
      else toast({ title: 'Could not start that', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally { setSending(false); }
  };

  return (
    <>
      <section className={styles.group} aria-labelledby="p-you">
        <div className={styles.groupHead}><div><h2 id="p-you" className={styles.groupTitle}>You</h2><p className={styles.groupLede}>Your name and picture appear to people you work with.</p></div></div>
        <div className={styles.avatarRow}>
          <div className={styles.avatarBig}>{profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : (profile.name ?? '?').split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}</div>
          <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickPicture(f); e.target.value = ''; }} />
            <Button variant="subtle" size="sm" loading={uploading} onClick={() => fileInput.current?.click()}>{profile.avatarKey ? 'Change picture' : 'Add a picture'}</Button>
            {profile.avatarKey && <Button variant="ghost" size="sm" onClick={() => void api.account.updateProfile({ avatarKey: null }).then(() => Promise.all([reload(), refreshMe()]))}>Remove</Button>}
          </div>
        </div>
        <div className={styles.grid2}>
          <Input label="Name" value={v.name} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          <Input label="Phone" value={profile.phone ?? ''} readOnly hint={profile.phoneVerifiedAt ? 'Verified' : 'Changing your number is a support request for now.'} />
          <Select label="Language for captions and copy" options={LOCALES} value={v.locale} onChange={(e) => setDraft((d) => ({ ...d, locale: e.target.value }))} />
          <Select label="Time zone" options={[{ value: '', label: 'Same as my browser' }, ...zones.map((z) => ({ value: z, label: z.replace('_', ' ') }))]} value={v.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))} />
        </div>
        <div className={styles.saveBar}>
          {dirty && <Button variant="ghost" onClick={() => setDraft({})} disabled={saving}>Discard</Button>}
          <Button onClick={() => void save()} loading={saving} disabled={!dirty}>Save</Button>
        </div>
      </section>

      <section className={styles.group} aria-labelledby="p-email">
        <div className={styles.groupHead}><div><h2 id="p-email" className={styles.groupTitle}>Email</h2><p className={styles.groupLede}>Where sign-in links, receipts and security notices go.</p></div>{profile.emailVerifiedAt ? <span className={styles.on}>✓ Verified</span> : <Button variant="subtle" size="sm" onClick={() => void api.auth.resendVerification().then(() => toast({ title: 'Sent', body: 'Check your inbox for the confirmation link.', tone: 'ok' }))}>Resend confirmation</Button>}</div>
        <Input label="Current email" value={profile.email ?? ''} readOnly />
        {profile.pendingEmail && (
          <div className={styles.notice} data-tone="info">
            <strong>Waiting on {profile.pendingEmail.email}</strong>
            <span>Open the link we sent there to finish the change. It works until {new Date(profile.pendingEmail.expiresAt).toLocaleString()}.</span>
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void changeEmail(); }} className={styles.grid2}>
          <Input label="New email" type="email" autoComplete="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} error={errors.email} />
          <ReauthField profile={profile} value={reauth} onChange={setReauth} errors={errors} />
          <div className={styles.saveBar} style={{ gridColumn: '1 / -1' }}>
            <Button type="submit" variant="subtle" loading={sending} disabled={!newEmail.includes('@')}>Send confirmation link</Button>
          </div>
        </form>
      </section>
    </>
  );
}
