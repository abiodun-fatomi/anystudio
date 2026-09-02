# AnyStudio

One product photo in. Branded images, a written description, captions and a
short reel out — on WhatsApp, with no app to install, and on the web.

> **Status: pre-alpha.** The design prototypes are complete and the backend
> foundation is in place. Nothing here has been deployed and the API does not
> yet serve a request.

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

`pnpm infra:up` leaves you with a working account: `dev@anystudio.test`, which is
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
in `apps/api/src/common/policy/policy.ts` refuses it; a colleague does it instead.

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
| `design/landing.html` | Marketing page prototype |
| `design/auth.html` | Sign in, sign up, forgot and reset password |
| `design/org.html` | Organization signup, both branches, and the sales door |

---

## Still to build

The foundation is here; most of the product is not.

- The auth **service** behind the controller — password verification with uniform
  timing, TOTP, and the guards that assemble the actor
- The logger with redaction, and the rate-limit guards
- The credit ledger's Postgres functions — wallet-row locking, idempotency
- Generation pipeline, provider abstraction, publishing integrations
- The four Next.js apps behind the prototypes

`.github/workflows/ci.yml` is intentionally absent from the initial commit and
must be added by hand.

---

© Fatomi. All rights reserved. Not currently open source.
