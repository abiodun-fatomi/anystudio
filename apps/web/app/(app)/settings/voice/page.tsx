'use client';
/**
 * Your voice — record half a minute, consent, and the studio can read
 * voiceovers in it and (experimentally) sing songs in it.
 *
 * The recording happens here in the browser (MediaRecorder), is uploaded
 * like any file, and the API clones it at the voice vendor. A clone of a
 * voice is the one thing on this site a person could be hurt by, so the
 * consent line is not a formality: nothing is sent until it is ticked, and
 * the API refuses without it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Voice, type WorkspaceVoices } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { uploadFile } from '@/lib/upload';
import { forgetVoices } from '@/lib/studio/voices-cache';
import { Button, Checkbox, ConfirmDialog, Input, LoadError, Select, Skeleton, useToast } from '@/components/ui';
import styles from '../settings.module.css';
import own from './voice.module.css';

const SCRIPT = [
  'Hello, and welcome. This is my voice, and I am recording it so my studio can speak for me.',
  'I sell things I am proud of, and I want my customers to hear about them the way I would tell them — warm, clear and unhurried.',
  'Fresh stock arrives every week. Message us to order, and we deliver across the city the same day.',
  'Numbers help too: one, two, three, four, five, six, seven, eight, nine, ten. Thank you for listening.',
];

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'en-NG', label: 'English (Nigeria)' },
  { value: 'en-GH', label: 'English (Ghana)' },
  { value: 'en-KE', label: 'English (Kenya)' },
  { value: 'en-ZA', label: 'English (South Africa)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'fr', label: 'French' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'es', label: 'Spanish' },
  { value: 'ar', label: 'Arabic' },
  { value: 'sw', label: 'Swahili' },
  { value: 'hi', label: 'Hindi' },
];

type RecState = 'idle' | 'asking' | 'recording' | 'done';

export default function VoicePage() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const [data, setData] = useState<WorkspaceVoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.audio.workspaceVoices(workspace.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load');
    }
  }, [workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  // ---- the recording
  const [rec, setRec] = useState<RecState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const min = data?.cloning.sample.minSec ?? 10;
  const ideal = data?.cloning.sample.idealSec ?? 30;
  const max = data?.cloning.sample.maxSec ?? 180;

  const stopMeter = () => {
    if (meter.current) {
      cancelAnimationFrame(meter.current.raf);
      void meter.current.ctx.close().catch(() => undefined);
      meter.current = null;
    }
    setLevel(0);
  };
  const stopStream = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(
    () => () => {
      // Leaving the page: let go of the microphone.
      if (timer.current) window.clearInterval(timer.current);
      stopMeter();
      stopStream();
    },
    [],
  );

  const setTake = (b: Blob | null, name: string | null) => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlob(b);
    setFileName(name);
    setBlobUrl(b ? URL.createObjectURL(b) : null);
  };

  const start = async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast({ title: 'This browser cannot record', body: 'Upload a recording from your phone instead.', tone: 'danger' });
      return;
    }
    setRec('asking');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      stream.current = s;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
      const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 96_000 } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      r.onstop = () => {
        const type = r.mimeType || mime || 'audio/webm';
        setTake(new Blob(chunks.current, { type }), null);
        setRec('done');
        stopStream();
        stopMeter();
        if (timer.current) window.clearInterval(timer.current);
      };
      recorder.current = r;
      r.start(500);
      setSeconds(0);
      setRec('recording');
      const startedAt = Date.now();
      timer.current = window.setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        setSeconds(s);
        if (s >= max) stop();
      }, 200);
      // A level meter, so a muted microphone is obvious before a minute is wasted.
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(s);
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += (v - 128) * (v - 128);
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) / 40));
          if (meter.current) meter.current.raf = requestAnimationFrame(tick);
        };
        meter.current = { ctx, raf: requestAnimationFrame(tick) };
      } catch {
        /* no meter, no matter */
      }
    } catch (e) {
      setRec('idle');
      stopStream();
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      toast({
        title: denied ? 'Microphone access was refused' : 'Could not start recording',
        body: denied ? 'Allow the microphone for this site in your browser, or upload a recording instead.' : e instanceof Error ? e.message : undefined,
        tone: 'danger',
      });
    }
  };
  const stop = () => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  };
  const discard = () => {
    setTake(null, null);
    setRec('idle');
    setSeconds(0);
  };

  // ---- naming, consent, sending
  const [name, setName] = useState('My voice');
  const [language, setLanguage] = useState('en');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const tooShort = blob !== null && fileName === null && seconds < min;

  const send = async () => {
    if (!blob || !consent) return;
    setBusy('Uploading your recording');
    setPct(0);
    try {
      const ext = blob.type.includes('mp4')
        ? 'm4a'
        : blob.type.includes('ogg')
          ? 'ogg'
          : blob.type.includes('mpeg')
            ? 'mp3'
            : blob.type.includes('wav')
              ? 'wav'
              : 'webm';
      const file = new File([blob], fileName ?? `voice-sample.${ext}`, { type: blob.type || 'audio/webm' });
      const asset = await uploadFile(workspace.id, file, (p) => setPct(p.pct));
      setPct(null);
      setBusy('Making your voice — about half a minute');
      await api.audio.cloneVoice(workspace.id, { sampleKey: asset.key, name: name.trim() || 'My voice', language, consent: true });
      forgetVoices(workspace.id);
      toast({ title: 'Your voice is ready', body: 'Pick it under Voice in a voiceover, or "Me" when making a song.', tone: 'ok' });
      discard();
      setConsent(false);
      await load();
    } catch (e) {
      const msg =
        e instanceof ApiError && e.fields?.length ? e.fields.map((f) => f.message).join(' ') : e instanceof Error ? e.message : 'Something went wrong';
      toast({ title: 'Could not make your voice', body: msg, tone: 'danger' });
    } finally {
      setBusy(null);
      setPct(null);
    }
  };

  const [removing, setRemoving] = useState<Voice | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api.audio.deleteVoice(workspace.id, removing.key);
      forgetVoices(workspace.id);
      toast({ title: 'Voice removed', body: 'It is gone here and at the voice vendor.', tone: 'ok' });
      setRemoving(null);
      await load();
    } catch (e) {
      toast({ title: 'Could not remove it', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    } finally {
      setRemoveBusy(false);
    }
  };

  if (!data && error)
    return (
      <div className={styles.group}>
        <LoadError what="your voices" message={error} onRetry={() => void load()} />
      </div>
    );
  if (!data)
    return (
      <div className={styles.group}>
        <Skeleton style={{ height: 180 }} />
      </div>
    );

  const mine = data.voices.filter((v) => v.mine);
  const full = mine.length >= data.cloning.limit;

  return (
    <>
      <section className={styles.group} aria-labelledby="v-mine">
        <div className={styles.groupHead}>
          <div>
            <h2 id="v-mine" className={styles.groupTitle}>
              Your voice
            </h2>
            <p className={styles.groupLede}>
              Record yourself once and the studio can read voiceovers in your voice — and, experimentally, sing your songs in it.
            </p>
          </div>
        </div>
        {mine.length === 0 ? (
          <p className={own.empty}>No voice recorded yet.</p>
        ) : (
          <div className={styles.rows}>
            {mine.map((v) => (
              <div key={v.key} className={styles.row}>
                <div className={styles.rowIcon} aria-hidden>
                  <MicIcon />
                </div>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <span>{v.name}</span>
                  </div>
                  <div className={styles.rowSub}>
                    {LANGUAGES.find((l) => l.value === v.language)?.label ?? v.language}
                    {v.createdAt ? ` · recorded ${new Date(v.createdAt).toLocaleDateString()}` : ''}
                  </div>
                  {v.sampleUrl && <audio className={own.player} src={v.sampleUrl} controls preload="none" />}
                </div>
                <div className={styles.rowEnd}>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(v)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.group} aria-labelledby="v-record">
        <div className={styles.groupHead}>
          <div>
            <h2 id="v-record" className={styles.groupTitle}>
              {mine.length ? 'Record another' : 'Record your voice'}
            </h2>
            <p className={styles.groupLede}>
              Somewhere quiet, phone or laptop microphone, {ideal} seconds or so of you talking normally. Read the lines below or say anything you like.
            </p>
          </div>
        </div>

        {!data.cloning.available ? (
          <div className={styles.notice} data-tone="info">
            <strong>Not available here yet</strong>
            The voice vendor is not configured in this environment. Voiceovers still work with the catalogue voices.
          </div>
        ) : full ? (
          <div className={styles.notice} data-tone="info">
            <strong>You have {data.cloning.limit} voices already</strong>
            That is the most a workspace can keep. Remove one above to record another.
          </div>
        ) : (
          <>
            <blockquote className={own.script}>
              {SCRIPT.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </blockquote>

            <div className={own.recorder} data-state={rec}>
              {rec === 'recording' ? (
                <>
                  <span className={own.dot} aria-hidden />
                  <span className={own.clock}>{fmt(seconds)}</span>
                  <span className={own.meter} aria-hidden>
                    <span style={{ transform: `scaleX(${Math.max(0.03, level)})` }} />
                  </span>
                  <Button variant="primary" size="sm" onClick={stop} disabled={seconds < 2}>
                    Stop
                  </Button>
                </>
              ) : rec === 'done' && blobUrl ? (
                <>
                  <audio className={own.player} src={blobUrl} controls preload="metadata" />
                  <span className={own.clock}>{fileName ?? fmt(seconds)}</span>
                  <Button variant="ghost" size="sm" onClick={discard} disabled={busy !== null}>
                    Record again
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="primary" onClick={() => void start()} loading={rec === 'asking'}>
                    Start recording
                  </Button>
                  <span className={own.or}>or</span>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/x-m4a,audio/webm,.mp3,.m4a,.wav,.ogg,.webm"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setTake(f, f.name);
                        setRec('done');
                      }
                      e.target.value = '';
                    }}
                  />
                  <Button variant="subtle" onClick={() => fileInput.current?.click()}>
                    Upload a recording
                  </Button>
                </>
              )}
            </div>
            {tooShort && (
              <p className={own.warn}>
                That is {Math.round(seconds)} seconds — we need at least {min}. Record again and keep going a little longer.
              </p>
            )}
            <p className={own.tips}>
              Tips: no music in the background, speak as you would to a customer, keep the phone a hand’s length away. Between {min} seconds and{' '}
              {Math.round(max / 60)} minutes.
            </p>

            {rec === 'done' && blob && !tooShort && (
              <div className={own.form}>
                <div className={styles.grid2}>
                  <Input label="Call it" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
                  <Select label="Language you spoke" options={LANGUAGES} value={language} onChange={(e) => setLanguage(e.target.value)} />
                </div>
                <Checkbox
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  label="This is my own voice (or I have that person’s permission), and I consent to a copy of it being made and kept by our voice vendor so my studio can use it."
                  hint="You can remove it any time from this page; the copy is deleted at the vendor too."
                />
                <div className={styles.saveBar}>
                  <Button variant="primary" onClick={() => void send()} disabled={!consent || busy !== null} loading={busy !== null}>
                    Make my voice
                  </Button>
                  {busy && (
                    <span className={styles.saved}>
                      {busy}
                      {pct !== null ? ` · ${pct}%` : ''}
                    </span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => (removeBusy ? undefined : setRemoving(null))}
        onConfirm={() => void remove()}
        title={`Remove “${removing?.name ?? ''}”?`}
        description="The voice is deleted here and at the voice vendor. Songs and voiceovers already made keep their sound; new ones cannot use it."
        confirmLabel="Remove the voice"
        danger
        busy={removeBusy}
      />
    </>
  );
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  );
}
