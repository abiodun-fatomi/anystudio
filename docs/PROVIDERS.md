# Providers, keys and environment

What each AI vendor does for the product, where its key comes from, what it
costs, and what has to be true before it serves a paying customer. The
routing itself is `ProviderModel` rows (seeded in `packages/db/prisma/seed.ts`);
this file is the reasoning behind those rows.

Prices are from the vendors' September 2026 price lists. They move monthly.

## The rule

A `ProviderModel` row is enabled for customer traffic only when its
`licenceNote` records that reselling the output to our customers is permitted
under the plan we are on, with a date. No note, no traffic. Dev environments
route to the stub adapter without any key at all.

## Keys to obtain

| Env var | Vendor | Where to get it | Used for | Unit cost |
|---|---|---|---|---|
| `FAL_KEY` | fal.ai | fal.ai → Dashboard → Keys | Seedream 4.5 edit, Flux 2 Pro, Bria RMBG 2.0, Clarity upscaler, Wan 2.5 image-to-video | $0.04 edit · $0.018 rmbg · $0.03/MP upscale · $0.05–0.15/s video |
| `GOOGLE_AI_API_KEY` | Google AI Studio | aistudio.google.com → Get API key (enable billing for paid tier) | Gemini 3 Pro Image (edit/generate/replace/relight), Gemini 2.5 Flash-Lite (copy), Veo 3.1 Fast (video) | ~$0.13/image · $0.10/$0.40 per 1M tokens · $0.25–0.40/s video |
| `GOOGLE_VERTEX_SA_JSON` + `GOOGLE_VERTEX_PROJECT` + `GOOGLE_VERTEX_LOCATION` | Google Cloud Vertex AI | GCP console → IAM → Service account with `Vertex AI User`; download JSON; paste as one line | Same models through the door with **generative-AI indemnification** on GA versions. Switch to this before selling to an ORGANIZATION customer. | same |
| `REPLICATE_API_TOKEN` | Replicate | replicate.com → Account → API tokens | BiRefNet background removal | ~$0.0005/image |
| `PHOTOROOM_API_KEY` | Photoroom | photoroom.com/api → sign up; ask about the startup programme (up to 90% off) | Background replacement with generated scenes, AI shadows, relighting | $0.10/image (Plus tier), $0.02 remove-only |
| `OPENAI_API_KEY` | OpenAI | platform.openai.com → API keys (org must have Sora access) | Sora 2 image-to-video | $0.10/s at 720p |
| `ANTHROPIC_API_KEY` | Anthropic | console.anthropic.com → API keys | Claude Haiku 4.5 for brand-voice copy | $1/$5 per 1M tokens |
| `BFL_API_KEY` | Black Forest Labs | api.bfl.ai → sign up | Flux Kontext Pro — budget edit tier | $0.04/image |
| `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET` | Higgsfield | platform.higgsfield.ai → API keys | Their own DoP image-to-video models (`higgsfield:dop-turbo`, row disabled until resale terms are on file). The Kling row through them stays disabled: Kling's ToS §4.6 forbids commercial use without written permission and §4.5 requires attribution. | ~$0.60/clip (verify) |
| `HEYGEN_API_KEY` | HeyGen | already held | Dubbing and avatars (Phase 11) | per-minute; not public, sales call |
| `ELEVENLABS_API_KEY` | ElevenLabs | elevenlabs.io → Profile → API keys (paid plan for commercial music) | Eleven Music v2 for songs (`elevenlabs:music`, primary), multilingual TTS for voiceovers (`elevenlabs:tts`, primary) | ~$0.11–1.09 per song by length; TTS by character |

Later phases, not yet needed: Spitch (Yoruba/Igbo/Hausa TTS; direct quote), Mubert (music with sub-licensing; direct contract), sync.so (lip sync).

## Infrastructure keys (already in the env group; listed for completeness)

| Env var | What |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Postgres (Supabase / Render). Direct string for migrations. |
| `REDIS_URL` | Render Key Value / Upstash. **Optional** — the API and worker run without it, slower. |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2: dashboard → R2 → Manage API tokens → Object Read & Write, scoped to the bucket. Endpoint is `https://<account-id>.r2.cloudflarestorage.com`. Set a CORS rule on the bucket allowing `PUT` from the app origins, or browser uploads fail silently. |
| `APP_KEY` | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google |
| `RESEND_API_KEY`, `MAIL_FROM` | Mail |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET` | NGN payments (Phase 8) |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET` | International payments, merchant of record (Phase 8) |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | WhatsApp Cloud API (Phase 5; gated on Meta Business verification) |
| `WORKER_FAST_CONCURRENCY`, `WORKER_HEAVY_CONCURRENCY`, `WORKER_DIRECT_CONCURRENCY` | Worker sizing |

## Routing, as seeded

| Capability | Order | Note |
|---|---|---|
| IMAGE_EDIT | vertex:gemini-3-pro-image → fal:seedream-4.5-edit → bfl:flux-kontext-pro | fidelity first, then cost |
| IMAGE_GENERATE | vertex:gemini-3-pro-image → fal:flux-2-pro | |
| BACKGROUND_REMOVE | fal:bria-rmbg-2 (ORGANIZATION only) → replicate:birefnet | Bria trains on licensed data; enterprise procurement asks |
| BACKGROUND_REPLACE | photoroom:edit → vertex:gemini-3-pro-image | |
| RELIGHT | photoroom:edit | |
| UPSCALE | fal:clarity-upscaler | |
| IMAGE_TO_VIDEO | fal:wan-2.5-i2v → openai:sora-2 → vertex:veo-3.1-fast | budget first: at 120 credits a reel sells for ~$1.80 and Veo costs more than that |
| TEXT_GENERATE | google:gemini-2.5-flash-lite → anthropic:claude-haiku-4.5 | |
| VIDEO_STITCH | local:ffmpeg | ours |
| VOICEOVER / MUSIC / DUB / LIPSYNC | declared, disabled | Phases 10–11 |

## Licensing landmines

- **Kling** — disabled in the seed for the reasons above. Cheapest per second in the market and the single largest contractual risk in this codebase.
- **Suno / Udio consumer tiers** — commercial use but no indemnification; Sony litigation unresolved as of Sept 2026. Music routes to Mubert / ElevenLabs Music; Suno only via its licensed partner API.
- **Ideogram** — self-serve licence excludes resale and API-like access. Not routed.
- **Copyrightability** — purely AI-generated output likely fails the human-authorship test in US law. Do not promise exclusivity; say so in the terms.
- **Platform disclosure** — Instagram and TikTok require AI-content labelling. Publishing phase obligation.

## Video pricing (settled for launch)

A credit is ~$0.015 at launch (business: 2,400 for $29).

| Product | Credits | Sells for | Provider cost (budget route) | Margin |
|---|---|---|---|---|
| `video.reel` (one shot, 5–8 s) | 120 | ~$1.80 | Wan 2.5 720p ~$0.50–0.80 · Sora 2 ~$0.40–0.80 | ~55–75% |
| `video.ad_15s` (two 8 s shots + stitch) | 260 | ~$3.90 | ~$1.60 + a planner call | ~58% |
| `video.ad_30s` (four shots + stitch) | 480 | ~$7.20 | ~$2.90 + a planner call | ~60% |

Veo 3.1 Fast (~$2–3.20 per 8 s) does not clear the reel price and stays at priority 30 — a fallback, not the default — until the reel is repriced or a premium tier exists. Promoting it is a row edit. Stitching is ours (ffmpeg) and costs nothing at the vendor.

`VIDEO_DAILY_LIMIT` (default 20 parents/standalone videos per workspace per rolling day) is the guardrail that fails closed; `ProviderModel.enabled` is the kill switch.

## Payments (Phase 8)

Two gateways behind one contract (`apps/api/src/modules/billing/billing.types.ts`). **Currency picks the gateway**: NGN, GHS, KES, ZAR, UGX, TZS, RWF, XOF, XAF, EGP, ETB, ZMW, MWK go to Flutterwave; everything else goes to Paddle, which is merchant of record and handles VAT and receipts.

| Env var | Vendor | Where to get it | Used for |
|---|---|---|---|
| `FLUTTERWAVE_SECRET_KEY` | Flutterwave | Dashboard → Settings → API keys (v3; `FLWSECK_TEST-…` in sandbox) | Hosted Standard checkout (`POST /v3/payments`), verification (`/v3/transactions/:id/verify`), subscriptions via payment plans |
| `FLUTTERWAVE_WEBHOOK_SECRET` | Flutterwave | Dashboard → Settings → Webhooks → "secret hash" (you choose it) | Sent back as the `verif-hash` header on every webhook. v4's `flutterwave-signature` HMAC is also accepted |
| `PADDLE_API_KEY` | Paddle Billing | Paddle → Developer tools → Authentication → API keys | Creating transactions server-side, verifying them, cancelling subscriptions |
| `PADDLE_CLIENT_TOKEN` | Paddle Billing | Same page → Client-side tokens | Opening the checkout overlay on `/billing/pay`. Public by design; the API serves it from `GET /billing/config` |
| `PADDLE_WEBHOOK_SECRET` | Paddle Billing | Paddle → Developer tools → Notifications → your endpoint → secret key (`pdl_ntfset_…`) | `Paddle-Signature` HMAC check |
| `PADDLE_ENV` | — | `sandbox` or `live` | Which Paddle API host. Production logs an error unless `live` |

**Webhook URLs to register**

- Flutterwave: `https://<api host>/api/v1/billing/webhooks/flutterwave`
- Paddle: `https://<api host>/api/v1/billing/webhooks/paddle` — subscribe to `transaction.completed`, `transaction.payment_failed`, `subscription.activated`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `adjustment.created`, `adjustment.updated`

**Products to create at the gateway, then record on the rows**

Prices live in `plans.priceByMarket` / `credit_packs.priceByMarket` (fixed per market, never converted). Each gateway also needs its own product for each thing we sell, and its id goes into the row's `providerRefs`:

```json
// plans.providerRefs
{ "paddle": { "month": "pri_01…", "year": "pri_01…" }, "flutterwave": { "month": 12345, "year": 12346 } }
// credit_packs.providerRefs
{ "paddle": { "once": "pri_01…" } }
```

- Paddle: one product per plan with a monthly and a yearly recurring price, one product per pack with a one-time price. Paddle's localised pricing sets the non-NGN amounts; our `priceByMarket` for USD/GBP is what the plans page shows, so keep them equal.
- Flutterwave: one **payment plan** per plan × interval (Dashboard → Payment plans, or `POST /v3/payment-plans`), amount equal to `priceByMarket.NGN`. Packs need no Flutterwave product.
- A plan or pack with no ref for the workspace's gateway shows as "not available through this payment provider yet" and cannot be bought — nothing is ever charged at an unknown price.

**How money becomes credits**

1. `POST /workspaces/:id/billing/checkout {kind, code, interval}` — the server prices it, writes a `PENDING` Payment row, gets a hosted checkout URL. The client never sends an amount.
2. The person pays on the gateway's page and returns to `/billing/return?ref=…`.
3. The return page calls `POST …/payments/:id/verify`; webhooks call `/billing/webhooks/<gateway>`. Both paths: signature check (webhooks) → **re-fetch the charge from the gateway** → compare amount/currency/reference with the row → grant through the ledger with idempotency key `payment:<id>`. Five deliveries, one grant.
4. A mismatch withholds credits, marks the row `FAILED: mismatch…` and logs at `error` — that line is the one to alert on.
5. Every webhook is a `webhook_receipts` row, verified or not, with the outcome. Redeliveries stop at the unique `(provider, eventId)`.

**Known gaps to verify in the sandbox before launch**

- Flutterwave subscription **renewals**: the renewal `charge.completed` is matched by the customer email plus the payment-plan id, because the renewal carries a Flutterwave-generated `tx_ref`. Confirm the field name (`payment_plan` vs `plan`) on a real renewal event and adjust `interpret()` in `flutterwave.gateway.ts`.
- Flutterwave **cancel** needs the per-customer subscription id, looked up from `GET /v3/subscriptions?email=…` at cancel time.
- Paddle **refunds** arrive as `adjustment.*` events; credits are clawed back through the ledger. If they were already spent the row says `refunded_clawback_failed` and a person decides.
- Plan credits do not yet expire at period end (open decision in the spec): today they accumulate like pack credits. `LedgerKind.EXPIRY` and `ledger.expire()` exist for when that is decided.


## Audio (Phase 10)

**Songs — the preview-then-unlock loop.** A request costs `audio.music.preview` (10 credits) and makes the *whole* song once: the copy model writes sectioned lyrics in the chosen language (unless the seller pasted their own), the genre row's `promptHints` and the lyrics go to the music provider, the full track is stored under the workspace's **vault** prefix — which no customer-facing path will sign — and ffmpeg cuts a 30-second faded preview. `POST /workspaces/:id/generations/:gid/unlock` debits `audio.music.unlock` (30 credits, once per song however often it is pressed), copies the track out of the vault and opens it for download. The WhatsApp bot (Phase 12) reuses the same two calls.

| Row | Vendor | Notes |
|---|---|---|
| `elevenlabs:music` (p10) | Eleven Music v2 | Prompt mode for instrumentals; a composition plan of chunks (lyrics per section, styles, durations) when there are words. Refuses artist names — the genre hints never use them. |
| `fal:minimax-music-v2` (p20) | MiniMax via fal | `prompt` + `lyrics_prompt` with `[Verse]`/`[Chorus]` tags. fal lists commercial use. |
| `mubert:track` | Mubert | Disabled; not on contract. |

**Genres** live in `music_genres` (68 seeded: Afrobeats, Amapiano, Highlife, Fuji, Jùjú, Bongo Flava, Gqom, Soukous, Mbalax, Raï, dancehall, reggaetón, K-pop, Bollywood, cumbia, samba, gospel, jazz, drill, lo-fi, cinematic, birthday…). Adding one is an INSERT; fixing how one sounds is an edit to its `promptHints`.

**Voiceovers** cost `audio.voiceover` (8). The voice row (`voice_profiles`) names the vendor and its voice id, and the router is constrained to that vendor — a fallback in someone else's voice is worse than a failure.

| Row | Vendor | Voices seeded |
|---|---|---|
| `elevenlabs:tts` (p10) | `eleven_multilingual_v2` | Rachel, Adam, Bella, Antoni, Domi, Josh (premade ids). Add African-English voices from the library as rows once the plan allows. |
| `google:tts` (p20) | Cloud Text-to-Speech, service account | en-NG (4), en-KE (2), en-ZA, fr-FR, pt-BR |
| `openai:tts` (p30) | `gpt-4o-mini-tts` | nova, onyx, coral |
| `spitch:tts` | Spitch | Disabled: Yoruba, Igbo, Hausa by quote. |

**Verify in the sandbox before launch:** Eleven Music's composition-plan field names against the live docs (the `chunks` shape used here is the documented v2 one); that the stub's 30-second preview cut matches the real track's loudness; MiniMax's `audio_setting` acceptance.
