# AnyStudio — Product & Technical Specification

**Domain:** anystudio.ai
**Status:** Pre-build specification
**Last updated:** 2026-09-01

---

## 1. What AnyStudio Is

AnyStudio turns a single image — or eventually a video — into everything a person needs to publish it: branded visuals, written copy, short video ads, and the act of posting itself.

It serves three audiences through one engine:

| Audience | What they send | What they get back |
|---|---|---|
| **Individuals** | A personal photo, an event idea | Flyers, posters, styled social posts |
| **Businesses** | A product photo, price, business name | Branded marketplace images, captions, product descriptions, short reel ads |
| **Organizations** | Their merchants' product images, via API | Optimized storefront imagery and unique product descriptions at volume |

The distinguishing bet is **channel**: AnyStudio works inside WhatsApp, not only in a browser dashboard. A seller who lives in WhatsApp never has to leave it.

### The name

Renamed from **StatusCanvas**. "Status" named one channel and one output; "Canvas" sat beside Canva in the same category. "Any" is the promise: anyone, anything, any language, any channel.

Names ruled out during research, with reasons, so they are not revisited:

- **Shopshot** — shopshot.ai is a live AI product-photography competitor
- **MerchPress / Merchcast / Shopbloom** — commerce roots exclude individual users
- **Branda** — BRANDA AI, INC. holds a live Class 35 trademark
- **Emporo** — EMPOROS owns retail-store software in Class 42
- **Everystudio** — @everystudio is an active branding agency
- **MerchMuse / PostMuse / BrandMuse** — all live adjacent products

AnyStudio has no trademark records. `anystudio.ai` and `anystudio.app` are open; `.com` and `.co` are held by dormant registrants. Instagram and TikTok `@anystudio` are held by inactive unrelated accounts — launch as `@anystudio.ai`.

---

## 2. Competitive Position

The reference competitor is **Predis.ai**. Their offering:

- Per-platform ad and video makers for Facebook, Instagram, LinkedIn, Pinterest, TikTok, YouTube
- Carousels, posters, e-commerce creatives, product videos, a Shopify video ad maker
- Scheduler, auto-post, content approval flow
- Brand kits, workspaces, 19+ languages
- Competitor intelligence, ad scoring, ROAS tracking
- Text-to-Video API and Social Media Posts API
- Pricing: $19 / $40 / $212 per month for 1,300 / 3,200 / 10,000 credits

Credit costs: 15 per image, **200 per 8 seconds of standard video**, 5 per 10s faceless video, 15 per carousel slide.

### Three exploitable gaps

**1. Video economics.** At 200 credits per 8 seconds, the $19 plan yields roughly nine videos a month. A seller posting daily exhausts it in a week. Any cost structure that beats this is a direct wedge.

**2. No WhatsApp.** Six platforms, none of them WhatsApp — no Status, no conversational interface. Their product is a web dashboard built around a content calendar; adding a chat-native surface is a rewrite for them, not a feature.

**3. No video translation or dubbing.** Absent from their entire lineup. This is a differentiator rather than catch-up work.

### Where we must match, not beat

Brand kits, scheduling, multi-workspace, approval flows and analytics are table stakes. They are not differentiators, but their absence disqualifies us with agencies and organizations.

---

## 3. Users, Modes and Entitlements

### Account model

A **user** belongs to one or more **workspaces**. Workspace type determines the feature surface:

- `PERSONAL` — individual creative use, no brand kit
- `BUSINESS` — brand kit, product catalog, publishing connections
- `ORGANIZATION` — projects, API keys, seat management, usage billing

One user may hold several workspaces of different types. Mode is a property of the workspace, never a flag on the user — this is what allows the org tier to slot in later without a migration.

### Free tier and abuse control

The first **three generations are free**, then credits or a plan are required.

The free allowance is keyed to a **verified phone number**, not an email address. Email-keyed free tiers are trivially farmed; on WhatsApp the phone number is already the identity, and on web it costs one OTP. Additional signals — device fingerprint, IP velocity, disposable-number ranges — feed a risk score that can require payment earlier for suspicious accounts.

---

## 4. Feature Catalogue

### 4.1 Personal mode

- Upload a personal photo or an existing flyer
- Style, restyle, and enhance
- Flyer and poster generation for events, from a photo or a description
- Free-form customization: text, layout, colour, crop, aspect ratio
- Background removal and replacement
- Export at social-ready sizes
- Direct share to WhatsApp Status, or download

### 4.2 Business mode

**Input:** product image, plus optional price, business name, product category, tone.

**Generated outputs:**

- A set of branded product images, marketplace-ready, carrying business name and price when selected
- Product description — long form, for storefront listings
- Social caption — short form, per platform, with hashtags
- Background removal or replacement, user-selectable per generation
- Short video ad (reel) generated from the still product image
- Multi-size export for storefront, feed, story, and Status

**Brand kit:** logo, colour palette, fonts, tone of voice, watermark preferences. Applied automatically to every generation in the workspace.

**Publishing:** auto-post to Instagram, share to WhatsApp Status with the caption pre-filled, direct share to contacts, or download.

**Library:** every generation stored, searchable, re-editable, re-exportable.

### 4.3 Organization mode

Built for e-commerce platforms serving many merchants.

- **Projects** — a single account holds many projects, each with its own API keys, quota and analytics. One company, many storefronts or environments.
- **API keys** — public key ID plus secret, scoped per project, independently revocable, with separate keys for staging and production.
- **Bulk storefront optimization** — submit merchant product images at volume, receive optimized imagery and unique, non-duplicated descriptions.
- **Usage-based billing** — monthly or yearly commitment metered on API calls, images, and video seconds generated.
- **Org analytics** — usage by project, by merchant, by endpoint; cost attribution; success and failure rates; latency percentiles.
- **Seats and roles** — owner, admin, developer, viewer.
- **Webhooks** — generation completion pushed to the customer's system rather than polled.

### 4.4 Cross-cutting

- Credit balance, credit history, and full transaction ledger visible to the user
- One-time credit purchases as well as subscriptions
- Local-currency pricing by market
- Generation history with re-run and variation
- Interactive analytics: generations over time, credits consumed by type, best-performing posts once publishing data flows back

---

## 5. Architecture

### 5.1 System shape

```
                    ┌──────────────────┐
   Browser ────────▶│  Next.js (web)   │
                    │  Vercel edge     │
                    └────────┬─────────┘
                             │ REST + auth JWT
   WhatsApp ────webhook─────▶│
                    ┌────────▼─────────┐
   Org customer ───▶│  NestJS (api)    │──────▶ PostgreSQL (Supabase)
   via API key      │  auth, billing,  │
                    │  metering, jobs  │──────▶ Redis (BullMQ)
                    └────────┬─────────┘                │
                             │                          │
                    ┌────────▼─────────┐       ┌────────▼─────────┐
                    │  Cloudflare R2   │◀──────│ NestJS (worker)  │
                    │  media + CDN     │       │ generation jobs  │
                    └──────────────────┘       └────────┬─────────┘
                                                        │
                                       ┌────────────────▼────────────────┐
                                       │  Provider abstraction layer     │
                                       │  Higgsfield · fal · Replicate   │
                                       │  HeyGen (dub) · TTS · music     │
                                       └─────────────────────────────────┘
```

### 5.2 Repository layout

```
anystudio/
├── apps/
│   ├── web/          Next.js 15 — marketing, auth, user portal, org portal
│   ├── api/          NestJS — REST, public API, auth, billing, webhooks
│   └── worker/       NestJS standalone — BullMQ consumers
├── packages/
│   ├── shared/       DTOs, zod schemas, credit cost tables
│   └── db/           Prisma schema + migrations
└── infra/            IaC, deployment config
```

Turborepo with pnpm workspaces. A single Prisma schema means the credit ledger has exactly one source of truth.

### 5.3 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js 15, React 19, TypeScript | Already in use; App Router, server components |
| Styling | Tailwind v4 + shadcn/ui | Owned components rather than a dependency to fight |
| Animation | Motion (formerly Framer Motion) | Hybrid engine runs transform/opacity on the compositor |
| Backend | NestJS (TypeScript) | Chosen for shipping speed; DI, guards and interceptors suit API-key auth and metering |
| ORM | Prisma | Type-safe, shared schema, good migration story |
| Database | PostgreSQL via Supabase | Auth, Postgres and RLS already wired |
| Queue | Redis + BullMQ | Every generation is a job; nothing slow inside a request |
| Storage | Cloudflare R2 + CDN | Zero egress fees — decisive when serving media into Nigeria |
| AI providers | Own abstraction layer | Higgsfield, fal.ai, Replicate, HeyGen behind one interface |
| Payments | Flutterwave (NGN) + Paddle (international) | Paddle is merchant-of-record and handles global VAT |
| Analytics | PostHog now, ClickHouse later | Postgres aggregates suffice until real volume |
| Hosting | Vercel (web) + Fly.io or Railway (api, worker) | Fly has regions close to target markets |

**Why NestJS over FastAPI.** This workload is I/O-bound: the API accepts an upload, writes a row, enqueues a job and returns; the worker waits 8–40 seconds on someone else's GPU. Language execution speed is not the constraint. Ecosystem and developer velocity are, and the deciding factor is fluency.

---

## 6. Core Data Model

Abbreviated to the tables that carry the invariants.

```
users               id, phone, phone_verified_at, email, created_at
workspaces          id, type(PERSONAL|BUSINESS|ORGANIZATION), name, owner_id
workspace_members   workspace_id, user_id, role
brand_kits          workspace_id, logo_url, palette, fonts, tone, watermark

wallets             workspace_id, currency
ledger_entries      id, wallet_id, delta, kind(PURCHASE|DEBIT|REFUND|PROMO|
                        EXPIRY|ADJUSTMENT), job_id, idempotency_key,
                        balance_after, created_at, reason

products            workspace_id, name, price, currency, category, source_image
generation_jobs     id, workspace_id, type, status, provider, model,
                        credit_cost, idempotency_key, input, error, timings
generated_assets    job_id, kind(IMAGE|VIDEO|TEXT), r2_key, width, height,
                        duration_ms, variant_of

projects            org_workspace_id, name, environment
api_keys            project_id, key_id, secret_hash, scopes, revoked_at,
                        last_used_at, rate_limit
usage_records       api_key_id, endpoint, units, unit_type, cost, created_at

payments            workspace_id, provider, provider_ref, amount, currency,
                        status, receipt
plans               code, price_by_market, credits, features
publish_connections workspace_id, platform, external_account_id, tokens
publish_jobs        asset_id, platform, status, external_post_id
```

### 6.1 The credit ledger

**The ledger is append-only. There is no balance column.**

Every purchase, debit, refund, promotional grant and adjustment is a row. The balance is derived, with `balance_after` denormalized onto each row for cheap reads and for detecting drift.

This is the single most common thing teams get wrong, and it cannot be fixed retroactively — you cannot reconstruct a history you never wrote. When a user disputes a charge, or a generation fails halfway, or an organization queries its spend for a month, the ledger is the only defensible answer.

Debits and refunds go through a Postgres function that locks the wallet row and appends the entry in one transaction. Never through application code holding two statements.

### 6.2 Idempotency

Every generation carries an `idempotency_key` supplied by the client. A double-tapped button, a retried webhook, or a network hiccup must never spend credits twice. The key is unique per wallet and short-circuits to the existing job.

---

## 7. Generation Lifecycle

```
1. Client uploads source image directly to R2 via a short-lived signed URL
2. Client POSTs a generation request with an idempotency key
3. API validates input, resolves credit cost from config, and RESERVES credits
   (ledger DEBIT, status pending) inside a locking transaction
4. API creates generation_job (status=QUEUED) and enqueues to BullMQ
5. API returns immediately with job id — never blocks
6. Worker picks up job, resolves provider + model from config
7. Worker calls provider through the abstraction layer, with timeout
8. On success: assets written to R2, job COMPLETED, credit reservation COMMITTED
   On terminal failure: job FAILED, ledger REFUND appended, reason recorded
9. Client is notified by SSE/WebSocket (web) or message (WhatsApp);
   org customers receive a webhook
```

Bounded retries with exponential backoff. A dead-letter queue for jobs that exhaust retries. Refund exactly once, through the ledger, and only for eligible terminal failures — never for policy rejections caused by the user's own input.

---

## 8. Provider Abstraction

Never call a provider directly from business logic.

```ts
interface GenerationProvider {
  id: string
  supports(capability: Capability): boolean
  generate(input: GenerationInput, opts: ProviderOpts): Promise<ProviderResult>
  estimateCost(input: GenerationInput): CostEstimate
}
```

Provider, model and credit cost live in **config rows, not code**. New models appear roughly monthly and are frequently cheaper; switching should be a database change and a canary, not a deploy.

Capabilities to model from the start: `IMAGE_GENERATE`, `IMAGE_EDIT`, `BACKGROUND_REMOVE`, `BACKGROUND_REPLACE`, `UPSCALE`, `IMAGE_TO_VIDEO`, `TEXT_GENERATE`, and — reserved for later — `VOICEOVER`, `MUSIC`, `DUB`.

Reserving the later capabilities in the interface now is what makes voiceover and music generation additive rather than a refactor.

Failover order per capability, with per-provider health tracking and automatic demotion on elevated error rates.

---

## 9. Payments, Pricing and Credits

### Model

- **Subscriptions** — monthly or yearly, granting a recurring credit allowance
- **One-time credit purchases** — top-ups that do not expire on the same schedule as plan credits
- **Organization billing** — committed monthly or yearly, metered on API calls, images and video seconds

Plan credits and purchased credits are distinguishable in the ledger, and plan credits are consumed first.

### Local currency

**Do not convert with live FX rates.** Fixed price tiers per market, stored in `plans.price_by_market`, refreshed on a deliberate schedule.

Live conversion produces ugly prices, margin swings on every rate move, and a different price on each visit. Fixed local tiers are what every mature SaaS does, and they let you price for purchasing power rather than for arithmetic.

### Payment integrity

- Price and credit amounts derive from server-side config; client-supplied amounts are ignored entirely
- Webhook signature validated, then transaction independently verified with the provider — ID, amount, currency, status, reference
- Webhook receipt stored; credits granted through the ledger function with a stable idempotency key
- Duplicate, delayed, reordered, forged and refunded webhook cases tested before launch
- No raw card data ever touches our systems; hosted checkout only

---

## 10. The Organization API Platform

### Keys

An API key is a **public key ID** plus a **secret**. Only an Argon2 hash of the secret is stored. The secret is displayed exactly once at creation.

Keys are scoped to a project, carry their own rate limit and scopes, and are independently revocable. Separate keys per environment. `last_used_at` tracked so dormant keys can be surfaced and retired.

### Metering

Every authenticated API call writes a `usage_record` with endpoint, units and unit type. Aggregation runs on a schedule into per-project, per-day rollups that back both the customer's analytics and the invoice. The raw records are the audit trail when a customer disputes a bill.

### Public API surface (v1)

```
POST   /v1/generations              create a generation
GET    /v1/generations/:id          poll status
GET    /v1/generations              list, filter
POST   /v1/products                 register a product for reuse
GET    /v1/usage                    current period usage
POST   /v1/webhooks                 register a completion webhook
```

Versioned from the first release. OpenAPI spec generated from the NestJS decorators and published.

---

## 10a. How an Organization Signs Up

`design/org.html`. The Organization tier serves two buyers who behave in opposite
ways, and the flow is built around that split rather than around one funnel.

| | Platform | Agency / multi-brand |
|---|---|---|
| Who evaluates | Engineer or PM | Ops or marketing lead |
| Wants first | A key and a call that returns an image | A workspace and a project |
| Reaction to "Book a demo" first | Leaves | Fine with it |
| Decides on | Cost per listing, integration time | Seats, brand kits, one invoice |

A single call-to-action loses one of them. The page now offers both doors on the
same tier: **Create an organization** (self-serve) and **Talk to us about volume**.
The API section, which previously had no call to action at all, gets
**Get a test key**.

### The rules the flow follows

1. **The sandbox is never gated.** A test key with 500 credits is issued at step 2,
   before any conversation and without a card. Sales conversations are about
   volume, contracts and support — never about access.
2. **The organization is created before the humans.** Workspace type is
   `ORGANIZATION` from the first insert; there is no personal account that later
   "becomes" an org. That migration is where competitors' data models break.
3. **Progressive commitment.** Test keys ask for nothing. Live keys need business
   verification. Invoicing needs a contract. Each step asks only what it needs.
4. **Qualification hides in the form.** The contact door asks six fields —
   organization, work email, role, monthly volume, timeline, blockers — because
   those six decide what can be offered. Not fifteen.
5. **Region is asked once and early.** It sets billing currency *and* image
   storage region, and changing it later needs support, so the field says so.
6. **Personal email domains are rejected** at the org step: the domain is what
   colleagues later join on.

### The steps

`#start` fork → `#details` (5 fields) → `#verify` (test key + working curl, or
first project) → `#prove` (run it on one of *their* listings, on test credits) →
`#team` (invites, domain joining, roles) — plus `#contact` as the other door.

Step 3 is the one most competitors skip. A demo on AnyStudio's own bottle proves
nothing about a buyer's catalogue; the flow asks for a product URL from their
storefront and returns the branded set for their merchandise before they have
paid anything.

The left column is not decoration — it is the organization being built. Name,
region, billing currency, scale, key status and seat count fill in as the buyer
answers, so the value of an organization is visible before the flow ends.

### Roles

Five, which is the ceiling before people stop understanding them.

| Role | Can | Cannot |
|---|---|---|
| **Owner** | Billing, contracts, delete the org | — (exactly one, transferable) |
| **Admin** | Projects, API keys, members, brand kits | Billing, deletion |
| **Member** | Generate in projects they belong to | See other projects |
| **Billing** | Invoices, credit history, usage | Generate anything |
| **Auditor** | Usage and the audit log | Change anything |

### Not yet built

- Business verification (registration number, billing entity) before live keys.
- SSO and SCIM, which is the top-tier lock; verified-domain auto-join is the
  mid-tier version and is in the flow already.
- The trust page — DPA, sub-processors, retention, data residency. Enterprise
  deals stall here silently for weeks, and `#contact` currently links to a page
  that does not exist yet.
- Real submission endpoints: every form in `org.html` is presentational.

## 11. Publishing Integrations

| Channel | Mechanism | Approval needed |
|---|---|---|
| WhatsApp (bot + Status share) | WhatsApp Cloud API | Meta Business verification |
| Instagram (auto-post) | Instagram Graph API | Facebook app review |
| TikTok | TikTok Content Posting API | TikTok app review |
| Download / direct share | Native | None |

Publish attempts are jobs with their own retry and failure surface, separate from generation. Token refresh handled ahead of expiry; a disconnected account surfaces in the UI rather than failing silently.

---

## 12. Security Invariants

1. Never trust a client-supplied price, credit amount, balance, user ID, role or storage path
2. Grant credits only after signature validation and independent provider verification
3. Payment webhooks and generation submissions are idempotent
4. Debits and refunds occur only through database functions that lock the wallet row and append a ledger entry in one transaction
5. No raw card data; hosted checkout only
6. Media private by default; validate declared MIME *and* file signature; cap size, dimensions and duration; rename on upload; scan before processing
7. Authorization enforced in Postgres row-level security and again at sensitive server entry points
8. API secrets stored as Argon2 hashes; shown once; revocable
9. MFA required for platform administrators; every privileged action logged
10. Tokens, passwords, API keys, payment payloads and private media URLs redacted from logs
11. Rate limit authentication, uploads, checkout creation and generation by user, key and IP risk

---

## 12a. Discovery, Metadata and Web Security

Everything in this section lives in `design/seo/` and moves into the Next.js app
at Phase 2. It is listed separately from the product security invariants in §12
because it protects the *browser*, not the ledger.

### What ships in the document head

| Concern | Landing | Auth screens |
|---|---|---|
| `robots` | `index, follow, max-image-preview:large, max-snippet:-1` | `noindex, nofollow, noarchive, nosnippet` |
| Canonical | `https://anystudio.ai/` | `https://anystudio.ai/signin` |
| Open Graph + Twitter | Full card, 1200×630 image | Card only, no indexing |
| `referrer` | `strict-origin-when-cross-origin` | `no-referrer` — a reset token travels in the URL |
| Theme colour | Light and dark, media-scoped | Same |
| Structured data | Organization, WebSite, WebPage, SoftwareApplication, FAQPage, HowTo | None |

An indexed sign-in page is a standing phishing target: a copy of it ranking
beside the real one is how credentials get harvested. That is the reason for
`noindex` on the auth screens, not a ranking judgement.

### Structured data

One `@graph` block on the landing page. `SoftwareApplication` carries an
`AggregateOffer` with all four tiers, and `FAQPage` mirrors the five questions
in the page's own FAQ. **These numbers must be changed in two places** — the
pricing table and the JSON-LD. A mismatch between markup and visible price is
treated by Google as deceptive markup and costs the rich result entirely.

### Answer engines

`robots.txt` allows the retrieval crawlers (`OAI-SearchBot`, `ChatGPT-User`,
`Claude-SearchBot`, `Claude-User`, `PerplexityBot`) and the training crawlers
(`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`, `CCBot`)
deliberately. A merchant asking an assistant "how do I make my product photos
look professional" is a real acquisition path, and a blocked crawler cannot cite
you. SEO tool crawlers with no traffic to send back (`SemrushBot`, `AhrefsBot`,
`MJ12bot`, `DotBot`) are disallowed.

`llms.txt` states the pricing, the WhatsApp number and the four facts most often
got wrong — assistants quote it verbatim, so it is worth keeping accurate.

### Headers

`design/seo/next-headers.mjs` is the source of truth; `_headers` is the same
policy for a static host. A `<meta http-equiv>` tag cannot substitute — browsers
honour CSP, HSTS, COOP, CORP and `X-Content-Type-Options` only as real response
headers.

- **CSP** — `frame-ancestors 'none'` (clickjacking), `form-action 'self'` (a
  stolen form cannot post elsewhere), `object-src 'none'`, and an explicit
  allowlist per directive. `'strict-dynamic'` with a per-request nonce from
  Next.js middleware is the target; the dev-only `'unsafe-inline'` must never
  reach production.
- **HSTS** — two years, `includeSubDomains`, `preload`. Keep `preload` only if
  every subdomain will be HTTPS permanently; removal takes months.
- **Permissions-Policy** — camera, microphone, geolocation and USB denied
  outright, so a compromised third-party script cannot even prompt.
- **Auth routes** — `no-store`, `no-referrer`, `X-Robots-Tag: noindex`.

`/.well-known/security.txt` (RFC 9116) gives a researcher somewhere to report to.
Its `Expires` field must be renewed; an expired file counts as absent.

### Files

```
design/seo/
├── robots.txt            crawler policy, AI crawlers named explicitly
├── sitemap.xml           only live URLs — a 404 in here costs crawl budget
├── llms.txt              the summary answer engines quote
├── site.webmanifest      installable PWA metadata
├── favicon.svg           brand mark
├── icon-192.png  icon-512.png  apple-touch-icon.png
├── og-image.png          1200×630 link preview
├── next-headers.mjs      security headers for next.config.mjs
├── _headers              the same policy for Cloudflare Pages / Netlify
└── .well-known/security.txt
```

### Still outstanding

- `<html lang="en">` belongs in `app/layout.tsx`. The design files set it from
  JavaScript because the artifact wrapper owns the `<html>` element there.
- Google Search Console and Bing Webmaster verification tokens.
- A `/privacy` and `/terms` page — both are linked from the footer and both
  currently point at `#top`.
- Per-market `hreflang` once NGN and GBP pricing pages diverge.

## 13. Analytics

**For users:** generations over time, credits consumed by type, remaining balance and projected runway, library growth, and — once publishing data returns — engagement per published asset.

**For organizations:** usage by project, endpoint and merchant; cost attribution; success and failure rates; latency percentiles; quota burn-down.

**For the operator:** activation and retention funnels, generation volume and failure rate, provider cost and latency, revenue, MRR, credit liability, refund rate, fraud signals, queue depth, webhook lag.

Credit liability — unspent purchased credits — is a real balance-sheet item and should be visible from the first month.

---

## 14. Release Sequence

The full scope is three products. This order ships something usable early and defers the piece most likely to be rebuilt.

### Phase 1 — Foundation
Auth and phone verification · workspaces and membership · credit ledger and wallet functions · Flutterwave and Paddle integration · plans and local price tiers · free-tier gating · landing page, sign-up and sign-in

*Exit criteria: a user can sign up, buy credits, and see an accurate balance and history.*

### Phase 2 — Image pipeline
Upload to R2 · provider abstraction · branded product images · captions and product descriptions · background removal and replacement · brand kits · multi-size export

*Exit criteria: a seller uploads a product photo and receives post-ready branded images with copy.*

### Phase 3 — Video pipeline
Image-to-video reels · duration and aspect controls · video-specific credit costing · longer job handling and progress reporting

*Exit criteria: the same product photo yields a short reel ad.*

### Phase 4 — User portal
Library with search and re-edit · downloads · credit history and transactions · usage analytics · account and billing management

*Exit criteria: a paying user has everything they need without contacting support.*

### Phase 5 — WhatsApp channel
Cloud API webhook · conversational flows for personal and business modes · Status sharing with pre-filled caption · phone-first onboarding

*Blocked on Meta Business verification.*

### Phase 6 — Social publishing
Instagram auto-post · TikTok posting · scheduling and calendar · publish job retry and reconnection

*Blocked on Facebook app review and TikTok review.*

### Phase 7 — Organization portal
Projects · API keys and secrets · public API v1 · usage metering and rollups · usage-based billing · org analytics · seats and roles · webhooks

*Deliberately last. Build it with a design partner in the room, not from assumption.*

---

## 15. Future Releases

- **Voiceover** — TTS over generated video, multi-language, brand voice
- **Music generation** — licensed or generated backing tracks per mood
- **Video translation and dubbing** — upload a video, receive it in another language with preserved voice and lip sync. Absent from every competitor examined.
- **Video-to-video** — restyle, reframe and clip existing footage
- **Content calendar and campaign planning**
- **Competitor intelligence** — matching Predis rather than differentiating
- **Performance feedback loop** — pull engagement back from connected accounts and rank which generated variants actually performed
- **White-label** — organizations serving the experience under their own brand
- **Team approval flows** — required by agencies
- **Marketplace connectors** — Shopify, WooCommerce, Jumia and similar, so product catalogues sync automatically

Voiceover, music and dubbing are already reserved as capabilities in the provider interface, so they arrive as new providers rather than as a refactor.

---

## 16. Critical Path Outside the Code

These gate launch and take weeks. Start them before writing application code.

1. **Meta Business verification** — required for WhatsApp Cloud API (Phase 5)
2. **Facebook app review** — required for Instagram Graph API posting (Phase 6)
3. **TikTok app review** — required for TikTok posting (Phase 6)
4. **Domain purchase** — anystudio.ai, plus anystudio.app; register in a two-year term
5. **Social handles** — @anystudio.ai on Instagram and TikTok
6. **Trademark filing** — AnyStudio is clear on the US register; also clear Nigeria and EUIPO before filing
7. **Flutterwave production account** and Paddle seller account
8. **Provider commercial terms** — confirm that Higgsfield, fal or Replicate permit reselling generations to end users. This is an architectural dependency, not a formality.

---

## 17. Open Decisions

- Which provider becomes primary for image editing versus image-to-video, on cost per output rather than on demo quality
- Whether Supabase remains the auth issuer once the NestJS API owns business logic, or whether auth moves in-house
- Credit expiry policy for plan credits versus purchased credits
- Whether personal mode is free-forever with a watermark, or credit-metered like business mode
- Refund policy for generations a user judges poor but which completed successfully
- Which markets get their own fixed price tier at launch

---

## Appendix — Decisions Already Made

| Decision | Choice | Reason |
|---|---|---|
| Product name | AnyStudio | Only shape covering individuals, businesses and organizations |
| Domain | anystudio.ai | .com held since 2005 and renewed to 2028; not obtainable |
| Backend language | TypeScript / NestJS | Shipping speed beats ecosystem; workload is I/O-bound |
| Balance storage | Append-only ledger | Cannot be retrofitted |
| Provider coupling | Abstraction from line one | Models change monthly |
| Workspace modes | Type on workspace, not flag on user | Lets the org tier slot in without migration |
| Local pricing | Fixed per-market tiers | Live FX causes ugly prices and margin swings |
| Free tier key | Verified phone number | Email-keyed free tiers are farmed |
| Build order | Org portal last | API primitives guessed without a customer get rebuilt |
