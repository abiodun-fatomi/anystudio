# Deploying AnyStudio

`anystudio.ai` is registered and its nameservers already point at Cloudflare
(`heather.ns.cloudflare.com`, `josh.ns.cloudflare.com`). No records exist yet.

---

## 1. Where things run

| What | Where | Why |
|---|---|---|
| Web surfaces (app, org, admin, marketing) | **Cloudflare Workers**, via the OpenNext adapter | Domain, DNS, R2 and the API proxy are already on Cloudflare; the free tier allows commercial use; a custom domain on a Worker creates its own DNS record and certificate |
| API + queue worker | **Render** (Frankfurt) | NestJS is a long-running Node process with a Prisma connection pool — not a fit for Workers |
| Postgres | **Render** (same region as the API) | Private network, so the database has no public endpoint |
| Media | **Cloudflare R2** | One bucket per environment |

Three environments, three branches, three of every Worker:

| Branch | Environment | Hosts | Deploys |
|---|---|---|---|
| `development` | development | `*.dev.anystudio.ai` | on every push |
| `staging` | staging | `*.staging.anystudio.ai` | on every push |
| `production` | production | `anystudio.ai`, `app.`, `org.`, `admin.`, `api.` | on push, after a human merges |

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
owning two hostnames (the marketing site and the app — `middleware.ts` routes
by host). **GitHub Actions builds and deploys them**
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

`Web` workflow → *Build* (typecheck, `opennextjs-cloudflare build`) → *Deploy*
(`wrangler deploy --env <branch>`). The run shows on the commit, the PR and
the **Deployments** tab. A two-level hostname such as `app.dev.anystudio.ai`
gets its own certificate on first creation; the browser shows an SSL error
for the 5–15 minutes that takes.

### 2.3 Check

- `https://dev.anystudio.ai` — the landing page, `/pricing`, `/developers`, `/org`
- `https://app.dev.anystudio.ai/login` — the sign-in page
- `curl -I https://app.dev.anystudio.ai` → `server: cloudflare`

Sign-in fails with a network error until the dev API exists (section 3).

### 2.4 Promoting code between environments

Nobody pushes to `development`, `staging` or `production` directly — not
even the owner. A GitHub ruleset (Settings → Rules → Rulesets) requires a
pull request for all three, blocks force-pushes and deletions, and has an
empty bypass list. Every deploy is therefore the result of a merge.

| Change | Branch to open the PR from | Into | Merge method |
|---|---|---|---|
| A feature or fix | `feat/…` or `fix/…` | `development` | Squash |
| Promote to staging | `development` | `staging` | **Merge commit** |
| Promote to production | `staging` | `production` | **Merge commit** |

Promotion PRs must be *merge commits*, never squashes: squashing rewrites the
commits, the environment branches diverge, and the next promotion PR shows
every old change again and conflicts on all of them.

---

## 3. The API and worker on Render

The API is deployed the same way the web portal is: **from GitHub Actions**
(`.github/workflows/api.yml`), never by Render watching the branch. A push to
`development`, `staging` or `production` that touches the backend runs
*Check* (Prisma drift, migrations apply, typecheck, tests, build, and the
Docker image builds) and then *Deploy*, which asks Render to deploy **that
exact commit**, waits until Render reports it live, and finally reads
`release` from `/health` through Cloudflare to prove the process serving
traffic is the commit that was just tested. Production waits for the
required reviewer on the `production` environment, exactly like the web.

```
push → Check ──ok──▶ Deploy: API (migrations run in Render's pre-deploy step)
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

   | Variable | Value |
   |---|---|
   | `RENDER_API_SERVICE_ID` | `srv-…` of `anystudio-api-dev` |
   | `RENDER_WORKER_SERVICE_ID` | `srv-…` of `anystudio-worker-dev` — the blueprint creates it; set this so the workflow deploys the worker after the API |
   | `API_URL` | `https://anystudio-api-dev.onrender.com` — **only until** `api.dev.anystudio.ai` exists (3.2); then delete it |

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
   *Always Use HTTPS* on, *Minimum TLS* 1.2. Leave Cloudflare's HSTS off —
   the API sends its own.
7. Cloudflare → **Security** → **WAF** → **Rate limiting rules** → one rule:
   `(ends_with(http.host, "anystudio.ai") and starts_with(http.request.uri.path, "/api/v1/auth/"))`,
   10 requests / 10 s per IP, Block 60 s.
8. `curl https://api.dev.anystudio.ai/ready` → `"status":"ready"`, header
   `server: cloudflare`. Then delete `API_URL` from the GitHub environment so
   the smoke test goes through Cloudflare like real traffic.

Same again for `api.staging` and `api` when those environments exist.

### 3.3 What is where, on a running API

| Path | What |
|---|---|
| `/health`, `/ready` | probes — outside `/api`, unversioned, never move |
| `/api/v1/…` | every endpoint; every response is `{ status, message, data }` |
| `/api/v1/docs` | Swagger UI — dev and staging only, off in production |

### Email, once there is any

| Type | Name | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:<provider> -all` |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@anystudio.ai` |
| CNAME | *(provider DKIM records)* | |

`-all` not `~all`. A soft fail invites spoofing of a domain that sends password
resets.

---

## 4. Accounts to create

Only the account owner can do these; none can be automated from here.

| Service | For | Notes |
|---|---|---|
| **Cloudflare** | DNS, Workers (web), R2 (media), WAF | One account; the zone is already here |
| **Render** | API, Postgres, later the worker and Redis | Import `render.yaml` as a Blueprint; today it creates the dev API and its database |
| **Google Cloud** | Sign in with Google | One OAuth client, all redirect URIs on it (section 9.1) |
| **Resend** | transactional mail | Verify `anystudio.ai`, one API key (section 9.2) |
| **Cloudflare R2** | media | One bucket per environment, with a `dev/` prefix on the staging one |
| **Flutterwave / Paddle** | payments | Not needed until Phase 5 |

---

## 5. Secrets, per environment

Set in the Render **Env Group** for the environment (`anystudio-dev` today),
which every service in that environment reads. Never in the repo, never in a
GitHub secret, never in a chat.

`DATABASE_URL` and `DIRECT_URL` are **not** in this list: Render injects them
from the database itself (`fromDatabase` in `render.yaml`), so nobody ever
copies a connection string by hand.

| Secret | Notes |
|---|---|
| `APP_KEY` | `openssl rand -base64 32`. Encrypts TOTP seeds and the Google handshake cookie — **rotating it locks every staff account out of MFA** unless you re-encrypt first. A different one per environment |
| `ORIGIN_APP` / `ORIGIN_ORG` / `ORIGIN_ADMIN` | Exact origins, e.g. `https://app.dev.anystudio.ai`. The API refuses to start with none set |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Section 9.1. With either missing the button degrades to a message, never to a half-working flow |
| `RESEND_API_KEY` / `MAIL_FROM` | Section 9.2. `MAIL_FROM` like `AnyStudio <hello@anystudio.ai>`, on the verified domain |
| `R2_*` | Separate keys per environment |
| `HIGGSFIELD_API_KEY`, `HEYGEN_API_KEY` | **Never** in a web Worker — a provider key in a web app's environment is one careless import from the browser bundle |
| `FLUTTERWAVE_*`, `PADDLE_*` | Includes webhook signing secrets. Not needed until Phase 5 |
| `WHATSAPP_*` | Phone number id, access token, webhook verify token |

GitHub, for the deploy workflows: one repository secret, `RENDER_API_KEY`,
plus `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the web; and the
three non-secret environment variables from section 3.1 on each environment.

---

## 6. Branches, CI and the approval gate

| Branch | Environment | Deploys |
|---|---|---|
| `development` | `*.dev.anystudio.ai` | automatically, after CI passes |
| `staging` | `*.staging.anystudio.ai` | automatically, after CI passes |
| `production` | `anystudio.ai` | after CI passes **and** a human approves |

The approval gate is a **required reviewer on the `production` GitHub
environment**. Set it in Settings → Environments, or production deploys are
automatic and the branch protection is decorative.

---

## 7. Order of operations

1. Section 2.1–2.3: the development web Worker, on `app.dev.anystudio.ai`
2. Section 3: import the blueprint — it creates the dev API and its Postgres
   together — then set the env group, the GitHub variables, deploy, and add
   `api.dev.anystudio.ai`
4. Sign up on `app.dev.anystudio.ai/signup` — landing on `/welcome` proves the whole chain
5. Repeat for staging
6. Only then production

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
ID** → *Web application*.

**Authorised redirect URIs** — the callback is on the *app's* hostname, not the
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
