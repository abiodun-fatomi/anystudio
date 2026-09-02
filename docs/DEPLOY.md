# Deploying AnyStudio

`anystudio.ai` is registered and its nameservers already point at Cloudflare
(`heather.ns.cloudflare.com`, `josh.ns.cloudflare.com`). No records exist yet.

---

## 1. Where things run

| What | Where | Why |
|---|---|---|
| Web surfaces (app, org, admin, marketing) | **Cloudflare Workers**, via the OpenNext adapter | Domain, DNS, R2 and the API proxy are already on Cloudflare; the free tier allows commercial use; a custom domain on a Worker creates its own DNS record and certificate |
| API + queue worker | **Render** (Frankfurt) | NestJS is a long-running Node process with a Prisma connection pool — not a fit for Workers |
| Postgres | **Supabase** | One project per environment |
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

## 2. Web surfaces on Cloudflare Workers — click by click

Each surface has a `wrangler.jsonc` with three named environments
(`development`, `staging`, `production`). Each environment is its own Worker
in the dashboard, connected to one branch. Do **development first**; the other
two are the same steps with a different branch and environment name.

### 2.1 Create the development Worker from the repo

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Import a repository**
2. Connect GitHub if asked, pick `abiodun-fatomi/anystudio`
3. **Project name**: `anystudio-app-development` — this MUST match the
   `env.development.name` in `apps/web/wrangler.jsonc`, or the build fails
   with a name mismatch
4. **Production branch**: `development`
5. **Root directory**: `apps/web`
6. **Build command**: `pnpm run cf:build`
7. **Deploy command**: `pnpm exec wrangler deploy --env development`
8. **Build variables** (this screen, "Variables and secrets", scope *Build*):
   - `API_ORIGIN` = `https://api.dev.anystudio.ai`
   - `NEXT_PUBLIC_ADMIN_ORIGIN` = `https://admin.dev.anystudio.ai`
   - `NODE_VERSION` = `22`
9. **Create and deploy**. The first build takes 3–5 minutes.

The deploy step, because of `custom_domain: true` in `wrangler.jsonc`, creates
the `app.dev.anystudio.ai` DNS record and its certificate. Do not add that
record by hand; if one already exists, delete it first or the deploy errors.

### 2.2 Stop it building other branches

Worker → **Settings** → **Build** → **Branch control** → untick
**Builds for non-production branches** → Save. Otherwise a push to `staging`
also builds this Worker (and fails, harmlessly, at the deploy step).

### 2.3 Check

- `https://app.dev.anystudio.ai/login` shows the sign-in page
- `curl -I https://app.dev.anystudio.ai` → `server: cloudflare`
- Worker → **Logs** shows the request

Sign-in will fail with a network error until the dev API exists (section 4);
that is expected.

### 2.4 Staging and production

Repeat 2.1–2.2 twice, changing only:

| | staging | production |
|---|---|---|
| Project name | `anystudio-app-staging` | `anystudio-app-production` |
| Production branch | `staging` | `production` |
| Deploy command | `… --env staging` | `… --env production` |
| `API_ORIGIN` | `https://api.staging.anystudio.ai` | `https://api.anystudio.ai` |
| `NEXT_PUBLIC_ADMIN_ORIGIN` | `https://admin.staging.anystudio.ai` | `https://admin.anystudio.ai` |

Do production last, and only after `api.staging` answers `/ready`.

### 2.5 Promoting code between environments

Nobody pushes to `development`, `staging` or `production` directly — not
even the owner. A GitHub ruleset (Settings → Rules → Rulesets) requires a
pull request for all three, blocks force-pushes and deletions, and has an
empty bypass list. Every build is therefore the result of a merge, which is
the thing that shows up in history with a reviewer and a green check.

| Change | Branch to open the PR from | Into | Merge method |
|---|---|---|---|
| A feature or fix | `feat/…` or `fix/…` | `development` | Squash |
| Promote to staging | `development` | `staging` | **Merge commit** |
| Promote to production | `staging` | `production` | **Merge commit** |

Promotion PRs must be *merge commits*, never squashes: squashing rewrites the
commits, the environment branches diverge, and the next promotion PR shows
every old change again and conflicts on all of them.

Workers Builds treats a merge as a push to the branch, so the matching
environment Worker builds and deploys the moment the PR is merged.

---

## 3. The API on Render, and its DNS

The API is the one thing that *is* added to DNS by hand, and the one thing
that is proxied (orange cloud): DDoS absorption and the WAF in front of the
origin that holds credentials.

1. Render → **New** → **Blueprint** → this repo → it reads `render.yaml`.
   Fill the secrets it asks for (section 5).
2. Confirm `https://anystudio-api-dev.onrender.com/health` returns `ok` on
   the plain Render hostname **before** touching DNS.
3. Render service → **Settings** → **Custom Domains** → add `api.dev.anystudio.ai`.
4. Cloudflare → **DNS** → **Records** → Add: `CNAME`, name `api.dev`, target
   `anystudio-api-dev.onrender.com`, **grey cloud** for now. Save.
5. Wait until Render shows the certificate as **Issued**.
6. Edit the record → **orange cloud** → Save.
7. Cloudflare → **SSL/TLS** → Overview → **Full (strict)**. Edge Certificates →
   *Always Use HTTPS* on, *Minimum TLS* 1.2. Leave Cloudflare's HSTS off —
   the API sends its own.
8. Cloudflare → **Security** → **WAF** → **Rate limiting rules** → one rule:
   `(http.host eq "api.anystudio.ai" and starts_with(http.request.uri.path, "/auth/"))`,
   10 requests / 10 s per IP, Block 60 s.
9. `curl -I https://api.dev.anystudio.ai/ready` → `ready`, `server: cloudflare`.

Same again for `api.staging` and `api` when those environments exist.

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
| **Render** | API + worker | Import `render.yaml` as a Blueprint. Two environments: dev and production |
| **Supabase** | Postgres | Two projects — never one database with two schemas |
| **Cloudflare R2** | media | One bucket per environment, with a `dev/` prefix on the staging one |
| **Flutterwave / Paddle** | payments | Not needed until Phase 5 |

---

## 5. Secrets, per environment

Set in the Render dashboard and the Worker build settings. Never in the repo.

| Secret | Where | Notes |
|---|---|---|
| `DATABASE_URL` | api, worker | Supabase pooled connection string |
| `APP_KEY` | api, worker | `openssl rand -base64 32`. Encrypts TOTP seeds — **rotating it locks every staff account out of MFA** unless you re-encrypt first |
| `ORIGIN_APP` / `ORIGIN_ORG` / `ORIGIN_ADMIN` | api | Exact origins. The API refuses to start with none set |
| `R2_*` | api, worker | Separate keys per environment |
| `HIGGSFIELD_API_KEY`, `HEYGEN_API_KEY` | api, worker | **Never** in a web Worker — a provider key in a web app's environment is one careless import from the browser bundle |
| `FLUTTERWAVE_*`, `PADDLE_*` | api | Includes webhook signing secrets |
| `WHATSAPP_*` | api | Phone number id, access token, webhook verify token |

GitHub repository secrets, for the deploy workflow:
`RENDER_DEPLOY_HOOK_API_DEV`, `RENDER_DEPLOY_HOOK_WORKER_DEV`,
`RENDER_DEPLOY_HOOK_API_PROD`, `RENDER_DEPLOY_HOOK_WORKER_PROD`.

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
2. Create the Supabase `anystudio-dev` project and copy its connection string
3. Section 3: the dev API on Render, then `api.dev.anystudio.ai`
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
- Rate limiting inside the API is not built; the Cloudflare rule in section 3
  is the only limit on `/auth/*` for now.
- The **staging** branch exists but has no CI or approval gate yet beyond what
  `infra/github-workflows/` defines for development and production.
