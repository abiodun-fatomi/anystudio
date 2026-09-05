'use client';
/**
 * Quick start — the smallest set of calls that gets a picture back, with
 * the request bodies ready to paste and this environment's own API base.
 * The full reference lives in the interactive docs at /api/v1/docs.
 */
import { useEffect, useState } from 'react';
import { siblingOrigin } from '@/lib/hosts';
import { useToast, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from '../developer.module.css';

export default function DocsPage() {
  const { toast } = useToast();
  const [base, setBase] = useState('https://api.anystudio.ai/api/v1');
  useEffect(() => { try { setBase(`${siblingOrigin(window.location.host, 'api')}/api/v1`); } catch { /* keep the default */ } }, []);
  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); toast({ title: 'Copied', tone: 'ok', durationMs: 1500 }); } catch { toast({ title: 'Select it and copy by hand', tone: 'warn' }); } };

  const steps: Array<{ title: string; body: string; code: string }> = [
    {
      title: '1. Put a product photo in',
      body: 'From a URL you already host (we fetch it), or a presigned PUT for files you hold. The answer carries the key you pass to every capability.',
      code: `curl -X POST ${base}/uploads/from-url \\
  -H "Authorization: Bearer $ANYSTUDIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://cdn.example.com/products/sku-9.jpg"}'

# → { "data": { "upload": { "key": "…/uploads/….jpg", "status": "READY", … } } }`,
    },
    {
      title: '2. Ask for something',
      body: 'Pick a capability and give it the params GET /capabilities lists. clientKey is your idempotency key; merchantRef is whoever this is for, so usage and fair-use limits are per merchant.',
      code: `curl -X POST ${base}/generations \\
  -H "Authorization: Bearer $ANYSTUDIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "capability": "IMAGE_EDIT",
    "params": { "sourceKey": "…/uploads/….jpg", "prompt": "on a marble counter in soft morning light", "aspect": "1:1", "sizes": ["feed_square", "story"], "price": "₦12,000" },
    "clientKey": "order-8812-hero",
    "merchantRef": "store-441"
  }'

# → 201 { "data": { "generation": { "id": "…", "status": "QUEUED", "credits": 10, … }, "balance": 1490 } }
# → 402 when the workspace is out of credits; 400 with "fields" when a param is wrong`,
    },
    {
      title: '3. Hear back',
      body: 'Poll the generation, or add a webhook endpoint and we POST the same object when it finishes. Output URLs are signed and last an hour; fetch again for fresh ones.',
      code: `curl ${base}/generations/$ID -H "Authorization: Bearer $ANYSTUDIO_KEY"

# → { "data": { "generation": { "status": "SUCCEEDED", "outputs": [
#       { "role": "image", "mime": "image/jpeg", "width": 1080, "height": 1080, "url": "https://…" },
#       { "role": "variant", "size": "story", "url": "https://…" } ], "urlsExpireInSec": 3600 } } }`,
    },
    {
      title: '4. Verify a webhook',
      body: 'Every delivery is signed with the secret shown when you added the endpoint: X-AnyStudio-Signature is t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">. Reject anything older than five minutes and answer 2xx before doing the work.',
      code: `import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody: string, header: string, secret: string): boolean {
  const { t, v1 } = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
}

// { "id": "evt_…", "type": "generation.succeeded", "createdAt": "…", "data": { …the generation… } }`,
    },
  ];

  return (
    <>
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <div><div className={styles.groupTitle}>Quick start</div><div className={styles.groupLede}>Four calls. Base URL for this environment: <span style={{ fontFamily: 'var(--f-mono)' }}>{base}</span>. Every answer is wrapped as <span style={{ fontFamily: 'var(--f-mono)' }}>{'{ status, message, data }'}</span>; every error has a <span style={{ fontFamily: 'var(--f-mono)' }}>code</span>.</div></div>
          <a style={{ fontFamily: 'var(--f-mono)' }} href={`${base}/docs`} target="_blank" rel="noreferrer">Full reference ↗</a>
        </div>
        {steps.map((s) => (
          <div key={s.title}>
            <div className={styles.codeHead}><div><strong>{s.title}</strong><div className={styles.groupLede}>{s.body}</div></div><Button variant="ghost" size="sm" leading={<Icon.copy width={14} height={14} />} onClick={() => copy(s.code)}>Copy</Button></div>
            <pre className={styles.code}>{s.code}</pre>
          </div>
        ))}
      </section>

      <section className={styles.group}>
        <div className={styles.groupTitle}>Good to know</div>
        <div className={styles.prose}>
          <h3>Credits and prices</h3>
          <p>Each capability has a credit price; <code>GET /capabilities</code> lists them with the params they take. Credits are held when you ask and returned if the work fails. <code>GET /balance</code> says what is left; top up from the Credits page — an out-of-credits request is a <code>402</code>, never a silent queue.</p>
          <h3>Idempotency</h3>
          <p>Send the same <code>clientKey</code> again and you get the same generation back, charged once. Use your order id, your job id — anything unique on your side.</p>
          <h3>Rate limits</h3>
          <p>60 requests a minute per key on <code>POST /generations</code>, 10 a minute per <code>merchantRef</code> behind it; headers <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and <code>Retry-After</code> tell you where you stand. Need more for a launch? Say so.</p>
          <h3>Songs</h3>
          <p>A <code>MUSIC</code> generation returns a 30-second preview and a locked full track. <code>POST /generations/:id/unlock</code> pays for the rest and opens it.</p>
          <h3>Faces and voices</h3>
          <p><code>DUB</code> and <code>LIPSYNC</code> require <code>consent: true</code> in the params: you confirm the person in the video has agreed to their face and voice being used. Vendors run their own moderation; a refusal comes back as a failed generation with the credits returned.</p>
          <h3>Keys</h3>
          <p>Keys are server secrets. Never ship one in a browser, a mobile app or a public repo; if one leaks, revoke it here and mint another — the generations it made stay in your history under its prefix.</p>
        </div>
      </section>
    </>
  );
}
