# AnyStudio

One product photo in. Branded images, a written description, captions and a
short reel out — on WhatsApp, with no app to install, and on the web.

> **Status: pre-alpha.** The design prototypes are complete, the API boots and
> serves auth (password and Google), registration with a verification email,
> password reset, onboarding and the credit ledger, and the user portal has
> sign-in, sign-up, welcome and Today screens. The web portal deploys to
> Cloudflare Workers and the API to Render, both from GitHub Actions —
> see `docs/DEPLOY.md`.

---

## What is in this repository

```
apps/
  api/        NestJS — REST, the public org API, auth, billing, webhooks
  worker/     NestJS standalone — BullMQ consumers, where generations run
  web/        Next.js 15 — marketing, user portal, org portal, admin portal
packages/
  db/         Prisma schema, migrations, seeds
  shared/     Types, tour definitions and the credit costs both sides import
design/       Static HTML prototypes of the landing, auth and org flows
docs/         The product and architecture spec, and the portal blueprint
```

### Inside `apps/api`

```
config/                     Cross-cutting setup, imported by main.ts and app.module.ts
  database/                 PrismaModule — one client, connected once
  globals/                  GlobalExceptionFilter, response envelope, request id, error classes, shared interfaces
  logger/                   pino, with redaction
  rate-limit/               The limits table, per route
  security/                 helmet, compression, cookies, CORS, body limit
  swagger/                  /api/v1/docs, off in production
src/
  main.ts                   Bootstrap: /api prefix, URI versioning, validation pipe
  app.module.ts             Wires modules and the global guard, filter and interceptor
  modules/<name>/           One folder per feature
    <name>.controller.ts    Routes only: decorators, DTOs in, service call out
    <name>.service.ts       All of the logic
    <name>.dto.ts           class-validator + Swagger, the request contract
    <name>.types.ts         What the service returns
    <name>.module.ts
    guards/ decorators/ providers/   where a module has them (auth does)
  utils/                    helpers (successResponse), enums, constants, crypto, mail-service
  assets/email-templates/   One file per email
```

**Controllers are thin, services are fat.** A controller declares the route,
validates the body through its DTO and calls exactly one service method; every
decision lives in the service, where a test can reach it without HTTP.

**Every response has the same shape.** `{ status, message, data }` on success;
`{ status, message, error, data: null, fields?, requestId }` on failure. The
web client (`apps/web/lib/api.ts`) unwraps `data` and throws on the rest.

**Routes are versioned in the path**: `/api/v1/auth/login`. Only `/health`
and `/ready` sit outside it, because a platform healthcheck must find them
without knowing our conventions.

**Why a monorepo.** The credit cost the interface quotes and the credit cost the
API charges must be the same number. Splitting the backend into its own
repository means two copies of that table and, eventually, a customer charged
120 credits for something the screen said cost 10.

---

## Running it locally

Requires Node 22, pnpm 9 and Docker.

```bash
cp .env.example .env      # then fill APP_KEY: openssl rand -base64 32
pnpm install
pnpm infra:up             # Postgres, Redis, MinIO, Mailpit — then migrate + seed
pnpm dev
```

`pnpm infra:up` leaves you with a working account: `dev@anystudio.test` (password
`anystudio-dev`, 1000 credits), which is
**both** the owner of a demo workspace **and** a superadmin. That combination is
deliberate — it is the case the authorization rules have to get right, and
testing the two roles separately hides the interesting bug.

| Service | Where |
|---|---|
| User portal | http://localhost:3000 |
| API | http://localhost:3001 |
| Org portal | http://localhost:3002 |
| Admin portal | http://localhost:3003 |
| Mail (Mailpit) | http://localhost:8025 |
| Object storage (MinIO) | http://localhost:9001 |

---

## The decisions worth knowing before you read the code

**One identity, three sessions.** The same email, phone and password work on all
three portals. A *session*, however, is minted for exactly one surface and is
rejected outright on the others. Shared credentials are a convenience; a shared
session would mean one XSS on the customer app is a full staff compromise.
See `packages/db/prisma/schema.prisma` and `apps/api/src/modules/auth`.

**Staff cannot action their own workspace.** Because one person can be both a
customer and staff, an operator could otherwise refund credits to themselves and
it would look like ordinary authorised work in the audit log. `assertNoSelfDealing`
in `apps/api/src/modules/auth/policy.ts` refuses it; a colleague does it instead.

**The ledger is append-only and has no balance column.** Every purchase, debit,
refund and adjustment is a row; the balance is derived. You cannot reconstruct a
history you never wrote, and this is the one mistake that cannot be fixed later.

**Migrations never run in a start command.** They are a one-shot release job.
Two replicas booting together would both run `migrate deploy` against the same
database, which is how a schema ends up half-applied.

**Reference data lives in the database, not in constants.** Plans, credit costs
and provider routing are rows, so a provider outage is a toggle in the admin
console rather than a deploy.

---

## Documentation

| Document | What it covers |
|---|---|
| `docs/ANYSTUDIO.md` | Product spec, architecture, data model, release sequence |
| `docs/PORTALS.html` | The three portals — flows, feature maps, logging, rate limits, security |
| `design/landing.html` | Marketing prototype. `scripts/sync-prototypes.mjs` splits it into `/`, `/pricing` and `/developers` |
| `design/auth.html` | Sign in, sign up, forgot and reset password |
| `design/org.html` | Organization signup, both branches, and the sales door |

---

## Still to build

The foundation is here; most of the product is not.

- Rate-limit guards (Redis token buckets per surface, key and merchant)
- WhatsApp OTP; WebAuthn passkeys
- Generation pipeline, provider abstraction, publishing integrations
- The org and admin portals, and everything in the user portal past Today

**Done:** auth (sessions, MFA, step-up, refresh rotation, Sign in with
Google), registration with consent capture and email verification, password
reset, transactional mail (Resend), onboarding tours, the append-only ledger and
its Postgres functions, redacting logger, CORS/helmet, and the user-portal
shell with sign-in, sign-up, forgot/reset, welcome and Today.

Workflows that cannot be pushed by an integration token are staged in
`infra/github-workflows/` with instructions for moving them.

---

© Fatomi. All rights reserved. Not currently open source.
