# Every variable, and where to get it

A checklist for taking AnyStudio from "deploys" to "takes money from
strangers". Each block says what the variable does, what happens without it,
and the exact clicks to get the value. Values go in one of three places and
nowhere else:

| Place                                                                                     | What goes there                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Render → Env Groups → `anystudio-dev`** (and `-staging`, `-production` when they exist) | Everything the API and both workers read. One group per environment; every service inherits |
| **GitHub → repo → Settings → Secrets and variables → Actions**                            | Only what the deploy workflows need to reach Render and Cloudflare                          |
| **`.env` on your machine** (copied from `.env.example`, never committed)                  | Local development                                                                           |

Render's own values (`DATABASE_URL`, `DIRECT_URL`, `REDIS_URL`, `PORT`,
`NODE_ENV`, `APP_ENV`, `SERVICE_NAME`, `LOG_LEVEL`, `WORKER_QUEUES`,
`WORKER_*_CONCURRENCY`, `FFMPEG_CONCURRENCY`) are set by the environment's
Blueprint (`render.yaml`, `render.staging.yaml`, or
`render.production.yaml`) and are never typed by a person. The shared secret
group is created and populated manually before that one Blueprint path is
imported; see `docs/DEPLOY.md` §3.

Work through the tiers in order. Tier 1 is the API refusing to boot; tier 2
is a customer being able to pay; tiers 3 and 4 switch on features one at a
time and the product runs without them.

---

## Tier 1 — the API will not start without these

### `APP_KEY`

Encrypts TOTP seeds, provider credentials, store credentials and social
tokens at rest. Rotating it later locks every staff account out of MFA, so
generate it once per environment and keep it.

```
openssl rand -base64 32
```

Paste the output as the value. A different one for dev, staging and
production.

### `ORIGIN_APP`, `ORIGIN_ORG`, `ORIGIN_ADMIN`

The exact origins of the three surfaces. The API derives which surface a
request comes from by matching the `Origin` header against these — nothing
else. No trailing slash.

| Environment | `ORIGIN_APP`                       | `ORIGIN_ORG`                       | `ORIGIN_ADMIN`                       |
| ----------- | ---------------------------------- | ---------------------------------- | ------------------------------------ |
| dev         | `https://app.dev.anystudio.ai`     | `https://org.dev.anystudio.ai`     | `https://admin.dev.anystudio.ai`     |
| staging     | `https://app.staging.anystudio.ai` | `https://org.staging.anystudio.ai` | `https://admin.staging.anystudio.ai` |
| production  | `https://app.anystudio.ai`         | `https://org.anystudio.ai`         | `https://admin.anystudio.ai`         |

### `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

Where every upload and every generated file lives. Without these, uploads
fail and the studio has nothing to work on.

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket** →
   `anystudio-dev` (then `anystudio-staging`, `anystudio-prod`). Location
   hint: Western Europe (near Render Frankfurt).
2. On the bucket → **Settings** → **CORS policy** → paste the policy from
   `docs/DEPLOY.md` §5.1 (it allows `PUT` from the app origins; without it
   browser uploads die as "interrupted").
3. R2 → **Manage R2 API Tokens** → **Create API token** → name
   `anystudio-dev`, permission **Object Read & Write**, scoped to that one
   bucket → Create. Copy the **Access Key ID** and **Secret Access Key**
   now; the secret is shown once.
4. `R2_ENDPOINT` is `https://<account id>.r2.cloudflarestorage.com` — the
   account id is on the R2 overview page (and the token page shows the full
   endpoint).

One token per environment, scoped to its own bucket, so a leaked dev key
cannot read production media.

---

## Tier 2 — a customer can sign up, get email, and pay

### `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Sign in with Google

Without them the Google button shows a "not available" message and
password sign-in still works.

1. console.cloud.google.com → create a project `anystudio` (or reuse one).
2. **APIs & Services → OAuth consent screen** → External → app name
   AnyStudio, support email, and the **privacy policy** and **terms** URLs:
   `https://anystudio.ai/privacy` and `https://anystudio.ai/terms` (both pages
   exist now). Add `anystudio.ai` under Authorised domains. Publish the app
   (leave it in Testing and only the listed test users can sign in).
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorised redirect URIs — one per surface per environment, on the
   _app's_ hostname:
   ```
   http://localhost:3000/api/v1/auth/google/callback
   https://app.dev.anystudio.ai/api/v1/auth/google/callback
   https://app.staging.anystudio.ai/api/v1/auth/google/callback
   https://app.anystudio.ai/api/v1/auth/google/callback
   ```
4. Copy the client id and secret. One client serves every environment.

### `RESEND_API_KEY`, `MAIL_FROM` — transactional mail

Verification, password resets, invoices, refunds, job applications, the
waitlist. Without a key the API logs each email instead of sending it.

1. resend.com → **Domains → Add domain** → `anystudio.ai`. It shows three
   DNS records (DKIM, SPF via a TXT, and a return-path CNAME).
2. Cloudflare → DNS → add them exactly (DKIM records must _not_ be
   proxied — grey cloud). Back in Resend, click **Verify**; it takes a few
   minutes.
3. **API Keys → Create API key** → name `anystudio-dev`, permission
   _Sending access_, restricted to the domain. Copy it (`re_…`).
4. `MAIL_FROM` = `AnyStudio <hello@anystudio.ai>` — an address on the
   verified domain.

Optional, same tier: `MAIL_ASSET_BASE` = `https://anystudio.ai/email` so the
emails carry their header images (they live in `apps/web/public/email`).

### `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET` — NGN, GHS, KES, ZAR

Without them, production refuses African-currency payments; outside
production a stub grants credits for free.

1. dashboard.flutterwave.com → complete business verification (CAC
   documents for Nigeria; this is the slow step — start it first).
2. **Settings → API Keys**. Use the **test** keys (`FLWSECK_TEST-…`) for dev
   and staging, the live key (`FLWSECK-…`) for production only.
3. **Settings → Webhooks** → URL
   `https://api.dev.anystudio.ai/api/v1/billing/webhooks/flutterwave`
   (per environment) → type any long random string into **Secret hash**
   (`openssl rand -hex 24` is fine) → that string is
   `FLUTTERWAVE_WEBHOOK_SECRET`. Tick "Receive webhook in test mode" on dev.

### `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV`, `PADDLE_PRODUCT_APPROVED`, `PADDLE_USAGE_PRODUCT_ID` — USD, GBP, EUR and everything else

Paddle is the merchant of record for the rest of the world: it handles VAT
and sales tax. Without it, non-African currencies fall to the stub outside
production and are refused in production.

1. sandbox-vendors.paddle.com → create a **sandbox** account first (instant).
   The **live** account (vendors.paddle.com) needs website approval: they
   check `https://anystudio.ai` has visible pricing, terms, a privacy policy
   and a refund policy — all four pages exist now (`/pricing`, `/terms`,
   `/privacy`, `/refunds`). Apply early; approval takes days. Separately,
   disclose the complete AnyStudio feature inventory (human-like presenters,
   talking photos, voice cloning/singing, dubbing/lip-sync, ad creation and
   automated publishing) and obtain written product approval. [Paddle's current
   AUP](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)
   restricts or prohibits several of those categories; a generally active
   live seller account is not evidence that this product is approved.
2. **Developer tools → Authentication → API keys → Generate** → copy
   (`pdl_sdbx_apikey_…` in sandbox). That is `PADDLE_API_KEY`.
3. Same page → **Client-side tokens → Generate** → `PADDLE_CLIENT_TOKEN`
   (`test_…`; this one is public and is served to the browser).
4. **Developer tools → Notifications → New destination** → type Webhook,
   URL `https://api.dev.anystudio.ai/api/v1/billing/webhooks/paddle`,
   events: everything under `transaction.*`, `subscription.*` and
   `adjustment.*` → Save → open it and copy the **secret key**
   (`pdl_ntfset_…`) → `PADDLE_WEBHOOK_SECRET`.
5. **Catalog → Products → New product** → name `AnyStudio usage`, tax
   category _Standard digital goods_ → Save → copy its id (`pro_…`) →
   `PADDLE_USAGE_PRODUCT_ID`. Usage invoices for organizations are billed as
   one-off prices under this product.
6. Create Paddle prices for every active plan (monthly and yearly) and every
   active credit pack. Create matching monthly and yearly Flutterwave payment
   plans. The seed deliberately does **not** create provider catalogue objects:
   record their `pri_…` / numeric ids in each environment's `providerRefs`.
7. Before production traffic, rehearse a real sandbox checkout, webhook,
   renewal, cancellation and refund in staging. Production `/ready` stays 503
   until both gateways, every active catalogue reference, and the Paddle usage
   product id are locally complete; it never calls either vendor.
8. `PADDLE_ENV` = `sandbox` on dev and staging, `live` on production. Keep
   `PADDLE_PRODUCT_APPROVED=false` everywhere until Paddle's written approval
   names the exact feature set; set it to `true` only in production after that
   approval. The API deliberately refuses to start with live Paddle credentials
   before this acknowledgement. Repeat
   steps 2–6 in the live account for production; every key, product, price,
   and plan id differs from its sandbox counterpart.

### `BANK_TRANSFER_DETAILS` (optional, tier 2)

Printed on every organization invoice as the bank-transfer option. Plain
text, `\n` for line breaks:
`AnyStudio Ltd\nGTBank 0123456789\nSort code / SWIFT …\nReference: the invoice number`.
Leave empty to offer online payment only.

### `PAYMENTS_DISABLED` (production only, until the gateways are approved)

Set to the exact string `true` when production is live **before** Paddle and
Flutterwave are approved — the site serves, people sign in and generate, and
organizations run on a credit line, but nobody can buy credits.

Without it the API is right to call itself degraded: a production deployment
with no gateway is normally a mistake. But `/ready` then answers `degraded`
forever, and `scripts/smoke-api.sh` requires `ready`, so **every release goes
red at the last step** — after the deploy has already landed. A gate that is
always red is a gate nobody reads.

It excuses one thing only: the absence of both gateways. Configure either one
and every catalogue check applies again, including the requirement for the
other — half a gateway is the state that takes money it cannot deliver on.
`/ready` reports `billing: { ready: true, payments: "off" }`, and the API
warns on every boot that nobody can buy anything.

**Delete it the day the keys go in.** Leave it and a real misconfiguration
reads as ready.

### `BOOTSTRAP_SUPERADMIN_EMAIL` (once, then remove)

The first staff account. Sign up normally on the app surface with your
email, turn on the second factor under Settings → Security, then set this
variable to that email, run the seed once (`npm run release` runs it on
deploy), sign in at `admin.dev.anystudio.ai`, and **delete the variable**.
Every later staff account is granted from the console.

---

## Tier 3 — AI providers (each switches on a set of models)

Every key is optional: the adapter registers only when its key is present,
and a model whose vendor has no key is simply not routable. Outside
production the stub adapter answers every capability so the product
demos without any of them. Costs and the full model map are in
`docs/PROVIDERS.md`. In rough order of value:

| Variable                                                                   | Gets you                                                                                                                | Steps                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_AI_API_KEY`                                                        | Gemini 3 Pro Image (edit, generate, replace background, relight), Gemini Flash-Lite copy, Veo video                     | aistudio.google.com → **Get API key** → Create API key in the `anystudio` project. Then **Billing** → link a billing account, or you stay on the free tier's rate limits.                                                                                          |
| `FAL_KEY`                                                                  | Seedream edit, Flux 2, Bria background removal, Clarity upscale, Wan video                                              | fal.ai → sign in → **Dashboard → Keys → Add key**. Add a card under Billing.                                                                                                                                                                                       |
| `ANTHROPIC_API_KEY`                                                        | Brand-voice copy and the in-app help assistant                                                                          | console.anthropic.com → **API Keys → Create key**. Optional `SUPPORT_MODEL` overrides the assistant's model (default `claude-haiku-4-5`).                                                                                                                          |
| `ELEVENLABS_API_KEY`                                                       | Voiceovers (multilingual TTS), music, dubbing, and "Your voice" (instant clone, stems, speech-to-speech — paid plan)    | elevenlabs.io → profile menu → **API Keys → Create**. Commercial use of generated music needs the Creator plan or above.                                                                                                                                           |
| `PHOTOROOM_API_KEY`                                                        | Background replacement with generated scenes, shadows, relighting                                                       | photoroom.com/api → **Get API key**; apply to the startup programme for the discount.                                                                                                                                                                              |
| `REPLICATE_API_TOKEN`                                                      | BiRefNet background removal (the cheap tier)                                                                            | replicate.com → **Account → API tokens → Create**.                                                                                                                                                                                                                 |
| `OPENAI_API_KEY`                                                           | TTS fallback; the historical Sora adapter is disabled before its 2026-09-24 API shutdown                                | platform.openai.com → **API keys → Create new secret key**.                                                                                                                                                                                                        |
| `BFL_API_KEY`                                                              | Flux Kontext, the budget edit tier                                                                                      | api.bfl.ai → sign up → **API keys**.                                                                                                                                                                                                                               |
| `HEYGEN_API_KEY`                                                           | Video translate and lip-sync                                                                                            | app.heygen.com → **Settings → API** → copy the key (you already hold one).                                                                                                                                                                                         |
| `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET`                             | Higgsfield's own image-to-video models (rows stay disabled until resale terms are agreed)                               | cloud.higgsfield.ai (Higgsfield Cloud, a separate account from the consumer app) → sign in → **Account settings → API keys** → key and secret pair. `platform.higgsfield.ai` is the API host, not a dashboard.                                                     |
| `SYNC_API_KEY`                                                             | Direct sync.so lip-sync (optional; the fal route covers it)                                                             | sync.so → dashboard → API keys.                                                                                                                                                                                                                                    |
| `GOOGLE_VERTEX_SA_JSON`, `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` | The same Google models through Vertex AI, with generative-AI indemnification — switch before selling to an organization | GCP console → **IAM → Service accounts → Create** → role _Vertex AI User_ → **Keys → Add key → JSON** → open the file and paste it as **one line**. Enable the Vertex AI API on the project. Location `us-central1`. When set, this wins over `GOOGLE_AI_API_KEY`. |

Minimum for a convincing demo: `GOOGLE_AI_API_KEY` + `FAL_KEY` +
`ANTHROPIC_API_KEY`. Add `ELEVENLABS_API_KEY` for anything with sound.

---

## Tier 4 — channels and integrations

### WhatsApp bot — `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`

The bot logs instead of sending until the first two are set, and the
webhook accepts nothing until the app secret is set. Full walk-through in
`docs/DEPLOY.md` §10; the short version:

1. developers.facebook.com → **Create app → Business** → add the
   **WhatsApp** product. Meta Business verification (documents, 2–10 days)
   is required before a real number can send to anyone.
2. **WhatsApp → API setup**: the **Phone number ID** (not the number) is
   `WHATSAPP_PHONE_NUMBER_ID`.
3. business.facebook.com → **Settings → Users → System users → Add** →
   Admin → **Assign assets** → the WhatsApp app → **Generate token** with
   `whatsapp_business_messaging` and `whatsapp_business_management`, no
   expiry. That permanent token is `WHATSAPP_ACCESS_TOKEN` (the 24-hour
   token on the API setup page is only for trying it).
4. `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: any string you choose
   (`openssl rand -hex 16`).
5. **App settings → Basic → App secret → Show** → `WHATSAPP_APP_SECRET`.
6. **WhatsApp → Configuration → Webhook → Edit**: callback URL
   `https://api.dev.anystudio.ai/api/v1/whatsapp/webhook`, verify token from
   step 4 → Verify and save → subscribe to **messages**.

### Publishing — `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`

Without them Instagram and TikTok show as "not switched on" in Post…; the
share sheet still works with no account.

- **Instagram**: the same Meta app as WhatsApp works. **App settings →
  Basic** gives `META_APP_ID` and `META_APP_SECRET`. Add the product
  **Facebook Login for Business** → Settings → Valid OAuth Redirect URIs:
  `https://app.dev.anystudio.ai/api/v1/publishing/callback/instagram` and the
  `org.` one (per environment). Until app review passes, only accounts with
  a role on the app can post — add yourself and testers under **App roles**.
  Submit for review with `instagram_basic`, `instagram_content_publish`,
  `pages_show_list`, `pages_read_engagement`, `business_management`; the
  review needs the privacy policy URL and a screencast of the flow.
- **TikTok**: developers.tiktok.com → **Manage apps → Connect an app** →
  add **Login Kit** and **Content Posting API** → scopes `user.info.basic`,
  `video.publish`, `video.upload` → redirect URI
  `https://app.dev.anystudio.ai/api/v1/publishing/callback/tiktok` (and
  `org.`). **Credentials** gives the client key and secret. Until review,
  posts are private to the account; the connector opens up automatically
  once review is through.

### Announcements — `REFUNDS_EMAIL`, `CAREERS_EMAIL` (optional)

Inbox addresses that get a copy when a customer requests a refund or
someone applies for a job. The staff console shows both regardless; set
these only if you want the email too.

### Error tracking — `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` (optional)

Leave empty and nothing starts. To turn it on:

1. sentry.io → **Create project → Node.js** → name `anystudio-api` → copy
   the DSN → `SENTRY_DSN` in the Render env group (the API and worker share
   it; events are tagged by `SERVICE_NAME`).
2. **Create project → Next.js** → `anystudio-web` → its DSN goes in GitHub
   → Settings → **Variables** (not secrets; it is public) as
   `NEXT_PUBLIC_SENTRY_DSN` on each environment. It is baked in at build
   time by the web deploy workflow.

---

## GitHub Actions — deploys only

| Where                                        | Name                       | Value                                                                                                                                                       |
| -------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo **Secrets**                             | `RENDER_API_KEY`           | Render → Account Settings → **API Keys → Create API key**                                                                                                   |
| Repo **Secrets**                             | `CLOUDFLARE_API_TOKEN`     | Cloudflare → My Profile → **API Tokens → Create Token** → template _Edit Cloudflare Workers_, plus **Zone → DNS → Edit** on `anystudio.ai` (custom domains) |
| Repo **Secrets**                             | `CLOUDFLARE_ACCOUNT_ID`    | Cloudflare dashboard → any zone → right-hand column **Account ID**                                                                                          |
| **Environments** → `development` → Variables | `RENDER_API_SERVICE_ID`    | required; `srv-…` from the URL of `anystudio-api-dev` in Render                                                                                             |
| same                                         | `RENDER_WORKER_SERVICE_ID` | required; `srv-…` of `anystudio-worker-dev` (fast/heavy queues)                                                                                             |
| same                                         | `RENDER_MEDIA_SERVICE_ID`  | required; `srv-…` of `anystudio-media-dev` (local media queue)                                                                                              |
| same                                         | `API_URL`                  | `https://anystudio-api-dev.onrender.com` — only until `api.dev.anystudio.ai` exists, then delete it                                                         |
| same                                         | `NEXT_PUBLIC_SENTRY_DSN`   | optional, see above                                                                                                                                         |

`GITHUB_TOKEN` is provided by Actions itself. Repeat the environment
variables for `staging` and `production` when those services exist.

---

## Local `.env` — the minimum

Copy `.env.example` to `.env`. With Docker running (`pnpm infra:up` starts
Postgres, Redis, MinIO and Mailpit) everything already has a local value
except:

- `APP_KEY` — generate one as above.
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — the local MinIO in
  `docker-compose.yml` uses `anystudio` / `anystudio`; the endpoint
  `http://localhost:9000` and bucket `anystudio-dev` are already filled in.
- Provider keys — none needed: the stub adapter serves every capability
  outside production. Add real ones only to test a real model.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional; password sign-in
  works without them.

---

## Order of operations, if you are starting today

1. `APP_KEY`, the three `ORIGIN_*`, R2 (tier 1) → the dev API boots.
2. GitHub secrets and the Render service ids → deploys run from Actions.
3. Resend → people can verify email. Google OAuth consent screen with the
   privacy and terms URLs → Google sign-in.
4. `GOOGLE_AI_API_KEY`, `FAL_KEY`, `ANTHROPIC_API_KEY` → the studio makes
   real pictures and words.
5. Paddle **sandbox** and Flutterwave **test** keys → run the payment
   rehearsal in `docs/DEPLOY.md` §18 on dev.
6. Start the slow approvals in parallel: Flutterwave business verification,
   Paddle live-account website check, Meta business verification, Meta and
   TikTok app review. Each takes days to weeks and none blocks the others.
7. `BOOTSTRAP_SUPERADMIN_EMAIL` → first sign-in at the staff console →
   remove it.
8. Live payment keys, `PADDLE_ENV=live`, production env group → first
   customer.
