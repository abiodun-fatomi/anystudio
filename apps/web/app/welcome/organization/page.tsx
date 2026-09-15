'use client';
/**
 * The organization's welcome — the three things a platform wants in its
 * first ten minutes, done for real.
 *
 * It follows sign-up from /org, which created the account and an
 * ORGANIZATION workspace and handed the browser to this host. Everything on
 * this page is an actual call: the verification link was actually sent, the
 * key is actually minted (and shown once, like every key), the photo or the
 * listing link actually runs through the pipeline on the organization's own
 * credits, and the invites actually go out. The seller welcome asks three
 * questions; this one proves three things.
 *
 * Nothing here blocks on anything else. A platform can mint the key before
 * the email arrives, or skip the demo, or invite nobody. Each step says what
 * it did and what it did not.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMe } from '@/lib/useMe';
import { api, ApiError, type GenerationRow, type GrantableRole, type MediaAssetRow } from '@/lib/api';
import { uploadFile } from '@/lib/upload';
import { siblingOrigin } from '@/lib/hosts';
import { Button, Input, Select, ToastProvider, useToast } from '@/components/ui';
import welcome from '../welcome.module.css';
import styles from './organization.module.css';

type Step = 'verify' | 'key' | 'prove' | 'team';
const STEPS: Step[] = ['verify', 'key', 'prove', 'team'];

/** One generation of the demo, watched from the row's own stream. */
interface Run {
  label: string;
  capability: 'INSPECT' | 'BACKGROUND_REPLACE' | 'TEXT_GENERATE';
  row: GenerationRow | null;
  stage: string;
  progress: number;
  urls: Record<string, string>;
  error: string | null;
}

interface Verdict {
  verdict: string;
  confidence: number;
  saw: string;
  issues: string[];
  advice: string;
}

const ISSUE_WORDS: Record<string, string> = {
  screenshot: 'a screenshot',
  document_or_text: 'a document or text',
  person_is_subject: 'a person as the subject',
  no_product_visible: 'no product visible',
  multiple_products: 'several products',
  blurry: 'blurred',
  too_dark: 'too dark',
  watermark_or_overlay: 'a watermark or overlay',
  category_mismatch: 'not the declared category',
  name_mismatch: 'not the declared name',
  low_resolution: 'low resolution',
};

/**
 * The welcome lives outside the (app) group, so nothing above it mounts a
 * ToastProvider — and useToast throws without one, at prerender as much as
 * in a browser. The page brings its own, the way the staff console does.
 */
export default function OrganizationWelcome() {
  return (
    <ToastProvider>
      <OrganizationWelcomeSteps />
    </ToastProvider>
  );
}

function OrganizationWelcomeSteps() {
  const router = useRouter();
  const { me } = useMe();
  const { toast } = useToast();
  const ws = useMemo(() => me?.workspaces.find((w) => w.type === 'ORGANIZATION') ?? me?.workspaces[0] ?? null, [me]);
  const [step, setStep] = useState<Step>('verify');
  const at = STEPS.indexOf(step);
  const go = (s: Step) => setStep(s);

  // Signed in, but no workspace at all — the sign-up did not finish. The seller welcome creates one.
  useEffect(() => {
    if (me && !ws) router.replace('/welcome');
  }, [me, ws, router]);

  if (!me || !ws) return <div className={welcome.wrap} aria-busy="true" />;

  return (
    <div className={welcome.wrap}>
      <div className={`${welcome.card} ${styles.card}`} role="dialog" aria-labelledby="oh">
        <div className={welcome.top}>
          <div className={welcome.steps} aria-label={`Step ${at + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <i key={s} data-on={i <= at} />
            ))}
          </div>
          <button type="button" className={welcome.skip} onClick={() => router.push('/developer')}>
            Open the portal
          </button>
        </div>

        {step === 'verify' && <Verify email={me.user.email} onNext={() => go('key')} />}
        {step === 'key' && <Key workspaceId={ws.id} onNext={() => go('prove')} />}
        {step === 'prove' && <Prove workspaceId={ws.id} onNext={() => go('team')} />}
        {step === 'team' && <Team workspaceId={ws.id} workspaceName={ws.name} onDone={() => router.push('/developer')} toast={toast} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ verify */

function Verify({ email, onNext }: { email: string | null; onNext: () => void }) {
  const [verified, setVerified] = useState<boolean | null>(null);
  const [resent, setResent] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [checked, setChecked] = useState(false);

  const check = useCallback(async () => {
    try {
      const p = await api.account.profile();
      setVerified(Boolean(p.emailVerifiedAt));
      return Boolean(p.emailVerifiedAt);
    } catch {
      return false;
    }
  }, []);

  // The link is clicked in another tab, or on a phone. Poll, gently, until it has been.
  useEffect(() => {
    let live = true;
    void check();
    const t = setInterval(() => {
      if (!live) return;
      void check().then((ok) => ok && clearInterval(t));
    }, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [check]);

  // A moment on the green note, then on. The handler is read through a ref so a
  // parent re-render does not restart the timer.
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    if (!verified) return;
    const t = setTimeout(() => next.current(), 900);
    return () => clearTimeout(t);
  }, [verified]);

  async function resend() {
    setResent('sending');
    try {
      await api.auth.resendVerification();
      setResent('sent');
    } catch {
      setResent('failed');
    }
  }

  return (
    <>
      <span className={styles.mono}>Step 1 of 4</span>
      <h1 id="oh" className={welcome.h}>
        Confirm it's you.
      </h1>
      <p className={welcome.p}>
        We sent a link to <strong>{email ?? 'your address'}</strong>. It works once and expires in an hour. Click it, and this page notices on its own.
      </p>

      {verified === true && (
        <div className={styles.note} data-tone="ok">
          Verified. On to your key.
        </div>
      )}
      {verified === false && checked && (
        <div className={styles.note} data-tone="warn">
          Not yet — the link in the email hasn't been opened. Check spam, or send it again.
        </div>
      )}
      {resent === 'sent' && <div className={styles.note}>Sent again. Give it a minute.</div>}
      {resent === 'failed' && (
        <div className={styles.note} data-tone="warn">
          Could not send it again just now. Try in a moment.
        </div>
      )}

      <div className={welcome.actions}>
        <Button
          onClick={async () => {
            setChecked(true);
            if (await check()) onNext();
          }}
        >
          I've verified — continue
        </Button>
        <Button variant="ghost" onClick={resend} loading={resent === 'sending'}>
          Send it again
        </Button>
        <Button variant="ghost" onClick={onNext}>
          Verify later
        </Button>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------- key */

function Key({ workspaceId, onNext }: { workspaceId: string; onNext: () => void }) {
  const [state, setState] = useState<
    { kind: 'minting' } | { kind: 'minted'; key: string; prefix: string } | { kind: 'existing'; prefix: string } | { kind: 'failed'; why: string }
  >({
    kind: 'minting',
  });
  const [copied, setCopied] = useState(false);
  const once = useRef(false);
  const base = typeof window === 'undefined' ? 'https://api.anystudio.ai' : siblingOrigin(window.location.host, 'api');

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    (async () => {
      try {
        // A reload must not mint a second key. An existing one is shown by prefix; a new one is minted only when there is none.
        const keys = await api.developer.keys(workspaceId);
        const live = keys.find((k) => !k.revokedAt);
        if (live) return setState({ kind: 'existing', prefix: live.prefix });
        const projects = await api.developer.projects(workspaceId);
        const project =
          projects.find((p) => !p.archivedAt) ??
          (await api.developer.createProject(workspaceId, { name: 'Sandbox', description: 'Created by the welcome. Rename it, or make one per environment.' }));
        const minted = await api.developer.createKey(workspaceId, { projectId: project.id, name: 'First key' });
        setState({ kind: 'minted', key: minted.key, prefix: minted.prefix });
      } catch (e) {
        setState({ kind: 'failed', why: e instanceof ApiError ? e.message : 'Something went wrong minting it.' });
      }
    })();
  }, [workspaceId]);

  const curl = `curl -X POST ${base}/api/v1/inspect \\
  -H "Authorization: Bearer ${state.kind === 'minted' ? state.key : '$ANYSTUDIO_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{"sourceKey":"<from /uploads/from-url>","declared":{"category":"bags"},"merchantRef":"store-441"}'`;

  return (
    <>
      <span className={styles.mono}>Step 2 of 4</span>
      <h1 id="oh" className={welcome.h}>
        Your key. Shown once.
      </h1>
      <p className={welcome.p}>
        It belongs to a project called Sandbox — rename it, or make one per environment under Developer → Projects. Usage is metered per project and attributed
        per merchant from the first call.
      </p>

      <div className={styles.keybox}>
        <div className={styles.hd}>
          <span className={styles.mono}>{state.kind === 'existing' ? 'Your key' : 'First key · 150 credits to spend'}</span>
          <span className={styles.mono} style={{ color: 'var(--cyan)' }}>
            {state.kind === 'minted' || state.kind === 'existing' ? (state.prefix.startsWith('as_live') ? 'Live' : 'Test') : ''}
          </span>
        </div>
        <div className={styles.keyrow}>
          {state.kind === 'minting' && <code>Minting…</code>}
          {state.kind === 'minted' && (
            <>
              <code>{state.key}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(state.key);
                    setCopied(true);
                  } catch {
                    /* select and copy by hand */
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </>
          )}
          {state.kind === 'existing' && (
            <code>{state.prefix}•••••••••••• — already issued; the full key was shown when it was made. Mint another under Developer → API keys.</code>
          )}
          {state.kind === 'failed' && <code>{state.why}</code>}
        </div>
        <pre className={styles.code}>
          <b>POST</b> /api/v1/inspect — is this photo the product?{'\n'}
          {curl}
        </pre>
      </div>
      {state.kind === 'minted' && (
        <div className={styles.note} data-tone="warn">
          Copy it now. We store a hash, not the key, and cannot show it again.
        </div>
      )}

      <div className={welcome.actions}>
        <Button onClick={onNext} disabled={state.kind === 'minting'}>
          Run it on your catalogue
        </Button>
        <Button variant="ghost" onClick={onNext}>
          Skip the demo
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- prove */

function Prove({ workspaceId, onNext }: { workspaceId: string; onNext: () => void }) {
  const [url, setUrl] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ asset: MediaAssetRow; url: string | null; title: string | null } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const streams = useRef<EventSource[]>([]);

  useEffect(() => () => streams.current.forEach((s) => s.close()), []);

  const patch = (i: number, fn: (r: Run) => Run) => setRuns((rs) => rs.map((r, j) => (j === i ? fn(r) : r)));

  async function finish(i: number, id: string) {
    try {
      const { generation } = await api.generations.get(workspaceId, id);
      const keys = (generation.outputs ?? []).map((o) => o.key).filter(Boolean);
      const urls = keys.length ? (await api.media.urls(workspaceId, keys)).urls : {};
      patch(i, (r) => ({ ...r, row: generation, urls, stage: generation.status === 'SUCCEEDED' ? 'done' : 'failed' }));
    } catch (e) {
      patch(i, (r) => ({ ...r, error: e instanceof ApiError ? e.message : 'Could not read the result.' }));
    }
  }

  function watch(i: number, id: string) {
    const es = new EventSource(api.generations.streamUrl(workspaceId, id));
    streams.current.push(es);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as { type: string; stage?: string; progress?: number; status?: string };
        if (e.type === 'stage') patch(i, (r) => ({ ...r, stage: e.stage ?? r.stage, progress: e.progress ?? r.progress }));
        if (e.type === 'done') {
          es.close();
          void finish(i, id);
        }
      } catch {
        /* a malformed event is not worth a broken card */
      }
    };
    es.onerror = () => {
      // The stream fell over; the row is still the truth. One read, then stop.
      es.close();
      void finish(i, id);
    };
  }

  async function run(asset: MediaAssetRow, pageUrl: string | null, title: string | null) {
    const srcUrl = (await api.media.urls(workspaceId, [asset.key])).urls[asset.key] ?? null;
    setSource({ asset, url: srcUrl, title });
    const plan: Array<Omit<Run, 'row' | 'stage' | 'progress' | 'urls' | 'error'> & { params: Record<string, unknown> }> = [
      { label: 'Is it the product?', capability: 'INSPECT', params: { sourceKey: asset.key, ...(title ? { declared: { name: title } } : {}) } },
      {
        label: 'On a clean background',
        capability: 'BACKGROUND_REPLACE',
        params: { sourceKey: asset.key, prompt: 'A plain warm white studio background, soft even light', shadow: true, relight: true },
      },
      { label: 'Listing copy', capability: 'TEXT_GENERATE', params: { sourceKey: asset.key, ...(title ? { productName: title } : {}), language: 'en' } },
    ];
    setRuns(plan.map((p) => ({ label: p.label, capability: p.capability, row: null, stage: 'queued', progress: 0, urls: {}, error: null })));
    await Promise.all(
      plan.map(async (p, i) => {
        try {
          const { generation } = await api.generations.create(workspaceId, {
            capability: p.capability,
            params: p.params,
            clientKey: `welcome:${asset.id.slice(0, 8)}:${p.capability.toLowerCase()}:v1`,
          });
          patch(i, (r) => ({ ...r, row: generation, stage: generation.stage ?? 'queued' }));
          if (generation.status === 'SUCCEEDED' || generation.status === 'FAILED') void finish(i, generation.id);
          else watch(i, generation.id);
        } catch (e) {
          patch(i, (r) => ({ ...r, error: e instanceof ApiError ? e.message : 'Could not start it.' }));
        }
      }),
    );
  }

  async function fromFile(file: File) {
    setError(null);
    setBusy('Uploading your photo…');
    try {
      const asset = await uploadFile(workspaceId, file);
      await run(asset, null, null);
    } catch (e) {
      // uploadFile already turns the API's reasons into plain Errors; the words are the useful part.
      setError(e instanceof Error && e.message ? e.message : 'Could not upload that photo.');
    } finally {
      setBusy(null);
    }
  }

  async function fromLink() {
    if (!url.trim()) return;
    setError(null);
    setBusy('Reading the page and fetching its picture…');
    try {
      const got = await api.media.fromUrl(workspaceId, url.trim());
      await run(got.asset, got.pageUrl, got.title);
    } catch (e) {
      // The reason names the field: "The link answered 404" beats "Some of that did not look right".
      setError(e instanceof ApiError ? (e.fields?.find((f) => f.path === 'url')?.message ?? e.message) : 'Could not read that link.');
    } finally {
      setBusy(null);
    }
  }

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void fromFile(f);
  };

  const inspect = runs.find((r) => r.capability === 'INSPECT');
  const bg = runs.find((r) => r.capability === 'BACKGROUND_REPLACE');
  const copy = runs.find((r) => r.capability === 'TEXT_GENERATE');
  const verdict = inspect?.row?.outputs?.find((o) => o.role === 'text')?.text as Verdict | undefined;
  const bgImage = bg?.row?.outputs?.find((o) => o.role === 'image');
  const copyText = copy?.row?.outputs?.find((o) => o.role === 'text')?.text as
    { description?: { long?: string; short?: string }; seo?: { title?: string } } | undefined;
  const spent = runs.reduce((n, r) => n + (r.row?.status === 'SUCCEEDED' ? r.row.credits : 0), 0);

  return (
    <>
      <span className={styles.mono}>Step 3 of 4</span>
      <h1 id="oh" className={welcome.h}>
        Run it on one of your own listings.
      </h1>
      <p className={welcome.p}>
        A photo from your phone, or the link to a listing that is live today — we read the page and take its picture. Three calls, on your own credits: the
        check, a clean background, the copy. About thirteen credits.
      </p>

      {!source && (
        <div className={styles.source}>
          <label
            className={styles.drop}
            data-over={over}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <strong>Drop a product photo here</strong>
            <span>or tap to choose one · JPEG, PNG or WebP</span>
            <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && void fromFile(e.target.files[0])} />
          </label>
          <div className={styles.or}>or paste a listing</div>
          <div className={styles.urlrow}>
            <Input
              className={styles.inp}
              placeholder="https://yourmarketplace.ng/products/…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void fromLink()}
              aria-label="Listing link"
            />
            <Button onClick={fromLink} disabled={!url.trim() || !!busy}>
              Fetch it
            </Button>
          </div>
          {busy && <div className={styles.note}>{busy}</div>}
          {error && (
            <div className={styles.note} data-tone="warn">
              {error}
            </div>
          )}
        </div>
      )}

      {source && (
        <div className={styles.results}>
          {source.title && (
            <div className={styles.line}>
              <strong>{source.title}</strong>
              <span style={{ color: 'var(--muted)' }}>read from the page — that is what the check compares the picture against</span>
            </div>
          )}
          <div className={styles.pair}>
            <div className={styles.shot}>
              {source.url && <img src={source.url} alt="The photo as uploaded" />}
              <span className={styles.tag}>Yours</span>
            </div>
            <div className={styles.shot}>
              {bgImage && bg?.urls[bgImage.key] ? (
                <img src={bg.urls[bgImage.key]} alt="The same product on a clean background" />
              ) : (
                <span className={styles.wait}>
                  {bg?.error ?? (bg?.row?.status === 'FAILED' ? 'Could not make it — credits returned' : `${bg?.stage ?? 'queued'} · ${bg?.progress ?? 0}%`)}
                </span>
              )}
              <span className={styles.tag}>Studio</span>
            </div>
          </div>

          <div className={styles.line} data-status={inspect?.row?.status}>
            <strong>Is it the product?</strong>
            {verdict ? (
              <>
                <span className={styles.verdict} data-v={verdict.verdict}>
                  {verdict.verdict.replace('_', ' ')}
                </span>{' '}
                {verdict.saw}
                {verdict.issues.length > 0 && <> — {verdict.issues.map((i) => ISSUE_WORDS[i] ?? i).join(', ')}</>}
                <br />
                <span style={{ color: 'var(--muted)' }}>{verdict.advice}</span>
              </>
            ) : (
              <span style={{ color: 'var(--muted)' }}>
                {inspect?.error ?? (inspect?.row?.status === 'FAILED' ? 'Could not check it — credit returned' : `${inspect?.stage ?? 'queued'}…`)}
              </span>
            )}
          </div>

          <div className={styles.line} data-status={copy?.row?.status}>
            <strong>{copyText?.seo?.title ?? 'Listing copy'}</strong>
            {copyText?.description?.long ? (
              copyText.description.long
            ) : (
              <span style={{ color: 'var(--muted)' }}>
                {copy?.error ?? (copy?.row?.status === 'FAILED' ? 'Could not write it — credits returned' : `${copy?.stage ?? 'queued'}…`)}
              </span>
            )}
          </div>

          <div className={styles.note}>
            {spent > 0
              ? `${spent} credits spent so far, on your own balance — the same call your integration would make.`
              : 'Working on your own credits; each call is metered exactly as an integration would be.'}
          </div>
        </div>
      )}

      <div className={welcome.actions}>
        <Button onClick={onNext}>{source ? 'Invite your team' : 'Skip the demo'}</Button>
        {source && (
          <Button
            variant="ghost"
            onClick={() => {
              streams.current.forEach((s) => s.close());
              streams.current = [];
              setSource(null);
              setRuns([]);
              setUrl('');
            }}
          >
            Try another
          </Button>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- team */

function Team({
  workspaceId,
  workspaceName,
  onDone,
  toast,
}: {
  workspaceId: string;
  workspaceName: string;
  onDone: () => void;
  toast: ReturnType<typeof useToast>['toast'];
}) {
  const [rows, setRows] = useState<Array<{ email: string; role: GrantableRole }>>([
    { email: '', role: 'MEMBER' },
    { email: '', role: 'MEMBER' },
  ]);
  const [sent, setSent] = useState<Array<{ email: string; ok: boolean; why?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, p: Partial<{ email: string; role: GrantableRole }>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  async function send() {
    const wanted = rows.filter((r) => r.email.trim());
    if (wanted.length === 0) return onDone();
    setBusy(true);
    const out: typeof sent = [];
    for (const r of wanted) {
      try {
        await api.members.invite(workspaceId, r.email.trim(), r.role);
        out.push({ email: r.email.trim(), ok: true });
      } catch (e) {
        out.push({ email: r.email.trim(), ok: false, why: e instanceof ApiError ? e.message : 'could not send' });
      }
    }
    setSent(out);
    setBusy(false);
    if (out.every((o) => o.ok)) toast({ title: out.length === 1 ? 'Invite sent' : `${out.length} invites sent`, tone: 'ok' });
  }

  return (
    <>
      <span className={styles.mono}>Step 4 of 4</span>
      <h1 id="oh" className={welcome.h}>
        Invite your team to {workspaceName}.
      </h1>
      <p className={welcome.p}>
        Each gets an email with a link that joins them to this organization at the role you choose. Admins can mint keys; members can use the studio; billing
        sees invoices; auditors only look.
      </p>

      <div className={styles.invites}>
        {rows.map((r, i) => (
          <div className={styles.invite} key={i}>
            <Input
              type="email"
              placeholder="colleague@yourcompany.com"
              value={r.email}
              onChange={(e) => set(i, { email: e.target.value })}
              aria-label={`Colleague ${i + 1} email`}
            />
            <Select
              aria-label={`Colleague ${i + 1} role`}
              value={r.role}
              onChange={(e) => set(i, { role: e.target.value as GrantableRole })}
              options={[
                { value: 'ADMIN', label: 'Admin' },
                { value: 'MEMBER', label: 'Member' },
                { value: 'BILLING', label: 'Billing' },
                { value: 'AUDITOR', label: 'Auditor' },
              ]}
            />
          </div>
        ))}
        <button type="button" className={welcome.skip} style={{ justifySelf: 'start' }} onClick={() => setRows((rs) => [...rs, { email: '', role: 'MEMBER' }])}>
          + one more
        </button>
      </div>

      {sent.length > 0 && (
        <ul className={styles.sent}>
          {sent.map((s) => (
            <li key={s.email}>
              <span style={{ color: s.ok ? 'var(--ok)' : 'var(--danger)' }}>{s.ok ? '✓' : '×'}</span>
              <span>
                {s.email}
                {!s.ok && <span style={{ color: 'var(--muted)' }}> — {s.why}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className={welcome.actions}>
        {sent.length === 0 ? (
          <Button onClick={send} loading={busy}>
            {rows.some((r) => r.email.trim()) ? 'Send the invites' : 'Nobody yet — open the portal'}
          </Button>
        ) : (
          <Button onClick={onDone}>Open the portal</Button>
        )}
        {sent.length === 0 && (
          <Button variant="ghost" onClick={onDone}>
            Later
          </Button>
        )}
      </div>
    </>
  );
}
