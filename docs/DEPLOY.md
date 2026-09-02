# Deploying AnyStudio

`anystudio.ai` is registered and its nameservers already point at Cloudflare
(`heather.ns.cloudflare.com`, `josh.ns.cloudflare.com`). No records exist yet.

---

## 1. DNS — every record, in one place

Add these in **Cloudflare → anystudio.ai → DNS**. `CF` = proxied (orange cloud),
`DNS` = DNS-only (grey cloud).

| Type | Name | Value | Proxy | What it is |
|---|---|---|---|---|
| CNAME | `@` | `cname.vercel-dns.com` | DNS | Marketing site |
| CNAME | `www` | `cname.vercel-dns.com` | DNS | Redirects to apex |
| CNAME | `app` | `cname.vercel-dns.com` | DNS | User portal |
| CNAME | `org` | `cname.vercel-dns.com` | DNS | Organization portal |
| CNAME | `admin` | `cname.vercel-dns.com` | DNS | Staff console |
| CNAME | `api` | `anystudio-api.onrender.com` | **CF** | Public + app API |
| CNAME | `cdn` | *(R2 public bucket hostname)* | **CF** | Generated media |
| CNAME | `dev` | `cname.vercel-dns.com` | DNS | Staging marketing |
| CNAME | `app.dev` | `cname.vercel-dns.com` | DNS | Staging user portal |
| CNAME | `org.dev` | `cname.vercel-dns.com` | DNS | Staging org portal |
| CNAME | `admin.dev` | `cname.vercel-dns.com` | DNS | Staging admin |
| CNAME | `api.dev` | `anystudio-api-dev.onrender.com` | **CF** | Staging API |

**Vercel records must be DNS-only.** Vercel issues and renews its own
certificates; proxying through Cloudflare breaks that validation and you get
intermittent TLS errors that are miserable to diagnose.

**The API is proxied.** That is where Cloudflare earns its place: DDoS
absorption and a WAF in front of the one origin that holds credentials.

### Why staging nests under `dev.anystudio.ai`

Name it `app-dev.anystudio.ai` and every host is a sibling under
`anystudio.ai` — so any cookie ever set on the parent domain is readable by
both environments. One careless `domain=.anystudio.ai` and a staging bug can
read production sessions. Under `*.dev.anystudio.ai` the two trees cannot see
each other's cookies, and one wildcard certificate still covers staging.

### Email, once there is any

| Type | Name | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:<provider> -all` |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@anystudio.ai` |
| CNAME | *(provider DKIM records)* | |

`-all` not `~all`. A soft fail invites spoofing of a domain that sends password
resets.

---

## 2. Accounts to create

Only the account owner can do these; none can be automated from here.

| Service | For | Notes |
|---|---|---|
| **Vercel** | the four web surfaces | One project per surface, all from this repo, different root directories |
| **Render** | API + worker | Import `render.yaml` as a Blueprint. Two environments: dev and production |
| **Supabase** | Postgres | Two projects — never one database with two schemas |
| **Cloudflare R2** | media | One bucket per environment, with a `dev/` prefix on the staging one |
| **Flutterwave / Paddle** | payments | Not needed until Phase 5 |

---

## 3. Secrets, per environment

Set in the Render dashboard and Vercel project settings. Never in the repo.

| Secret | Where | Notes |
|---|---|---|
| `DATABASE_URL` | api, worker | Supabase pooled connection string |
| `APP_KEY` | api, worker | `openssl rand -base64 32`. Encrypts TOTP seeds — **rotating it locks every staff account out of MFA** unless you re-encrypt first |
| `ORIGIN_APP` / `ORIGIN_ORG` / `ORIGIN_ADMIN` | api | Exact origins. The API refuses to start with none set |
| `R2_*` | api, worker | Separate keys per environment |
| `HIGGSFIELD_API_KEY`, `HEYGEN_API_KEY` | api, worker | **Never** in a Vercel project — a provider key in a web app's environment is one careless import from the browser bundle |
| `FLUTTERWAVE_*`, `PADDLE_*` | api | Includes webhook signing secrets |
| `WHATSAPP_*` | api | Phone number id, access token, webhook verify token |

GitHub repository secrets, for the deploy workflow:
`RENDER_DEPLOY_HOOK_API_DEV`, `RENDER_DEPLOY_HOOK_WORKER_DEV`,
`RENDER_DEPLOY_HOOK_API_PROD`, `RENDER_DEPLOY_HOOK_WORKER_PROD`.

---

## 4. Branches and environments

| Branch | Environment | Deploys |
|---|---|---|
| `development` | `*.dev.anystudio.ai` | automatically, after CI passes |
| `production` | `anystudio.ai` | after CI passes **and** a human approves |

The approval gate is a **required reviewer on the `production` GitHub
environment**. Set it in Settings → Environments, or production deploys are
automatic and the branch protection is decorative.

---

## 5. Order of operations

1. Create the Supabase projects and copy both connection strings
2. Render → New Blueprint → this repo → `render.yaml`, set env vars, deploy dev
3. Confirm `https://anystudio-api-dev.onrender.com/health` returns `ok`
4. Add the DNS records above
5. Add the custom domains in Vercel and Render, wait for certificates
6. Confirm `https://api.dev.anystudio.ai/ready` returns `ready`
7. Only then point `production` at anything

**Do not skip step 3.** A failing health check behind a proxy and a fresh
certificate is three problems at once; behind a plain hostname it is one.

---

## 6. What is not ready

- The web apps do not exist yet — only prototypes in `design/`. There is
  nothing for Vercel to build.
- The API boots and serves `/health` and `/ready`. `/auth/*` references an
  `AuthService` that is not written, so those routes will not compile until it is.
- No `prisma/migrations/` directory yet. Run `pnpm db:migrate` locally once to
  generate the first migration, then commit it — `db:deploy` applies committed
  migrations and does nothing without them.

Deploying today gets you a working health endpoint on a real domain. That is
worth doing — it proves the whole chain — but it is not the product.
