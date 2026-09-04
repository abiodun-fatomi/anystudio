'use client';
/**
 * Notifications. Two kinds of switch that look the same and are not:
 * product notices (a switch on the user row) and marketing consent (an
 * append-only record of the exact sentence, because Meta and the law both
 * ask to see it). The wording constants ARE the consent text: change them
 * and the next save records the new sentence.
 */
import { useEffect, useState } from 'react';
import { api, type Notifications } from '@/lib/api';
import { Button, Skeleton, Switch, useToast } from '@/components/ui';
import styles from '../settings.module.css';

const WORDING = {
  email: 'Email me tips, new features and occasional offers from AnyStudio. I can stop this any time.',
  whatsapp: 'Send me tips, new features and occasional offers on WhatsApp. I can reply STOP any time.',
};

export default function NotificationsPage() {
  const { toast } = useToast();
  const [n, setN] = useState<Notifications | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => { api.account.notifications().then(setN).catch(() => setN(null)); }, []);
  if (!n) return <div className={styles.group}><Skeleton style={{ height: 180 }} /></div>;

  const flip = async (key: keyof Notifications['switches'], value: boolean) => {
    setSaving(key);
    const prev = n;
    setN({ ...n, switches: { ...n.switches, [key]: value } });
    try { setN(await api.account.updateNotifications({ switches: { [key]: value } })); }
    catch (e) { setN(prev); toast({ title: 'Could not save', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setSaving(null); }
  };
  const consent = async (channel: 'emailMarketing' | 'whatsappMarketing', granted: boolean) => {
    setSaving(channel);
    try { setN(await api.account.updateNotifications({ [channel]: { granted, wording: channel === 'emailMarketing' ? WORDING.email : WORDING.whatsapp }, sourceUrl: window.location.href })); }
    catch (e) { toast({ title: 'Could not save', body: e instanceof Error ? e.message : undefined, tone: 'danger' }); }
    finally { setSaving(null); }
  };

  return (
    <>
      <section className={styles.group} aria-labelledby="n-work">
        <div className={styles.groupHead}><div><h2 id="n-work" className={styles.groupTitle}>About your work</h2><p className={styles.groupLede}>Things you would want to know even if you never opened this screen.</p></div></div>
        <Switch label="Email me when a video or a batch finishes" hint="Only when you are not in the studio at the time." checked={n.switches.generationDoneEmail} disabled={saving !== null} onChange={(e) => void flip('generationDoneEmail', e.target.checked)} />
        <Switch label="Message me on WhatsApp when a video finishes" hint="Needs a WhatsApp number on your profile." checked={n.switches.generationDoneWhatsApp} disabled={saving !== null} onChange={(e) => void flip('generationDoneWhatsApp', e.target.checked)} />
        <Switch label="Email me when credits run low" hint="Once, when the balance would not cover a video." checked={n.switches.lowCreditsEmail} disabled={saving !== null} onChange={(e) => void flip('lowCreditsEmail', e.target.checked)} />
        <Switch label="A weekly note on what you made and what worked" checked={n.switches.weeklyDigest} disabled={saving !== null} onChange={(e) => void flip('weeklyDigest', e.target.checked)} />
        <p className={styles.rowSub} style={{ whiteSpace: 'normal' }}>Security notices — a new sign-in, a changed password — are always sent. They are not optional, because they are how you find out.</p>
      </section>

      <section className={styles.group} aria-labelledby="n-mkt">
        <div className={styles.groupHead}><div><h2 id="n-mkt" className={styles.groupTitle}>From AnyStudio</h2><p className={styles.groupLede}>Off unless you turn it on. We keep a record of exactly what you agreed to, and when.</p></div></div>
        <Switch label={WORDING.email} hint={n.emailMarketing.at ? `${n.emailMarketing.granted ? 'Agreed' : 'Declined'} ${new Date(n.emailMarketing.at).toLocaleDateString()}` : 'Not asked yet'} checked={n.emailMarketing.granted} disabled={saving !== null} onChange={(e) => void consent('emailMarketing', e.target.checked)} />
        <Switch label={WORDING.whatsapp} hint={n.whatsappMarketing.at ? `${n.whatsappMarketing.granted ? 'Agreed' : 'Declined'} ${new Date(n.whatsappMarketing.at).toLocaleDateString()}` : 'Not asked yet'} checked={n.whatsappMarketing.granted} disabled={saving !== null} onChange={(e) => void consent('whatsappMarketing', e.target.checked)} />
        <div className={styles.saveBar}><Button variant="ghost" size="sm" href="/settings/data">See what we hold about you</Button></div>
      </section>
    </>
  );
}
