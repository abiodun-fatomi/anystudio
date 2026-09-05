# Deploying AnyStudio

`anystudio.ai` is registered and its nameservers already point at Cloudflare
(`heather.ns.cloudflare.com`, `josh.ns.cloudflare.com`). No records exist yet.

---

## 1. Where things run

| What                                      | Where                                            | Why                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web surfaces (app, org, admin, marketing) | **Cloudflare Workers**, via the OpenNext adapter | Domain, DNS, R2 and the API proxy are already on Cloudflare; the free tier allows commercial use; a custom domain on a Worker creates its own DNS record and certificate |
| API + queue worker                        | **Render** (Frankfurt)                           | NestJS is a long-running Node process with a Prisma connection pool — not a fit for Workers                                                                              |
| Postgres                                  | **Render** (same region as the API)              | Private network, so the database has no public endpoint                                                                                                                  |
| Media                                     | **Cloudflare R2**                                | One bucket per environment                                                                                                                                               |

Three environments, three branches, three of every Worker:

| Branch        | Environment | Hosts                                            | Deploys                       |
| ------------- | ----------- | ------------------------------------------------ | ----------------------------- |
| `development` | development | `*.dev.anystudio.ai`                             | on every push                 |
| `staging`     | staging     | `*.staging.anystudio.ai`                         | on every push                 |
| `production`  | production  | `anystudio.ai`, `app.`, `org.`, `admin.`, `api.` | on push, after a human merges |

### Why staging and development nest under their own subdomain

Name staging `app-staging.anystudio.ai` and every host is a sibling under
`anystudio.ai` — so any cookie ever set on the parent domain is readable by
every environment. One careless `domain=.anystudio.ai` and a staging bug can
read production sessions. Under `*.dev.anystudio.ai` and
`*.staging.anystudio.ai` the trees cannot see each other's cookies.

---

## 2. Web surfaces on Cloudflare Workers

Each surface has a `wrangler.jsonc` with three named environments
(`development`, `staging`, `production`). Each environment is its own Worker,
owning four hostnames — the marketing site, `app.` (businesses and personal
studios), `org.` (organizations) and `admin.` (staff) — with `middleware.ts`
routing by host. `app.` and `org.` serve the same pages; what differs is the
session: each is a `__Host-` cookie that cannot cross hostnames, so an
organization is opened by a one-time hand-off (`POST /auth/hop`) and the
sign-in page sends someone whose only workspaces are organizations straight
to `org.`. The API must list every origin in `ORIGIN_APP` / `ORIGIN_ORG` /
`ORIGIN_ADMIN` or CORS refuses the host. **GitHub Actions builds and deploys them**
(`.github/workflows/web-deploy.yml`): a push to a branch deploys the matching
environment, and the first deploy creates the Worker, its custom domains and
their certificates. Nothing is configured in the Cloudflare dashboard.

### 2.1 One-time setup

1. Cloudflare → My Profile → API Tokens → Create → template **Edit Cloudflare
   Workers** → scope the zone policy to `anystudio.ai` and add **DNS · Edit**
   and **SSL and Certificates · Edit**. No expiration.
2. GitHub → repo → Settings → Secrets and variables → Actions:
   `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (the 32-hex
   id in every dashboard URL).
3. GitHub → Settings → Environments → create **`production`** and add yourself
   under **Required reviewers**. That is the release gate. The other two
   environments are created by the first deploy.
4. If a Worker was ever connected to the repo from the Cloudflare side
   (Worker → Settings → Build), **disconnect** it — otherwise every merge
   deploys twice.

There are no per-environment variables anywhere: the app derives its API and
admin hostnames from the request host (`apps/web/lib/hosts.ts`), and the
Worker's runtime values live in `wrangler.jsonc` under each environment.

### 2.2 What a deploy does

`Web` workflow → _Build_ (typecheck, `opennextjs-cloudflare build`) → _Deploy_
(`wrangler deploy --env <branch>`). The run shows on the commit, the PR and
the **Deployments** tab. A two-level hostname such as `app.dev.anystudio.ai`
gets its own certificate on first creation; the browser shows an SSL error
for the 5–15 minutes that takes.

### 2.3 Check

- `https://dev.anystudio.ai` — the landing page, `/pricing`, `/developers`, `/org`
- `https://dev.anystudio.ai/login` — the sign-in page (`/signup`, `/forgot`,
  `/reset` live here too; `app.` is for people who are signed in and sends
  those paths back across)
- `curl -I https://app.dev.anystudio.ai` → `server: cloudflare`

Sign-in fails with a network error until the dev API exists (section 3).

How a sign-in crosses hosts: the session cookie is `__Host-` scoped, so only
`app.dev.anystudio.ai` can set it. A sign-in on `dev.anystudio.ai` therefore
returns `{ status: "handoff", url }` — a one-time, one-minute token on
`app.dev.anystudio.ai/auth/handoff` — and the page there redeems it
(`POST /auth/handoff`) and mints the session. The API decides from the
request's origin and `APP_ENV`, so nothing is configured; Google sign-in
starts on the app host directly (the button links across).

### 2.4 Promoting code between environments

Nobody pushes to `development`, `staging` or `production` directly — not
even the owner. A GitHub ruleset (Settings → Rules → Rulesets) requires a
pull request for all three, blocks force-pushes and deletions, and has an
empty bypass list. Every deploy is therefore the result of a merge.

| Change                | Branch to open the PR from | Into          | Merge method     |
| --------------------- | -------------------------- | ------------- | ---------------- |
| A feature or fix      | `feat/…` or `fix/…`        | `development` | Squash           |
| Promote to staging    | `development`              | `staging`     | **Merge commit** |
| Promote to production | `staging`                  | `production`  | **Merge commit** |

Promotion PRs must be _merge commits_, never squashes: squashing rewrites the
commits, the environment branches diverge, and the next promotion PR shows
every old change again and conflicts on all of them.

---

## 3. The API and worker on Render

The API is deployed the same way the web portal is: **from GitHub Actions**
(`.github/workflows/api.yml`), never by Render watching the branch. A push to
`development`, `staging` or `production` that touches the backend runs
_Check_ (Prisma drift, migrations apply, typecheck, tests, build, and the
Docker image builds) and then _Deploy_, which asks Render to deploy **that
exact commit**, waits until Render reports it live, and finally reads
`release` from `/health` through Cloudflare to prove the process serving
traffic is the commit that was just tested. Production waits for the
required reviewer on the `production` environment, exactly like the web.

```
push → Check ──ok──▶ Deploy: API (migrations, then the seed, run in Render's pre-deploy step)
                            ▶ worker (only where RENDER_WORKER_SERVICE_ID is set)
                            ▶ smoke: /health.release == sha, /ready == ready
```

### 3.1 One-time setup on Render

1. Render → **New** → **Blueprint** → this repo → it reads `render.yaml` and
   creates two resources: `anystudio-api-dev` and its Postgres,
   `anystudio-db-dev`. The service tracks `development` and has auto-deploy
   **off**. Staging and production are added to `render.yaml` when they are
   needed — an idle paid instance per environment costs money from the day it
   is created, not from the day it is used.
2. It asks for every `sync: false` value in the `anystudio-dev` env group.
   Fill in
   what you have (section 5); anything you do not have yet can stay empty and
   be added later under **Env Groups**. The API refuses to start without
   `APP_KEY`, `DATABASE_URL` and the three `ORIGIN_*`.
3. Render → Account Settings → **API Keys** → create one. In GitHub → repo →
   Settings → Secrets and variables → Actions → **Secrets**: `RENDER_API_KEY`.
4. For each service, copy its id (`srv-…`, in the URL of its dashboard page).
   In GitHub → Settings → **Environments** → `development` → **Environment
   variables** (not secrets — they are not sensitive):

   | Variable                   | Value                                                                                                                   |
   | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
   | `RENDER_API_SERVICE_ID`    | `srv-…` of `anystudio-api-dev`                                                                                          |
   | `RENDER_WORKER_SERVICE_ID` | `srv-…` of `anystudio-worker-dev` — the blueprint creates it; set this so the workflow deploys the worker after the API |
   | `API_URL`                  | `https://anystudio-api-dev.onrender.com` — **only until** `api.dev.anystudio.ai` exists (3.2); then delete it           |

   The worker is the API image started with `node dist/src/worker/main.js`
   (one Dockerfile, two commands — see `apps/api/Dockerfile`). `render.yaml`
   declares it alongside a Key Value instance for the queue. Redis is an
   accelerator, not a dependency: with it unreachable the API still accepts
   generations and the worker runs QUEUED rows straight from Postgres.

   Same for `staging` and `production` with their services.

5. Merge something into `development` that touches `apps/api/**`, or run the
   **API** workflow by hand (Actions → API → Run workflow). The first deploy
   builds the image cold (~8 minutes); later ones reuse the layer cache.

### 3.2 DNS: `api.dev.anystudio.ai`

The API is the one hostname added to DNS by hand, and the one that is
proxied (orange cloud): DDoS absorption and the WAF sit in front of the
origin that holds credentials.

1. Confirm `https://anystudio-api-dev.onrender.com/health` returns
   `"status":"ok"` on the plain Render hostname **before** touching DNS.
2. Render service → **Settings** → **Custom Domains** → add `api.dev.anystudio.ai`.
3. Cloudflare → **DNS** → **Records** → Add: `CNAME`, name `api.dev`, target
   `anystudio-api-dev.onrender.com`, **grey cloud** for now. Save.
4. Wait until Render shows the certificate as **Issued**.
5. Edit the record → **orange cloud** → Save.
6. Cloudflare → **SSL/TLS** → Overview → **Full (strict)**. Edge Certificates →
   _Always Use HTTPS_ on, _Minimum TLS_ 1.2. Leave Cloudflare's HSTS off —
   the API sends its own.
7. Cloudflare → **Security** → **WAF** → **Rate limiting rules** → one rule:
   `(ends_with(http.host, "anystudio.ai") and starts_with(http.request.uri.path, "/api/v1/auth/"))`,
   10 requests / 10 s per IP, Block 60 s.
8. `curl https://api.dev.anystudio.ai/ready` → `"status":"ready"`, header
   `server: cloudflare`. Then delete `API_URL` from the GitHub environment so
   the smoke test goes through Cloudflare like real traffic.

Same again for `api.staging` and `api` when those environments exist.

### 3.3 What is where, on a running API

| Path                | What                                                          |
| ------------------- | ------------------------------------------------------------- |
| `/health`, `/ready` | probes — outside `/api`, unversioned, never move              |
| `/api/v1/…`         | every endpoint; every response is `{ status, message, data }` |
| `/api/v1/docs`      | Swagger UI — dev and staging only, off in production          |

### Email, once there is any

| Type  | Name                      | Value                                                   |
| ----- | ------------------------- | ------------------------------------------------------- |
| TXT   | `@`                       | `v=spf1 include:<provider> -all`                        |
| TXT   | `_dmarc`                  | `v=DMARC1; p=quarantine; rua=mailto:dmarc@anystudio.ai` |
| CNAME | _(provider DKIM records)_ |                                                         |

`-all` not `~all`. A soft fail invites spoofing of a domain that sends password
resets.

---

## 4. Accounts to create

Only the account owner can do these; none can be automated from here.

| Service                  | For                                       | Notes                                                                              |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| **Cloudflare**           | DNS, Workers (web), R2 (media), WAF       | One account; the zone is already here                                              |
| **Render**               | API, Postgres, later the worker and Redis | Import `render.yaml` as a Blueprint; today it creates the dev API and its database |
| **Google Cloud**         | Sign in with Google                       | One OAuth client, all redirect URIs on it (section 9.1)                            |
| **Resend**               | transactional mail                        | Verify `anystudio.ai`, one API key (section 9.2)                                   |
| **Cloudflare R2**        | media                                     | One bucket per environment, with a `dev/` prefix on the staging one                |
| **Flutterwave / Paddle** | payments                                  | Section 5                                                                          |
| **Meta for Developers**  | the WhatsApp bot                          | Business verification, a WhatsApp Business app, a System User token (section 10)   |

---

## 5. Secrets, per environment

Set in the Render **Env Group** for the environment (`anystudio-dev` today),
which every service in that environment reads. Never in the repo, never in a
GitHub secret, never in a chat.

`DATABASE_URL` and `DIRECT_URL` are **not** in this list: Render injects them
from the database itself (`fromDatabase` in `render.yaml`), so nobody ever
copies a connection string by hand.

| Secret                                                                                                      | Notes                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_KEY`                                                                                                   | `openssl rand -base64 32`. Encrypts TOTP seeds and the Google handshake cookie — **rotating it locks every staff account out of MFA** unless you re-encrypt first. A different one per environment                                                                        |
| `ORIGIN_APP` / `ORIGIN_ORG` / `ORIGIN_ADMIN`                                                                | Exact origins, e.g. `https://app.dev.anystudio.ai`. The API refuses to start with none set                                                                                                                                                                                |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                                                                 | Section 9.1. With either missing the button degrades to a message, never to a half-working flow                                                                                                                                                                           |
| `RESEND_API_KEY` / `MAIL_FROM`                                                                              | Section 9.2. `MAIL_FROM` like `AnyStudio <hello@anystudio.ai>`, on the verified domain                                                                                                                                                                                    |
| `R2_*`                                                                                                      | Separate keys per environment. The bucket needs a CORS policy (below) or browser uploads fail as "interrupted"                                                                                                                                                            |
| `MAIL_ASSET_BASE`                                                                                           | Optional. `https://<marketing host>/email` — where the email images live (apps/web/public/email). Unset, emails send without pictures                                                                                                                                     |
| `HIGGSFIELD_API_KEY`, `HEYGEN_API_KEY`                                                                      | **Never** in a web Worker — a provider key in a web app's environment is one careless import from the browser bundle                                                                                                                                                      |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET`                                                      | Flutterwave v3 secret key and the dashboard webhook hash. Webhook URL `https://<api>/api/v1/billing/webhooks/flutterwave`. Without the key, non-production falls back to the stub gateway; production refuses NGN payments                                                |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_ENV`                              | Paddle Billing API key, notification-endpoint secret, the public client-side token (served to the web app by `/billing/config`), and `sandbox`/`live`. Webhook URL `https://<api>/api/v1/billing/webhooks/paddle`. Production logs an error if `PADDLE_ENV` is not `live` |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Section 10. The bot logs instead of sending until the first two are set; the webhook accepts nothing until the app secret is set                                                                                                                                          |

GitHub, for the deploy workflows: one repository secret, `RENDER_API_KEY`,
plus `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the web; and the
three non-secret environment variables from section 3.1 on each environment.

---

### 5.1 The R2 bucket's CORS policy

The browser PUTs uploads straight to R2 with a signed URL, so the bucket
must allow the app's origin. R2 → bucket → **Settings → CORS Policy**:

```json
[
  {
    "AllowedOrigins": ["https://app.dev.anystudio.ai", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Production's bucket gets the same with `https://app.anystudio.ai`. Without
it every upload fails in the browser as "The upload was interrupted".

---

## 6. Branches, CI and the approval gate

| Branch        | Environment              | Deploys                                  |
| ------------- | ------------------------ | ---------------------------------------- |
| `development` | `*.dev.anystudio.ai`     | automatically, after CI passes           |
| `staging`     | `*.staging.anystudio.ai` | automatically, after CI passes           |
| `production`  | `anystudio.ai`           | after CI passes **and** a human approves |

The approval gate is a **required reviewer on the `production` GitHub
environment**. Set it in Settings → Environments, or production deploys are
automatic and the branch protection is decorative.

---

## 7. Order of operations

1. Section 2.1–2.3: the development web Worker, on `app.dev.anystudio.ai`
2. Section 3: import the blueprint — it creates the dev API and its Postgres
   together — then set the env group, the GitHub variables, deploy, and add
   `api.dev.anystudio.ai`
3. Sign up on `dev.anystudio.ai/signup` — landing on `app.dev.anystudio.ai/welcome` proves the whole chain, hand-off included
4. Repeat for staging
5. Only then production

**Do not skip step 3.** A failing health check behind a proxy and a fresh
certificate is three problems at once; behind a plain hostname it is one.

---

## 8. What is not ready

- Only the **user portal** (`apps/web`, → `app.`) has a Worker config. The
  org and admin portals do not exist as apps yet; when they do, each gets its
  own `wrangler.jsonc` with the same three environments.
- The marketing site (`anystudio.ai` apex) is still the static prototype in
  `design/landing.html`. Until it moves into an app, nothing serves the apex.
- **No `prisma/migrations/…_init` yet.** Run `pnpm db:migrate --name init`
  locally once (against `pnpm infra:up`'s Postgres) and commit the folder —
  `db:deploy` on Render applies committed migrations and does nothing without
  them, so every `/auth/*` call would fail on a missing table.
- Rate limiting inside the API is a table (`apps/api/config/rate-limit`)
  and not yet a guard; the Cloudflare rule in section 3.2 is the only limit
  on `/api/v1/auth/*` for now.

---

## 9. Sign in with Google, mail, and the database

### 9.1 Google OAuth client

Google Cloud Console → APIs & Services → Credentials → **Create OAuth client
ID** → _Web application_.

**Authorised redirect URIs** — the callback is on the _app's_ hostname, not the
API's, so the handshake cookie stays first-party. Add one per surface you have:

```
http://localhost:3000/api/v1/auth/google/callback
https://app.dev.anystudio.ai/api/v1/auth/google/callback
https://app.staging.anystudio.ai/api/v1/auth/google/callback
https://app.anystudio.ai/api/v1/auth/google/callback
```

The path is exact: Google compares the whole URI, and the API builds it from
`GOOGLE_CALLBACK_PATH` in `apps/api/src/utils/constant.ts`.

Put the client id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in
the environment's Render env group. With either missing, the button returns people to `/login`
with a message instead of failing — a half-configured client never half-works.

**The admin surface does not accept Google.** Google proves an email; it does
not prove a second factor, and `SessionService` refuses an ADMIN session below
`mfaLevel` 2. Staff sign in with a password and a factor.

### 9.2 Resend

resend.com → add `anystudio.ai` → it gives you DKIM, SPF and a return-path
record for Cloudflare DNS. Verify, create an API key, set `RESEND_API_KEY` and
`MAIL_FROM` in the environment's Render env group.

The mailer picks a transport in this order: Resend if `RESEND_API_KEY` is set,
otherwise `SMTP_URL` (Mailpit locally), otherwise it logs what it would have
sent. So a fresh checkout boots and signs people up without any mail config.

### 9.3 The database

Render creates it from `render.yaml` and injects `DATABASE_URL` and
`DIRECT_URL` into the API. There is nothing to copy and no connection string
to keep anywhere.

Three things worth knowing about how it is configured:

**It has no public endpoint.** `ipAllowList: []` means only Render services
in `frankfurt` can reach it. That is deliberate for a database holding
password hashes and the credit ledger. To point a GUI at it from your
laptop, add your own IP to that list temporarily and take it out again —
do not leave it open.

**The API and the database must stay in the same region.** They talk over
Render's private network; put them in different regions and the traffic goes
out over the public internet instead, which is both slower and no longer
private.

**Pooling is off until you need it.** Both `DATABASE_URL` and `DIRECT_URL`
point at the direct connection while one instance serves dev. When you scale
past one instance, set `connectionPool: pgbouncer` on the database and change
`DATABASE_URL` alone to `connectionPoolString`. Migrations must keep the
direct string — DDL and advisory locks do not survive a transaction pooler,
which is the whole reason `schema.prisma` declares `directUrl`. Point both at
a pooler and `db:deploy` will hang or half-apply.

Locally, `docker-compose` has no pooler and the two are the same string.

---

## 10. The WhatsApp bot

The bot is the API process: `POST /api/v1/whatsapp/webhook` receives, the
worker's `GenerationHooks` sends results back. Nothing else to deploy.

**At Meta (once, by the account owner):**

1. Meta Business Suite → verify the business (days to weeks; start now).
2. developers.facebook.com → create an app of type _Business_ → add the
   **WhatsApp** product. The test number it gives you works immediately for
   up to five recipients; a real number needs the business verified and the
   number registered under the WhatsApp Business Account.
3. **App settings → Basic → App secret** → `WHATSAPP_APP_SECRET`. Every
   webhook is signed with it; the API refuses everything when it is unset.
4. **WhatsApp → API setup → Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
5. **Business settings → System users** → add a system user (admin), assign
   the app and the WhatsApp account, generate a token with
   `whatsapp_business_messaging` and `whatsapp_business_management`, no
   expiry → `WHATSAPP_ACCESS_TOKEN`. (The token on the API-setup page
   expires in 24 hours; do not deploy that one.)
6. **WhatsApp → Configuration → Webhook**: callback URL
   `https://<api host>/api/v1/whatsapp/webhook`, verify token = whatever you
   put in `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, then **Manage** → subscribe to
   `messages`. Meta calls the GET once with the token; the API echoes the
   challenge when it matches.
7. Deploy with the four variables in the environment's Env Group. Send
   "hi" to the number.

**What the bot sends is media by link**: the signed R2 URLs the studio
uses, fetched by Meta within the hour they last. R2 must be reachable from
Meta's fetchers (it is, on the public bucket endpoint the API signs for).

**Costs to know**: Meta charges per conversation window (24 hours) opened
by the business; a customer who writes first opens a free service window.
Everything the bot sends is a reply inside such a window, so the bot costs
nothing on Meta's side unless it messages first — which it never does.

**Opt-out** is a word, "stop", honoured immediately and recorded on the
contact; the next message from them opens things up again.

---

## 11. The staff console

`admin.<base>` — its own hostname so its session cookie is its own; the
same web build (`app/admin/*`, served only on that host by the middleware)
and the same API (`/api/v1/admin/*`, ADMIN surface + staff rank on every
route). The Worker's routes in `wrangler.jsonc` include the admin hostname
per environment; add the DNS record beside `app.` and `api.`.

**Signing in.** The API mints an ADMIN session only past a second factor:
the person signs in at `https://admin.<base>/login` with their password
and then their authenticator code. An account without a confirmed factor,
or without a staff grant, is refused in words. Staff mutations (turning a
provider off, adjusting credits, refunding, suspending, granting) also
require the factor to have been confirmed within the last thirty minutes
and refuse anything touching a workspace the staff member belongs to.

**The first staff member.** Nobody can grant themselves. Set
`BOOTSTRAP_SUPERADMIN_EMAIL` to an existing account, run the seed once
(`pnpm db:seed`, which is also part of the deploy's pre-deploy step), then
remove the variable. Everyone after that is granted from **Staff** in the
console, with a reason, and revoked there.

**What it does.** Overview (failures, breakers, rows with no key, queue
health); customers (search, detail, suspend/reinstate); workspaces (ledger,
credit adjustments with a reason, owner notified); generations (inputs,
outputs, provider job id, the operator-facing failure reason; end a stuck
row; goodwill refund); payments (mark refunded after refunding at the
gateway; credits clawed back); providers (on/off, priority, close a
breaker) and prices; platform messages (into every bell, by audience);
staff; the audit log.

**Locally**: `next dev -p 3003` beside the app on 3000 — the API maps
`localhost:3003` to the ADMIN surface.

## 12. Help & support (the chat floater)

Every signed-in page has a help floater. It opens a chat with an assistant
(Claude, through `ANTHROPIC_API_KEY`; `SUPPORT_MODEL` overrides the model)
that knows the product and its prices, points people at the right screen,
and sets a **needs-a-person** flag when money, a locked account, a repeated
failure or anything it cannot answer comes up. Staff see every chat — the
person's words and the assistant's answers — under **Help chats** in the
console, can reply into it (the reply lands in the floater and rings the
person's bell) and can close it. Closing a chat, by the person or by staff,
emails them the transcript; chats quiet for a day are closed by the worker
and mailed the same way.

Fail-safes: with no `ANTHROPIC_API_KEY`, or when the vendor is down or slow
(20 s), the person gets an honest holding line and the chat is flagged for
staff — the chat never errors. Each message costs one model call and is
rate-limited per account (20/min, 200/day). Logs tell the story as
`support.opened` → `support.message` (needsHuman, fallback) →
`support.staff_reply` → `support.closed` (by whom; transcript sent, skipped,
failed, or no email on file).

Nothing else to configure. The migration `20260914000000_support_chat`
adds the tables.

## 13. Publishing (Instagram and TikTok)

Finished pictures and reels leave through **Post…** on a library item or a
studio result. Two roads: a connected account (Instagram, TikTok), now or at
a chosen time; or the share sheet, which needs no account — a one-hour link
to the file, the caption on the clipboard, and on a phone the native share
sheet with the file attached, which is how a WhatsApp Status is posted
(WhatsApp offers no API for Status).

**How it runs.** A post is a row in `publish_jobs` with a time. The worker
polls the database every fifteen seconds, claims what is due with a
conditional update, posts it and records the outcome — no Redis in the
path, so a Redis outage cannot lose a scheduled post. A platform that says
"not now" is retried in two minutes, then ten; one that says "never" (bad
file, dead token) is not retried, and a dead token marks the account as
needing re-authorisation. Tokens are encrypted under `APP_KEY` at rest and
refreshed a week before expiry. Posted and failed both reach the bell.

**Variables.** Without them a platform reports itself "not switched on"
and the connect button does not appear.

| Variable                                    | Where it comes from                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_APP_ID`, `META_APP_SECRET`            | developers.facebook.com → your app → App settings → Basic. Add the product **Facebook Login for Business** and, under its Settings, the Valid OAuth Redirect URI `https://app.<base>/api/v1/publishing/callback/instagram` (and the `org.` one). Permissions used: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`. |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | developers.tiktok.com → your app → Credentials. Add **Login Kit** and **Content Posting API**; scopes `user.info.basic`, `video.publish`, `video.upload`; redirect URI `https://app.<base>/api/v1/publishing/callback/tiktok` (and `org.`).                                                                                                                                           |

**Before app review.** Meta only grants `instagram_content_publish` to
accounts with a role on the app (developers and testers) until the app
passes review — enough for dev and staging. TikTok, until its review, lets
an app post only as private to the account (`SELF_ONLY`); the connector
reads what the account allows and uses the most open level, so the same
code posts publicly once the review is through. Instagram can only be
posted to as a **Professional** account (Business or Creator) linked to a
Facebook Page; personal accounts are refused by Meta, and the page says so.
TikTok photo posts need the pull domain verified in the TikTok app
settings, which a signed R2 host cannot be; videos are pushed and need no
such thing, so TikTok takes videos only for now.

**Migration.** `20260916000000_publishing` adds `social_accounts` and
`publish_jobs`.
