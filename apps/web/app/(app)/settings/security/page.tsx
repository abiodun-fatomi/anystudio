'use client';
/**
 * Security — password, two-step, the devices that are signed in, the ways
 * in, and the log of what has happened.
 *
 * Every mutation here re-proves a credential (ReauthField), and every one
 * of them is also announced to the email the person had beforehand. The
 * screen says so, because a person who is worried wants to know what will
 * happen before they press the button.
 */
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, type ActivityRow, type SessionRow } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Badge, Button, ConfirmDialog, Dialog, Input, Skeleton, useToast, PasswordInput, LoadError } from '@/components/ui';
import { useProfile, fieldErrors } from '../useProfile';
import { ReauthField, type ReauthValue } from '../ReauthField';
import styles from '../settings.module.css';

const EVENT_WORDS: Record<string, string> = {
  SIGNED_UP: 'Account created',
  LOGIN_SUCCEEDED: 'Signed in',
  LOGIN_FAILED: 'Wrong password',
  LOGGED_OUT: 'Signed out',
  MFA_CHALLENGED: 'Two-step asked',
  MFA_FAILED: 'Wrong code',
  STEP_UP_COMPLETED: 'Two-step confirmed',
  PASSWORD_CHANGED: 'Password changed',
  MFA_ENROLLED: 'Two-step turned on',
  MFA_REMOVED: 'Two-step turned off',
  SESSION_REVOKED: 'A device was signed out',
  REFRESH_REUSE_DETECTED: 'A stolen session was blocked',
  EMAIL_CHANGE_REQUESTED: 'Email change started',
  EMAIL_CHANGED: 'Email changed',
  IDENTITY_UNLINKED: 'Sign-in method removed',
  RECOVERY_CODES_REGENERATED: 'New recovery codes',
  ACCOUNT_DELETION_REQUESTED: 'Deletion scheduled',
  ACCOUNT_DELETION_CANCELLED: 'Deletion cancelled',
};
const PROVIDER_WORDS: Record<string, string> = { PASSWORD: 'Email and password', GOOGLE: 'Google', WHATSAPP: 'WhatsApp', PASSKEY: 'Passkey' };

function when(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function SecurityPage() {
  const { toast } = useToast();
  const { signOut } = useApp();
  const { profile, error, reload } = useProfile();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const loadLists = useCallback(async () => {
    const [s, a] = await Promise.all([api.account.sessions().catch(() => []), api.account.activity().catch(() => [])]);
    setSessions(s);
    setActivity(a);
  }, []);
  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  // ---- password
  const [pw, setPw] = useState<{ reauth: ReauthValue; next: string; again: string }>({ reauth: {}, next: '', again: '' });
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({});
  const [pwBusy, setPwBusy] = useState(false);
  const changePassword = async () => {
    if (pw.next !== pw.again) {
      setPwErrors({ again: 'These do not match.' });
      return;
    }
    setPwBusy(true);
    setPwErrors({});
    try {
      const r = await api.account.changePassword(pw.next, pw.reauth);
      setPw({ reauth: {}, next: '', again: '' });
      toast({
        title: profile?.hasPassword ? 'Password changed' : 'Password set',
        body: r.otherSessionsEnded ? `${r.otherSessionsEnded} other device${r.otherSessionsEnded === 1 ? ' was' : 's were'} signed out.` : undefined,
        tone: 'ok',
      });
      await Promise.all([reload(), loadLists()]);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setPwErrors(fieldErrors(e));
      else toast({ title: 'Could not change it', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setPwBusy(false);
    }
  };

  // ---- two-step
  const [enrol, setEnrol] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [enrolCode, setEnrolCode] = useState('');
  const [enrolErr, setEnrolErr] = useState<string | undefined>();
  const [enrolBusy, setEnrolBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disable, setDisable] = useState<ReauthValue & { code?: string }>({});
  const [disableErr, setDisableErr] = useState<Record<string, string>>({});
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenCode, setRegenCode] = useState('');
  const [busy, setBusy] = useState(false);

  const startEnrol = async () => {
    try {
      const r = await api.account.mfaEnrol();
      const qr = await QRCode.toDataURL(r.uri, { margin: 1, width: 352, errorCorrectionLevel: 'M' });
      setEnrol({ ...r, qr });
      setEnrolCode('');
      setEnrolErr(undefined);
    } catch (e) {
      toast({ title: 'Could not start', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };
  const confirmEnrol = async () => {
    setEnrolBusy(true);
    setEnrolErr(undefined);
    try {
      const r = await api.account.mfaConfirm(enrolCode);
      setEnrol(null);
      setCodes(r.recoveryCodes);
      await reload();
      await loadLists();
    } catch (e) {
      setEnrolErr(e instanceof ApiError && e.status === 400 ? (fieldErrors(e).code ?? e.message) : e instanceof Error ? e.message : 'Try again.');
    } finally {
      setEnrolBusy(false);
    }
  };
  const doDisable = async () => {
    setBusy(true);
    setDisableErr({});
    try {
      await api.account.mfaDisable(disable);
      setDisableOpen(false);
      setDisable({});
      toast({ title: 'Two-step is off', body: 'Your password alone signs in now. We emailed you about this.', tone: 'warn' });
      await reload();
      await loadLists();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setDisableErr(fieldErrors(e));
      else toast({ title: 'Could not turn it off', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const doRegen = async () => {
    setBusy(true);
    try {
      const r = await api.account.recoveryCodes(regenCode);
      setRegenOpen(false);
      setRegenCode('');
      setCodes(r.recoveryCodes);
      await reload();
    } catch (e) {
      toast({ title: 'That code did not match', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  // ---- sessions & identities
  const [signOutAll, setSignOutAll] = useState(false);
  const revoke = async (id: string) => {
    await api.account.revokeSession(id);
    await loadLists();
  };
  const revokeOthers = async () => {
    setBusy(true);
    try {
      const r = await api.account.revokeOtherSessions();
      toast({ title: `${r.count} device${r.count === 1 ? '' : 's'} signed out`, tone: 'ok' });
      await loadLists();
    } finally {
      setBusy(false);
      setSignOutAll(false);
    }
  };
  const unlink = async (id: string) => {
    try {
      await api.account.unlinkIdentity(id);
      await reload();
    } catch (e) {
      toast({ title: 'Cannot remove that', body: e instanceof Error ? e.message : undefined, tone: 'warn' });
    }
  };

  if (!profile && error)
    return (
      <div className={styles.group}>
        <LoadError what="your security settings" message={error} onRetry={() => void reload()} />
      </div>
    );
  if (!profile)
    return (
      <div className={styles.group}>
        <Skeleton style={{ height: 180 }} />
      </div>
    );

  const askCode = !profile.hasPassword && profile.mfa.enabled;

  return (
    <>
      {/* ---- password ---- */}
      <section className={styles.group} aria-labelledby="s-pw">
        <div className={styles.groupHead}>
          <div>
            <h2 id="s-pw" className={styles.groupTitle}>
              {profile.hasPassword ? 'Password' : 'Set a password'}
            </h2>
            <p className={styles.groupLede}>
              {profile.hasPassword
                ? 'Changing it signs out every other device and emails you.'
                : 'You sign in with Google. A password is a second way in if that ever stops working.'}
            </p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void changePassword();
          }}
          className={styles.grid2}
        >
          <ReauthField profile={profile} value={pw.reauth} onChange={(r) => setPw((p) => ({ ...p, reauth: r }))} errors={pwErrors} />
          {!profile.hasPassword && !askCode && <div />}
          <PasswordInput
            label="New password"
            autoComplete="new-password"
            minLength={8}
            value={pw.next}
            onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))}
            error={pwErrors.newPassword}
            hint="At least 8 characters. A sentence you will remember beats a word you will not."
          />
          <PasswordInput
            label="New password, again"
            autoComplete="new-password"
            value={pw.again}
            onChange={(e) => setPw((p) => ({ ...p, again: e.target.value }))}
            error={pwErrors.again}
          />
          <div className={styles.saveBar} style={{ gridColumn: '1 / -1' }}>
            <Button type="submit" loading={pwBusy} disabled={pw.next.length < 8 || !pw.again}>
              {profile.hasPassword ? 'Change password' : 'Set password'}
            </Button>
          </div>
        </form>
      </section>

      {/* ---- two-step ---- */}
      <section className={styles.group} aria-labelledby="s-mfa">
        <div className={styles.groupHead}>
          <div>
            <h2 id="s-mfa" className={styles.groupTitle}>
              Two-step sign-in
            </h2>
            <p className={styles.groupLede}>
              A six-digit code from an authenticator app on your phone, asked for on new devices. It is what keeps a leaked password from being enough.
            </p>
          </div>
          {profile.mfa.enabled ? <span className={styles.on}>✓ On</span> : <Button onClick={() => void startEnrol()}>Turn on</Button>}
        </div>
        {profile.mfa.enabled && (
          <div className={styles.rows}>
            <div className={styles.row}>
              <div className={styles.rowIcon} aria-hidden="true">
                🔐
              </div>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span>Authenticator app</span>
                </div>
                <div className={styles.rowSub}>
                  {profile.mfa.factors[0]?.lastUsedAt ? `Last used ${when(profile.mfa.factors[0].lastUsedAt)}` : 'Not used yet'}
                </div>
              </div>
              <div className={styles.rowEnd}>
                <Button variant="ghost" size="sm" onClick={() => setDisableOpen(true)}>
                  Turn off
                </Button>
              </div>
            </div>
            <div className={styles.row}>
              <div className={styles.rowIcon} aria-hidden="true">
                🗝
              </div>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span>Recovery codes</span>
                  {profile.mfa.recoveryCodesLeft <= 2 && <Badge tone="warn">{profile.mfa.recoveryCodesLeft} left</Badge>}
                </div>
                <div className={styles.rowSub}>{profile.mfa.recoveryCodesLeft} of 10 unused. Each works once, when your phone is gone.</div>
              </div>
              <div className={styles.rowEnd}>
                <Button variant="ghost" size="sm" onClick={() => setRegenOpen(true)}>
                  Make new codes
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ---- devices ---- */}
      <section className={styles.group} aria-labelledby="s-dev">
        <div className={styles.groupHead}>
          <div>
            <h2 id="s-dev" className={styles.groupTitle}>
              Signed-in devices
            </h2>
            <p className={styles.groupLede}>Anything you do not recognise: sign it out, then change your password.</p>
          </div>
          {sessions && sessions.length > 1 && (
            <Button variant="subtle" size="sm" onClick={() => setSignOutAll(true)}>
              Sign out other devices
            </Button>
          )}
        </div>
        <div className={styles.rows}>
          {sessions === null ? (
            <Skeleton style={{ height: 56 }} />
          ) : (
            sessions.map((s) => (
              <div key={s.id} className={styles.row}>
                <div className={styles.rowIcon} aria-hidden="true">
                  {/iPhone|Android/.test(s.device ?? '') ? '📱' : '💻'}
                </div>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <span>{s.device ?? 'Unknown device'}</span>
                    {s.current && <Badge tone="accent">This device</Badge>}
                    {s.surface !== 'APP' && <Badge mono>{s.surface}</Badge>}
                  </div>
                  <div className={styles.rowSub}>
                    {s.geoLabel ? `${s.geoLabel} · ` : ''}active {when(s.lastSeenAt)} · signed in {new Date(s.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className={styles.rowEnd}>
                  {s.current ? (
                    <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                      Sign out
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => void revoke(s.id)}>
                      Sign out
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ---- ways in ---- */}
      <section className={styles.group} aria-labelledby="s-ids">
        <div className={styles.groupHead}>
          <div>
            <h2 id="s-ids" className={styles.groupTitle}>
              Ways to sign in
            </h2>
            <p className={styles.groupLede}>You always keep at least one.</p>
          </div>
        </div>
        <div className={styles.rows}>
          {profile.identities.map((i) => (
            <div key={i.id} className={styles.row}>
              <div className={styles.rowIcon} aria-hidden="true">
                {i.provider === 'GOOGLE' ? 'G' : i.provider === 'WHATSAPP' ? '💬' : i.provider === 'PASSKEY' ? '🔑' : '✉️'}
              </div>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span>{PROVIDER_WORDS[i.provider] ?? i.provider}</span>
                </div>
                <div className={styles.rowSub}>
                  {i.label ? `${i.label} · ` : ''}
                  {i.lastUsedAt ? `last used ${when(i.lastUsedAt)}` : `added ${new Date(i.createdAt).toLocaleDateString()}`}
                </div>
              </div>
              <div className={styles.rowEnd}>
                {i.provider !== 'PASSWORD' && (
                  <Button variant="ghost" size="sm" onClick={() => void unlink(i.id)}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
          {!profile.identities.some((i) => i.provider === 'GOOGLE') && (
            <div className={styles.row}>
              <div className={styles.rowIcon} aria-hidden="true">
                G
              </div>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span>Google</span>
                </div>
                <div className={styles.rowSub}>Sign in with the Google account that uses {profile.email ?? 'your email'} and it links itself.</div>
              </div>
              <div className={styles.rowEnd}>
                <Button variant="ghost" size="sm" href="/api/v1/auth/google/start?next=/settings/security">
                  Connect
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ---- activity ---- */}
      <section className={styles.group} aria-labelledby="s-act">
        <div className={styles.groupHead}>
          <div>
            <h2 id="s-act" className={styles.groupTitle}>
              Recent activity
            </h2>
            <p className={styles.groupLede}>The last fifty things that touched your account.</p>
          </div>
        </div>
        <div className={styles.rows}>
          {activity === null ? (
            <Skeleton style={{ height: 56 }} />
          ) : activity.length === 0 ? (
            <p className={styles.rowSub} style={{ padding: 'var(--s-3) 0' }}>
              Nothing yet.
            </p>
          ) : (
            activity.map((a) => (
              <div key={a.id} className={styles.row} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <span>{EVENT_WORDS[a.type] ?? a.type.toLowerCase().replace(/_/g, ' ')}</span>
                    {(a.type === 'REFRESH_REUSE_DETECTED' || a.type === 'LOGIN_FAILED' || a.type === 'MFA_FAILED') && (
                      <Badge tone={a.type === 'REFRESH_REUSE_DETECTED' ? 'danger' : 'warn'} dot>
                        {a.type === 'REFRESH_REUSE_DETECTED' ? 'act on this' : 'failed'}
                      </Badge>
                    )}
                  </div>
                  <div className={styles.rowSub}>{[a.device, a.ip].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                <div className={styles.rowSub} style={{ textAlign: 'right' }}>
                  {when(a.createdAt)}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ---- dialogs ---- */}
      <Dialog
        open={enrol !== null}
        onClose={() => setEnrol(null)}
        title="Set up two-step sign-in"
        description="Scan this with Google Authenticator, Authy, 1Password or any authenticator app, then type the code it shows."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEnrol(null)}>
              Cancel
            </Button>
            <Button onClick={() => void confirmEnrol()} loading={enrolBusy} disabled={enrolCode.replace(/\s/g, '').length !== 6}>
              Turn on
            </Button>
          </>
        }
      >
        {enrol && (
          <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
            <div className={styles.qr}>
              <img src={enrol.qr} alt="QR code for your authenticator app" />
              <div style={{ display: 'grid', gap: 'var(--s-2)', fontSize: 'var(--t-2)', minWidth: 0 }}>
                <span style={{ color: 'var(--muted)' }}>Can&apos;t scan? Type this key into the app instead:</span>
                <code className={styles.secret}>{enrol.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              </div>
            </div>
            <Input
              label="The six-digit code the app shows"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={enrolCode}
              onChange={(e) => setEnrolCode(e.target.value)}
              error={enrolErr}
              autoFocus
            />
          </div>
        )}
      </Dialog>

      <Dialog
        open={codes !== null}
        onClose={() => setCodes(null)}
        title="Your recovery codes"
        description="Each works once, in place of a code from the app, if your phone is lost. Save them somewhere that is not the phone. We will not show them again."
        locked
        footer={
          <>
            <Button
              variant="subtle"
              onClick={() => {
                void navigator.clipboard?.writeText((codes ?? []).join('\n'));
                toast({ title: 'Copied', tone: 'ok' });
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setCodes(null)}>I have saved them</Button>
          </>
        }
      >
        <ul className={styles.codes} style={{ padding: 0, margin: 0 }}>
          {(codes ?? []).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="Turn off two-step sign-in?"
        description="Your password alone will sign in. This is the one change that makes every later change easier, so it needs both."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisableOpen(false)}>
              Keep it on
            </Button>
            <Button variant="danger" onClick={() => void doDisable()} loading={busy}>
              Turn off
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          {profile.hasPassword && (
            <PasswordInput
              label="Your password"
              autoComplete="current-password"
              value={disable.currentPassword ?? ''}
              onChange={(e) => setDisable((d) => ({ ...d, currentPassword: e.target.value }))}
              error={disableErr.currentPassword}
            />
          )}
          <Input
            label="Code from the app, or a recovery code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={disable.code ?? ''}
            onChange={(e) => setDisable((d) => ({ ...d, code: e.target.value }))}
            error={disableErr.code}
          />
        </div>
      </Dialog>

      <Dialog
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        title="Make new recovery codes"
        description="The old ones stop working the moment the new ones exist."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRegenOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void doRegen()} loading={busy} disabled={regenCode.length < 6}>
              Make new codes
            </Button>
          </>
        }
      >
        <Input
          label="Code from your authenticator app"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={regenCode}
          onChange={(e) => setRegenCode(e.target.value)}
          autoFocus
        />
      </Dialog>

      <ConfirmDialog
        open={signOutAll}
        onClose={() => setSignOutAll(false)}
        onConfirm={() => void revokeOthers()}
        busy={busy}
        title="Sign out every other device?"
        description="This one stays signed in. Anyone else holding your account is out the moment you confirm."
        confirmLabel="Sign them out"
        danger
      />
    </>
  );
}
