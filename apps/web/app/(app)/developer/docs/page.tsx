'use client';
/**
 * Quick start — the smallest set of calls that gets a picture back, with
 * the request bodies ready to paste and this environment's own API base.
 * Scenario bodies are shared with API discovery and checked against the validators.
 */
import { useEffect, useState } from 'react';
import { siblingOrigin } from '@/lib/hosts';
import { useToast, Button } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import { API_SCENARIOS } from '@anystudio/shared';
import { WEBHOOK_VERIFY_EXAMPLE } from '@/lib/developer-docs';
import styles from '../developer.module.css';

export default function DocsPage() {
  const { toast } = useToast();
  const [base, setBase] = useState('https://api.anystudio.ai/api/v1');
  useEffect(() => {
    try {
      setBase(`${siblingOrigin(window.location.host, 'api')}/api/v1`);
    } catch {
      /* keep the default */
    }
  }, []);
  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      toast({ title: 'Copied', tone: 'ok', durationMs: 1500 });
    } catch {
      toast({ title: 'Select it and copy by hand', tone: 'warn' });
    }
  };

  const steps: Array<{ title: string; body: string; code: string }> = [
    {
      title: '1. Put a product photo in',
      body: 'From a URL you already host (we fetch it), or a presigned PUT for files you hold. The answer carries the key you pass to every capability.',
      code: `curl -X POST ${base}/uploads/from-url \\
  -H "Authorization: Bearer $ANYSTUDIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://cdn.example.com/products/sku-9.jpg"}'

# → { "data": { "upload": { "key": "YOUR_WORKSPACE/uploads/product.jpg", "status": "READY", … } } }`,
    },
    {
      title: '2. Ask for something',
      body: 'Choose a scenario below. POST /generations/quote with its capability and complete params to estimate the total first. clientKey must be unique across the workspace; merchantRef groups usage, not access permissions.',
      code: `curl -X POST ${base}/generations \\
  -H "Authorization: Bearer $ANYSTUDIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "capability": "IMAGE_EDIT",
    "params": { "sourceKey": "YOUR_WORKSPACE/uploads/product.jpg", "prompt": "on a marble counter in soft morning light", "aspect": "1:1", "sizes": ["feed_square", "story"], "price": "₦12,000" },
    "clientKey": "order-8812-hero",
    "merchantRef": "store-441"
  }'

# → 201 { "data": { "generation": { "id": "…", "status": "QUEUED", "credits": 10, … }, "balance": 1490 } }
# → 402 when the workspace is out of credits; 400 with "fields" when a param is wrong`,
    },
    {
      title: '3. Hear back',
      body: 'Poll until SUCCEEDED, FAILED or CANCELLED, or register a webhook in the portal for success/failure. GET returns data.generation; webhook data is the generation itself. URLs last an hour; fetch again to refresh them.',
      code: `curl ${base}/generations/$ID -H "Authorization: Bearer $ANYSTUDIO_KEY"

# → { "data": { "generation": { "status": "SUCCEEDED", "outputs": [
#       { "role": "image", "mime": "image/jpeg", "width": 1080, "height": 1080, "url": "https://…" },
#       { "role": "variant", "size": "story", "url": "https://…" } ], "urlsExpireInSec": 3600 } } }`,
    },
    {
      title: '4. Verify a webhook',
      body: 'Every delivery is signed with the secret shown when you added the endpoint: X-AnyStudio-Signature is t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">. Reject timestamps more than five minutes in either direction. Persist the event durably before returning 2xx, then process it asynchronously.',
      code: WEBHOOK_VERIFY_EXAMPLE,
    },
  ];

  return (
    <>
      <section className={styles.group}>
        <div className={styles.groupHead}>
          <div>
            <div className={styles.groupTitle}>Quick start</div>
            <div className={styles.groupLede}>
              Base URL for this environment: <span style={{ fontFamily: 'var(--f-mono)' }}>{base}</span>. Every successful answer is wrapped as{' '}
              <span style={{ fontFamily: 'var(--f-mono)' }}>{'{ status, message, data }'}</span>; every error has a{' '}
              <span style={{ fontFamily: 'var(--f-mono)' }}>error</span> identifier and may include a{' '}
              <span style={{ fontFamily: 'var(--f-mono)' }}>fields</span> array of path/message objects.
            </div>
          </div>
          <a style={{ fontFamily: 'var(--f-mono)' }} href="#scenario-reference">
            Scenario reference ↓
          </a>
        </div>
        {steps.map((s) => (
          <div key={s.title}>
            <div className={styles.codeHead}>
              <div>
                <strong>{s.title}</strong>
                <div className={styles.groupLede}>{s.body}</div>
              </div>
              <Button variant="ghost" size="sm" leading={<Icon.copy width={14} height={14} />} onClick={() => copy(s.code)}>
                Copy
              </Button>
            </div>
            <pre className={styles.code}>{s.code}</pre>
          </div>
        ))}
      </section>

      <section className={styles.group} id="scenario-reference">
        <div className={styles.groupTitle}>API calls by scenario</div>
        <p className={styles.groupLede}>
          All examples use POST /generations. Replace every YOUR_WORKSPACE/uploads/... value with a READY key returned by your upload, and replace voice/genre
          keys with catalogue values. Use a new clientKey for new work. These examples validate against the same schemas as the API; provider availability and
          permission still matter.
        </p>
        <pre className={styles.code}>{`# No debit or generation is created by a quote.
curl -X POST ${base}/generations/quote \\
  -H "Authorization: Bearer $ANYSTUDIO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"capability":"TEXT_GENERATE","params":{"productName":"Ankara tote"}}'
# data: { costCode, credits, label, balance, balanceAfter, expectedMs }
# Estimate only; submission uses current prices and performs its own checks.

curl ${base}/capabilities -H "Authorization: Bearer $ANYSTUDIO_KEY"
curl ${base}/catalogue/audio/voices -H "Authorization: Bearer $ANYSTUDIO_KEY"
curl ${base}/catalogue/audio/genres -H "Authorization: Bearer $ANYSTUDIO_KEY"
curl ${base}/catalogue/audio/dub-languages -H "Authorization: Bearer $ANYSTUDIO_KEY"`}</pre>
        {API_SCENARIOS.map((scenario) => {
          const code = `curl -X POST ${base}/generations -H "Authorization: Bearer $ANYSTUDIO_KEY" -H "Content-Type: application/json" -d '${JSON.stringify(scenario.body, null, 2)}'`;
          return (
            <div key={scenario.id}>
              <div className={styles.codeHead}>
                <div>
                  <strong>{scenario.title}</strong>
                  <div className={styles.groupLede}>{scenario.note}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => copy(code)}>
                  Copy
                </Button>
              </div>
              <pre className={styles.code}>{code}</pre>
            </div>
          );
        })}
      </section>

      <section className={styles.group}>
        <div className={styles.groupTitle}>Uploads and generation management</div>
        <p className={styles.groupLede}>
          Required scopes: media:write for uploads, generations:write for create/cancel/unlock, generations:read for list/get, catalogue:read for
          discovery/quotes, and balance:read for the wallet. Keys are server secrets; run these examples on your backend.
        </p>
        <pre className={styles.code}>{`# Local upload: replace filename, MIME and bytes with the real file's metadata.
curl -X POST ${base}/uploads -H "Authorization: Bearer $ANYSTUDIO_KEY" -H "Content-Type: application/json" -d '{"filename":"product.jpg","mime":"image/jpeg","bytes":123456}'
# Save data.upload.id as UPLOAD_ID and data.upload.url as UPLOAD_URL.
# PUT the raw file using ALL returned data.upload.headers (this example assumes image/jpeg).
# Never forward ANYSTUDIO_KEY to the storage host.
curl -X PUT "$UPLOAD_URL" -H "Content-Type: image/jpeg" --data-binary @product.jpg
curl -X POST ${base}/uploads/$UPLOAD_ID/complete -H "Authorization: Bearer $ANYSTUDIO_KEY"
# Use the final data.upload.key only when status is READY.

# List this project's jobs. Follow data.nextCursor with ?cursor=... for the next page.
curl "${base}/generations?limit=50&merchantRef=store-441" -H "Authorization: Bearer $ANYSTUDIO_KEY"
curl ${base}/generations/$ID -H "Authorization: Bearer $ANYSTUDIO_KEY"

# Cancellation is only possible while QUEUED.
curl -X POST ${base}/generations/$ID/cancel -H "Authorization: Bearer $ANYSTUDIO_KEY"

# Song unlock: show the additional price and obtain agreement first.
curl ${base}/catalogue/audio/unlock-price -H "Authorization: Bearer $ANYSTUDIO_KEY"
curl -X POST ${base}/generations/$ID/unlock -H "Authorization: Bearer $ANYSTUDIO_KEY"
curl ${base}/generations/$ID -H "Authorization: Bearer $ANYSTUDIO_KEY"

curl ${base}/balance -H "Authorization: Bearer $ANYSTUDIO_KEY"`}</pre>
        <p className={styles.groupLede}>
          A locked song has an empty key and null URL. List responses are summaries; fetch a single generation for outputs. Treat SUCCEEDED, FAILED and
          CANCELLED as terminal. Webhooks report success/failure, not cancellation. Batches may succeed partially; use separate jobs for exact SKU-to-output
          tracking.
        </p>
      </section>

      <section className={styles.group}>
        <div className={styles.groupTitle}>Good to know</div>
        <div className={styles.prose}>
          <h3>Credits and prices</h3>
          <p>
            <code>GET /capabilities</code> lists base rates, not the final total for every scenario. Use <code>POST /generations/quote</code> with complete
            params for a total estimate. Credits are reserved on submission and refunded on full failure; batches can succeed partially with a partial refund.{' '}
            <code>GET /balance</code> says what is left; an out-of-credits request is a <code>402</code>, never a silent queue.
          </p>
          <h3>Idempotency</h3>
          <p>
            Send the same <code>clientKey</code> again and you get the same generation back, charged once. Use your order id, your job id — anything unique
            across the workspace, including a project prefix. A collision with another project returns 409 without revealing its generation. The first accepted
            request wins; change the key to request different work.
          </p>
          <h3>Rate limits</h3>
          <p>
            60 requests a minute per key on <code>POST /generations</code>, 10 a minute per <code>merchantRef</code> behind it; headers{' '}
            <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code> tell you where you stand; <code>Retry-After</code>{' '}
            accompanies a 429. Need more for a launch? Say so.
          </p>
          <h3>Songs</h3>
          <p>
            A <code>MUSIC</code> generation returns a 30-second preview and a locked full track. <code>POST /generations/:id/unlock</code> pays for the rest and
            opens it. Check <code>GET /catalogue/audio/unlock-price</code> for the extra charge first. Then fetch <code>GET /generations/:id</code> for the
            standard response with refreshed URLs.
          </p>
          <h3>Faces and voices</h3>
          <p>
            <code>DUB</code> and <code>LIPSYNC</code> require <code>consent: true</code> in the params: you confirm the person in the video has agreed to their
            face and voice being used. Vendors run their own moderation; a refusal comes back as a failed generation with the credits returned.
          </p>
          <h3>Keys</h3>
          <p>
            Projects isolate API generations, but uploads and the credit wallet are workspace-wide. merchantRef is an accounting label, not a tenant security
            boundary. Use separate workspaces for mutually untrusted tenants.
          </p>
          <p>
            Project/key/webhook management uses the signed-in Developer portal, not this bearer key. Interactive Swagger is available only on
            development/staging when enabled; it is intentionally unavailable in production.
          </p>
          <p>
            Keys are server secrets. Never ship one in a browser, a mobile app or a public repo; if one leaks, revoke it here and mint another — the generations
            it made stay in your history under its prefix.
          </p>
        </div>
      </section>
    </>
  );
}
