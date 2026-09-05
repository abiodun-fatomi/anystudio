'use client';
/**
 * Welcome — three questions after sign-up, every one of them skippable.
 *
 * The answers shape the first generation (what they sell, where, how they
 * want to sound); nothing here gates anything. "Skip" is a first-class
 * action, not a small grey link, and skipping saves whatever was answered so
 * far. Second visits never see this page: it is reached only from the
 * sign-up redirect, and the app tour handles the rest.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMe } from '@/lib/useMe';
import { api, type WorkspaceProfile } from '@/lib/api';
import styles from './welcome.module.css';

type Channel = NonNullable<WorkspaceProfile['channels']>[number];
type Tone = NonNullable<WorkspaceProfile['tone']>;

const CHANNELS: Array<[Channel, string]> = [
  ['whatsapp', 'WhatsApp'],
  ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'],
  ['facebook', 'Facebook'],
  ['jiji', 'Jiji'],
  ['shop', 'My own shop / site'],
  ['market', 'A physical shop or market'],
];

const TONES: Array<[Tone, string, string]> = [
  ['warm', 'Warm', 'Friendly, like a message to a regular customer.'],
  ['direct', 'Direct', 'Price, what it is, how to order. No fluff.'],
  ['playful', 'Playful', 'A little humour. Good for fashion and food.'],
  ['premium', 'Premium', 'Calm and confident. Fewer words, better ones.'],
];

export default function WelcomePage() {
  const router = useRouter();
  const { me } = useMe();
  const [step, setStep] = useState(0);
  const [sells, setSells] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tone, setTone] = useState<Tone | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ws = me?.workspaces[0];

  /** Persist what has been answered and go to the app. Called by both Finish and Skip. */
  async function finish() {
    if (!ws) return router.replace('/today');
    const patch: WorkspaceProfile = {};
    if (sells.trim()) patch.sells = sells.trim();
    if (channels.length) patch.channels = channels;
    if (tone) patch.tone = tone;
    if (Object.keys(patch).length === 0) return router.replace('/today');
    setBusy(true);
    setError(null);
    try {
      await api.workspace.patchProfile(ws.id, patch);
      router.replace('/today');
    } catch {
      setError('Could not save that — you can set it later in Brand kit.');
      setBusy(false);
    }
  }

  /** Toggle a channel chip. */
  const toggleChannel = (c: Channel) => setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  const next = () => (step < 2 ? setStep(step + 1) : void finish());

  if (!me) return <div className={styles.wrap} aria-busy="true" />;
  const first = me.user.name?.split(' ')[0];

  return (
    <div className={styles.wrap}>
      <div className={styles.card} role="dialog" aria-labelledby="wh">
        <div className={styles.top}>
          <div className={styles.steps} aria-label={`Step ${step + 1} of 3`}>
            {[0, 1, 2].map((i) => (
              <i key={i} data-on={i <= step} />
            ))}
          </div>
          <button type="button" className={styles.skip} onClick={finish} disabled={busy}>
            Skip for now
          </button>
        </div>

        {step === 0 && (
          <>
            <h1 id="wh" className={styles.h}>
              {first ? `Welcome, ${first}.` : 'Welcome.'} What do you sell?
            </h1>
            <p className={styles.p}>
              A few words is enough — “Ankara fabrics”, “skincare”, “phone accessories”. It goes straight into how we write about your products.
            </p>
            <div className="field" style={{ marginTop: 20 }}>
              <label htmlFor="sells">What you sell</label>
              <input
                id="sells"
                className="inp"
                autoFocus
                placeholder="e.g. Handmade leather bags"
                maxLength={120}
                value={sells}
                onChange={(e) => setSells(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && next()}
              />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 id="wh" className={styles.h}>
              Where do you sell today?
            </h1>
            <p className={styles.p}>Pick everything that applies. We&apos;ll suggest the right connections first and size images for those places.</p>
            <div className={styles.chips}>
              {CHANNELS.map(([c, label]) => (
                <button key={c} type="button" className={styles.chip} aria-pressed={channels.includes(c)} onClick={() => toggleChannel(c)}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 id="wh" className={styles.h}>
              How should your captions sound?
            </h1>
            <p className={styles.p}>You can change this any time, and edit every caption before it goes out.</p>
            <div className={styles.tones}>
              {TONES.map(([t, name, desc]) => (
                <button key={t} type="button" className={styles.tone} aria-pressed={tone === t} onClick={() => setTone(t)}>
                  <strong>{name}</strong>
                  <span>{desc}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {error && (
          <p className={`err ${styles.err}`} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          {step > 0 && (
            <button type="button" className="btn ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </button>
          )}
          <button type="button" className="btn" onClick={next} disabled={busy}>
            {busy ? 'Saving…' : step < 2 ? 'Continue' : 'Open my studio'}
          </button>
        </div>
      </div>
    </div>
  );
}
