# Providers, keys and environment

What each AI vendor does for the product, where its key comes from, what it
costs, and what has to be true before it serves a paying customer. The
routing itself is `ProviderModel` rows (seeded in `packages/db/prisma/seed.ts`);
this file is the reasoning behind those rows.

The [2026-09-08 quality review](PROVIDER_QUALITY.md) records the latest
use-case rankings, evidence, limitations and explicit `useCase` API routing.

Prices are from the vendors' September 2026 price lists. They move monthly.

## The rule

A `ProviderModel` row is enabled for customer traffic only when its
`licenceNote` records that reselling the output to our customers is permitted
under the plan we are on, with a date. No note, no traffic. Dev environments
route to the stub adapter without any key at all.

## Keys to obtain

| Env var                                                                      | Vendor                 | Where to get it                                                                             | Used for                                                                                                                                                                                                                                                | Unit cost                                                            |
| ---------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `FAL_KEY`                                                                    | fal.ai                 | fal.ai → Dashboard → Keys                                                                   | Seedream 4.5 edit, Flux 2 Pro, Bria RMBG 2.0, Clarity upscaler, Wan 2.5 image-to-video                                                                                                                                                                  | $0.04 edit · $0.018 rmbg · $0.03/MP upscale · $0.05–0.15/s video     |
| `GOOGLE_AI_API_KEY`                                                          | Google AI Studio       | aistudio.google.com → Get API key (enable billing for paid tier)                            | Gemini 3 Pro Image (edit/generate/replace/relight), Gemini 3.5 Flash-Lite (copy), Veo 3.1 Fast (video)                                                                                                                                                  | ~$0.13/image · see live token pricing · $0.10/s 720p video           |
| `GOOGLE_VERTEX_SA_JSON` + `GOOGLE_VERTEX_PROJECT` + `GOOGLE_VERTEX_LOCATION` | Google Cloud Vertex AI | GCP console → IAM → Service account with `Vertex AI User`; download JSON; paste as one line | Same models through the door with **generative-AI indemnification** on GA versions. Switch to this before selling to an ORGANIZATION customer.                                                                                                          | same                                                                 |
| `REPLICATE_API_TOKEN`                                                        | Replicate              | replicate.com → Account → API tokens                                                        | BiRefNet background removal                                                                                                                                                                                                                             | ~$0.0005/image                                                       |
| `PHOTOROOM_API_KEY`                                                          | Photoroom              | photoroom.com/api → sign up; ask about the startup programme (up to 90% off)                | Background replacement with generated scenes, AI shadows, relighting                                                                                                                                                                                    | $0.10/image (Plus tier), $0.02 remove-only                           |
| `OPENAI_API_KEY`                                                             | OpenAI                 | platform.openai.com → API keys                                                              | TTS fallback. The Sora row is retained for history but disabled before the API's 2026-09-24 shutdown                                                                                                                                                    | see OpenAI API pricing                                               |
| `ANTHROPIC_API_KEY`                                                          | Anthropic              | console.anthropic.com → API keys                                                            | Claude Haiku 4.5 for brand-voice copy                                                                                                                                                                                                                   | $1/$5 per 1M tokens                                                  |
| `BFL_API_KEY`                                                                | Black Forest Labs      | api.bfl.ai → sign up                                                                        | Flux Kontext Pro — budget edit tier                                                                                                                                                                                                                     | $0.04/image                                                          |
| `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET`                               | Higgsfield             | cloud.higgsfield.ai → account settings → API keys                                           | Their own DoP image-to-video models (`higgsfield:dop-turbo`, row disabled until resale terms are on file). The Kling row through them stays disabled: Kling's ToS §4.6 forbids commercial use without written permission and §4.5 requires attribution. | ~$0.60/clip (verify)                                                 |
| `HEYGEN_API_KEY`                                                             | HeyGen                 | already held (app.heygen.com → Settings → API)                                              | Video Translate v3 (`heygen:translate`) and Lipsync v3 (`heygen:lipsync`) — 175+ languages including English (Nigeria/Kenya/SA), Swahili, Zulu, Amharic                                                                                                 | credits per minute on the API plan; confirm the rate for your tier   |
| `ELEVENLABS_API_KEY`                                                         | ElevenLabs             | elevenlabs.io → Profile → API keys (paid plan for commercial music)                         | Eleven Music v2 for songs (`elevenlabs:music`, primary), multilingual TTS for voiceovers (`elevenlabs:tts`, primary), Dubbing for video translation (`elevenlabs:dubbing-v1`, primary for ~30 languages)                                                | Music $0.15/generated min; TTS by character; dubbing ~$0.50–1.00/min |
| `SYNC_API_KEY`                                                               | sync.so                | sync.so → Dashboard → API keys (optional: the same model is reachable through fal)          | `sync:lipsync-2` direct; the row is seeded disabled — enable it when on contract                                                                                                                                                                        | per second of output                                                 |

Later phases, not yet needed: Spitch (Yoruba/Igbo/Hausa TTS; direct quote), Mubert (music with sub-licensing; direct contract).

## Infrastructure keys (already in the env group; listed for completeness)

| Env var                                                                              | What                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DIRECT_URL`                                                         | Postgres (Supabase / Render). Direct string for migrations.                                                                                                                                                                                                      |
| `REDIS_URL`                                                                          | Render Key Value / Upstash. **Optional** — the API and worker run without it, slower.                                                                                                                                                                            |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`               | Cloudflare R2: dashboard → R2 → Manage API tokens → Object Read & Write, scoped to the bucket. Endpoint is `https://<account-id>.r2.cloudflarestorage.com`. Set a CORS rule on the bucket allowing `PUT` from the app origins, or browser uploads fail silently. |
| `APP_KEY`                                                                            | `openssl rand -base64 32`                                                                                                                                                                                                                                        |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                           | Sign in with Google                                                                                                                                                                                                                                              |
| `RESEND_API_KEY`, `MAIL_FROM`                                                        | Mail                                                                                                                                                                                                                                                             |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET`                               | NGN payments (Phase 8)                                                                                                                                                                                                                                           |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`                                            | International payments, merchant of record (Phase 8)                                                                                                                                                                                                             |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | WhatsApp Cloud API (Phase 5; gated on Meta Business verification)                                                                                                                                                                                                |
| `WORKER_FAST_CONCURRENCY`, `WORKER_HEAVY_CONCURRENCY`, `WORKER_DIRECT_CONCURRENCY`   | Worker sizing                                                                                                                                                                                                                                                    |

## Routing, as seeded

| Capability         | Order                                                                                                           | Note                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| IMAGE_EDIT         | fal:seedream-4.5-edit → vertex:gemini-3-pro-image → bfl:flux-kontext-pro                                        | `useCase: design` (including Flyer UI) puts Gemini first                      |
| IMAGE_GENERATE     | vertex:gemini-3-pro-image → fal:flux-2-pro                                                                      | `useCase: photography` puts FLUX.2 Pro first                                  |
| BACKGROUND_REMOVE  | fal:bria-rmbg-2 (ORGANIZATION only) → photoroom:edit → replicate:birefnet                                       | quality-oriented commerce default; organization restriction retained          |
| BACKGROUND_REPLACE | photoroom:edit → vertex:gemini-3-pro-image                                                                      |                                                                               |
| RELIGHT            | photoroom:edit → vertex:gemini-3-pro-image                                                                      |                                                                               |
| UPSCALE            | fal:clarity-upscaler                                                                                            |                                                                               |
| IMAGE_TO_VIDEO     | vertex:veo-3.1-fast → fal:wan-2.5-i2v                                                                           | quality first at the same $0.10/s 720p cost; Sora is disabled before shutdown |
| TEXT_GENERATE      | google:gemini-3.5-flash-lite → anthropic:claude-haiku-4.5                                                       |                                                                               |
| VIDEO_STITCH       | local:ffmpeg                                                                                                    | ours                                                                          |
| COLLAGE            | none — the worker's own sharp                                                                                   | ours; no ProviderConfig row, nothing is billed                                |
| VOICEOVER          | the voice's own vendor only                                                                                     | see Audio                                                                     |
| MUSIC              | elevenlabs:music → fal:minimax-music-v2                                                                         | see Audio                                                                     |
| DUB                | elevenlabs:dubbing-v1 → heygen:translate, narrowed to who speaks the language; HeyGen first when lips must move | see Dubbing                                                                   |
| LIPSYNC            | fal:sync-lipsync → heygen:lipsync (→ sync:lipsync-2, disabled)                                                  | see Dubbing                                                                   |

## Licensing landmines

- **Kling** — disabled in the seed for the reasons above. Cheapest per second in the market and the single largest contractual risk in this codebase.
- **Suno / Udio consumer tiers** — commercial use but no indemnification; Sony litigation unresolved as of Sept 2026. Music routes to ElevenLabs Music / MiniMax; Suno only via its licensed partner API.
- **Ideogram** — self-serve licence excludes resale and API-like access. Not routed.
- **Copyrightability** — purely AI-generated output likely fails the human-authorship test in US law. Do not promise exclusivity; say so in the terms.
- **Platform disclosure** — Instagram and TikTok require AI-content labelling. Publishing phase obligation.

## Video pricing (settled for launch)

A credit is ~$0.015 at launch (business: 2,400 for $29).

| Product                                 | Credits | Sells for | Primary provider cost         | Gross margin before infrastructure |
| --------------------------------------- | ------- | --------- | ----------------------------- | ---------------------------------- |
| `video.reel` (one shot, 5–8 s)          | 120     | ~$1.80    | Veo 3.1 Fast 720p ~$0.60–0.80 | ~56–67%                            |
| `video.ad_15s` (two 8 s shots + stitch) | 260     | ~$3.90    | ~$1.60 + a small planner call | ~58%                               |
| `video.ad_30s` (four planned shots)     | 480     | ~$7.20    | ~$2.80 + a small planner call | ~61%                               |
| `video.ad_45s` (six planned shots)      | 700     | ~$10.50   | ~$4.40 + a small planner call | ~58%                               |
| `video.ad_60s` (eight planned shots)    | 920     | ~$13.80   | ~$6.00 + a small planner call | ~56%                               |

Veo 3.1 Fast is the quality-first primary at the same published $0.10/s 720p price as Wan 2.5. Wan is the independent fallback. The product's 5-second slot asks Veo for its supported 6-second size and trims it, avoiding a frozen final second while preserving Veo as the primary. A one-time migration reconciles existing operator-owned priorities, and Sora is disabled rather than allowed to become a production dependency days before its permanent shutdown. Stitching is ours (ffmpeg) and costs nothing at the vendor.

`VIDEO_DAILY_LIMIT` (default 20 parents/standalone videos per workspace per rolling day) is the guardrail that fails closed; `ProviderModel.enabled` is the kill switch.

## Payments (Phase 8)

Two gateways behind one contract (`apps/api/src/modules/billing/billing.types.ts`). **Currency picks the gateway**: NGN, GHS, KES, ZAR, UGX, TZS, RWF, XOF, XAF, EGP, ETB, ZMW, MWK go to Flutterwave; everything else goes to Paddle, which is merchant of record and handles VAT and receipts.

| Env var                      | Vendor         | Where to get it                                                                        | Used for                                                                                                                      |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `FLUTTERWAVE_SECRET_KEY`     | Flutterwave    | Dashboard → Settings → API keys (v3; `FLWSECK_TEST-…` in sandbox)                      | Hosted Standard checkout (`POST /v3/payments`), verification (`/v3/transactions/:id/verify`), subscriptions via payment plans |
| `FLUTTERWAVE_WEBHOOK_SECRET` | Flutterwave    | Dashboard → Settings → Webhooks → "secret hash" (you choose it)                        | Sent back as the `verif-hash` header on every webhook. v4's `flutterwave-signature` HMAC is also accepted                     |
| `PADDLE_API_KEY`             | Paddle Billing | Paddle → Developer tools → Authentication → API keys                                   | Creating transactions server-side, verifying them, cancelling subscriptions                                                   |
| `PADDLE_CLIENT_TOKEN`        | Paddle Billing | Same page → Client-side tokens                                                         | Opening the checkout overlay on `/billing/pay`. Public by design; the API serves it from `GET /billing/config`                |
| `PADDLE_WEBHOOK_SECRET`      | Paddle Billing | Paddle → Developer tools → Notifications → your endpoint → secret key (`pdl_ntfset_…`) | `Paddle-Signature` HMAC check                                                                                                 |
| `PADDLE_ENV`                 | —              | `sandbox` or `live`                                                                    | Which Paddle API host. Production refuses to start unless `live`; Flutterwave test keys are likewise rejected                 |

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
3. The return page calls `POST …/payments/:id/verify`; webhooks call `/billing/webhooks/<gateway>`. Both paths: signature check (webhooks) → **re-fetch the charge from the gateway** → compare amount, currency, transaction ownership and merchant reference with the row → commit Payment + ledger + invoice/subscription in one database transaction. The ledger key `payment:<id>` makes repeated return checks and webhook deliveries one grant.
4. A mismatch or duplicate/late invoice charge never grants credits. The Payment becomes `NEEDS_REVIEW` and a durable full-refund command is created; the worker submits it once and then verifies provider state instead of blindly repeating an ambiguous POST. `Invoice.paymentId` is the checkout reservation, so reopening an old invoice always returns the same hosted checkout rather than creating a second charge.
5. A correctly signed webhook is stored in `webhook_receipts` before processing. Errors and abandoned claims are redriven locally with bounded backoff, independently of how long the vendor retries. Invalid signatures are rejected before a database write so this endpoint cannot be used for attacker-controlled payload retention or unbounded rows.

**Renewals, cancellations, refunds and disputes**

- Renewals are new `RENEWAL` Payment rows, uniquely keyed by gateway transaction id. Paddle is matched by its immutable subscription id. Flutterwave is matched by per-customer subscription id when available, otherwise by the payment-plan id plus normalized customer email; an email-only event is accepted only when it identifies exactly one live subscription. A renewal on a locally cancelled subscription is recorded as money received but is not credited and is automatically refunded.
- A customer cancellation is saved locally before the provider call. Paddle receives `effective_from: next_billing_period`; Flutterwave upgrades a legacy shared plan reference through the original transaction id (falling back to customer email + plan only when it identifies one subscription) and stops future collection immediately while local access remains through the paid period. Provider timeouts remain `providerCancelPending` and the worker retries. A terminal Paddle `subscription.canceled` event is always terminal locally; a future `scheduled_change` remains active with `cancelAtPeriodEnd`.
- Staff approval moves a refund request to `PROCESSING`, reserves its credits, and sends the provider request. Paddle `pending_approval` and Flutterwave's initial `completed` acknowledgement are not final success; reconciliation continues until the provider reports a terminal outcome. A definite rejection releases the reservation. An ambiguous timeout is queried, never resubmitted. Exhausted/contradictory cases become `NEEDS_REVIEW` instead of cycling forever.
- Every confirmed refund, chargeback and reversal is a unique `payment_adjustments` row. Partial adjustments claw back credits in proportion to the funded purchase; if credits were spent, the authoritative clawback can make the wallet negative so unfunded work cannot continue. Full returns mark the Payment `REFUNDED`; partials and reversals remain visible as `NEEDS_REVIEW`. Flutterwave refund responses accept both documented lowercase and legacy uppercase (`TransactionId`, `AmountRefunded`) fields. Flutterwave chargebacks are resolved by `flw_ref`; initiated/accepted/lost disputes withhold value, while only won/reversed restores it. Paddle `chargeback*` adjustments use the same state machine.

**Launch checks that still require real sandbox/live fixtures**

- Capture one Flutterwave renewal for each enabled recurring payment method and retain it as a redacted contract fixture. The adapter accepts both `payment_plan` and `plan`, but production matching should be observed with the exact methods you enable.
- Ask Flutterwave support to enable chargeback webhooks, register both webhook URLs above, and exercise a partial refund, a refund reversal, a scheduled Paddle cancellation and a terminal cancellation before enabling sales.
- Alert on `Payment.status = NEEDS_REVIEW`, `RefundRequest.status = NEEDS_REVIEW`, `providerCancelPending` with a non-null error, and verified webhook receipts that exhaust their retry budget.
- Plan credits do not yet expire at period end (an explicit product-policy decision): today they accumulate like pack credits. `LedgerKind.EXPIRY` and `ledger.expire()` exist if that policy changes.

## Audio (Phase 10)

**Songs — the preview-then-unlock loop.** A request costs 10 credits per started 30 seconds under `audio.music.preview` and makes the _whole_ song once: the copy model writes sectioned lyrics in the chosen language (unless the seller pasted their own), the genre row's `promptHints` and the lyrics go to the music provider, the full track is stored under the workspace's **vault** prefix — which no customer-facing path will sign — and ffmpeg cuts a 30-second faded preview. `POST /workspaces/:id/generations/:gid/unlock` debits `audio.music.unlock` (10 credits, once per song however often it is pressed), copies the track out of the vault and opens it for download. Charging the generation work up front prevents an abandoned preview from becoming a provider-cost loss. The WhatsApp bot (Phase 12) reuses the same two calls.

| Row                          | Vendor          | Notes                                                                                                                                                                                                                                     |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elevenlabs:music` (p10)     | Eleven Music v2 | Prompt mode for instrumentals; a composition plan of chunks (lyrics per section, styles, durations) when there are words. Refuses artist names — the genre hints never use them. Provider cost is captured at $0.15 per generated minute. |
| `fal:minimax-music-v2` (p20) | MiniMax via fal | `prompt` + `lyrics_prompt` with `[Verse]`/`[Chorus]` tags. fal lists commercial use.                                                                                                                                                      |
| `mubert:track`               | Mubert          | Disabled; not on contract.                                                                                                                                                                                                                |

**Genres** live in `music_genres` (68 seeded: Afrobeats, Amapiano, Highlife, Fuji, Jùjú, Bongo Flava, Gqom, Soukous, Mbalax, Raï, dancehall, reggaetón, K-pop, Bollywood, cumbia, samba, gospel, jazz, drill, lo-fi, cinematic, birthday…). Adding one is an INSERT; fixing how one sounds is an edit to its `promptHints`.

**Voiceovers** cost `audio.voiceover` (8). The voice row (`voice_profiles`) names the vendor and its voice id, and the router is constrained to that vendor — a fallback in someone else's voice is worse than a failure.

| Row                    | Vendor                                | Voices seeded                                                                                                                    |
| ---------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `elevenlabs:tts` (p10) | `eleven_multilingual_v2`              | Rachel, Adam, Bella, Antoni, Domi, Josh (premade ids). Add African-English voices from the library as rows once the plan allows. |
| `google:tts` (p20)     | Cloud Text-to-Speech, service account | en-NG (4), en-KE (2), en-ZA, fr-FR, pt-BR                                                                                        |
| `openai:tts` (p30)     | `gpt-4o-mini-tts`                     | nova, onyx, coral                                                                                                                |
| `spitch:tts`           | Spitch                                | Disabled: Yoruba, Igbo, Hausa by quote.                                                                                          |

### Your own voice

A workspace can record its owner's voice (Settings → Your voice: 10 s to 3 min, browser recorder or an upload, consent ticked) and the API clones it at ElevenLabs — `POST /v1/voices/add`, an instant voice clone. The clone is a `VoiceProfile` row of kind `CLONE` with `workspaceId`, `sampleKey`, `consentAt` and `createdById`; the catalogue endpoint `GET /workspaces/:id/voices` returns presets plus that workspace's own, and nowhere else does the row appear — the runner, the voiceover pipeline and the music pipeline all refuse a clone that belongs to another workspace as "unknown voice". At most `CLONES_PER_WORKSPACE` (2) per workspace; deleting removes it at the vendor first (`DELETE /v1/voices/{id}`), then here.

Two things use it:

- **Voiceover in your voice** — the clone is just another voice in the picker; `elevenlabs:tts` reads the script with its `providerVoiceId`. Priced as any voiceover.
- **Song sung in your voice (experimental)** — `singer: 'me'` on a MUSIC request, priced under `audio.music.preview.my_voice` at 20 credits per started 30 seconds (the server sets this code whatever the client claimed). The song is made normally, then `worker/pipelines/my-voice.ts` splits it into stems (`POST /v1/music/stem-separation`, `two_stems_v1`, a ZIP read by `adapters/unzip.ts`), converts the vocal stem with speech-to-speech (`POST /v1/speech-to-speech/{voice_id}`, `eleven_multilingual_sts_v2`) and mixes it back over the instrumental with ffmpeg. A definitive voice-processing failure falls back to the model vocal, atomically returns the voice premium, and labels the result; an ambiguous provider submission fails closed and refunds the whole generation rather than risk duplicate spend. The melody and timing are the model's; only the timbre changes, which is why it is labelled experimental.

These are not routed capabilities: a clone lives at one vendor and every later step has to happen there, so the adapter exposes them through the `VoiceLab` interface (`adapters/voice-lab.ts`) and pipelines reach it with `ctx.voiceLab(providerKey)`. Instant cloning needs a paid ElevenLabs plan (Starter or above); stems and speech-to-speech bill by audio length.

**Verify in the sandbox before launch:** Eleven Music's composition-plan field names against the live docs (the `chunks` shape used here is the documented v2 one); that the stub's 30-second preview cut matches the real track's loudness; MiniMax's `audio_setting` acceptance; the file names inside the stem-separation ZIP (the adapter matches `vocal`/`voice` against everything else) and that speech-to-speech accepts a track as long as a song (STS is documented for speech; a 2–4 minute vocal stem is at the edge).

## Dubbing and lip-sync (Phase 11)

**Translate a video** (`DUB`) keeps the speaker's own voice and says it again in another language. Voice only costs `video.translate` (90 per started minute); with the mouth re-animated to match, `video.translate_lipsync` is 240 per started 30 seconds. Precision doubles only the lip-animation units. Upload completion records container duration with ffprobe, and both quote and debit use that verified value; legacy READY files are probed before purchase. The runner reads the target language off the row and narrows the router to the vendors that speak it (`DUB_LANGUAGES` in `packages/shared` carries each code's ElevenLabs code and HeyGen name), putting HeyGen first when lips are wanted because it does both in one pass. When ElevenLabs dubs the sound, the pipeline stores the dubbed video under `gen/<id>/work/`, pulls the new soundtrack with ffmpeg and finishes with a `LIPSYNC` vendor. Work objects are registered as expendable media before upload, retained while a parent still needs them, and purged on every terminal transition; failed storage deletion is retried by retention. The text output records the language, whether the lips were moved and which vendor spoke.

**Lip-sync new words** (`LIPSYNC`, `video.lipsync`, 150 per started 30 seconds; precision 2×) takes an uploaded audio file, or a script that is recorded first in a catalogue voice (routed to that voice's vendor exactly as the voice tool is) and stored beside the row.

| Row                              | Vendor                        | Notes                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elevenlabs:dubbing-v1` (p10)    | ElevenLabs Dubbing            | `POST /v1/dubbing` multipart by `source_url` (the signed R2 URL; the file never passes through the worker twice), poll `GET /v1/dubbing/{id}` for `dubbed`/`failed`, download `GET /v1/dubbing/{id}/audio/{lang}` (an MP4 for a video source). ~30 languages, no accent choice, no African languages beyond Arabic, French and Portuguese. |
| `heygen:translate` (p20)         | HeyGen Video Translate v3     | `POST /v3/video-translations` with a language _name_, `translate_audio_only` unless lips are wanted, `mode` speed/precision from the request's `quality`; poll `GET /v3/video-translations/{id}`.                                                                                                                                          |
| `fal:sync-lipsync` (p10)         | sync.so lipsync-2 through fal | `video_url` + `audio_url`, `sync_mode: cut_off` so the clip ends with the words; `lipsync-2-pro` for `quality: precision`.                                                                                                                                                                                                                 |
| `heygen:lipsync` (p20)           | HeyGen Lipsync v3             | `POST /v3/lipsyncs`, same polling.                                                                                                                                                                                                                                                                                                         |
| `sync:lipsync-2` (p30, disabled) | sync.so direct                | `POST /v2/generate`; `REJECTED` is their moderation and is treated as the content's fault, not a reason to fall back. Enable when `SYNC_API_KEY` is set.                                                                                                                                                                                   |

**Languages.** `GET /audio/dub-languages` returns only what this environment's vendors can serve (all of them in a stub-only environment), grouped by region, each marked with whether lips can be matched. Yoruba, Igbo, Hausa and Pidgin are not offered by any dubbing vendor as of September 2026; the studio says so rather than failing after the upload.

**Consent.** Both capabilities require `consent: true` in the params — the studio's box "I have permission to use this person's face and voice" — because a dub clones a voice and a lip-sync re-animates a face. The pipeline logs the flag with the request. HeyGen's and sync's own moderation (`failure_message`, `REJECTED`) surfaces as `CONTENT_REJECTED`, which refunds and does not retry.

**Length.** Vendors bill by the minute; one credit price covers up to 5 minutes for a dub and 3 for a lip-sync (`DUB_MAX_SEC`, `LIPSYNC_MAX_SEC`). The pipeline measures the source with ffprobe over HTTP before any vendor is paid and refuses longer ones with the credits returned.

### Queues and how long an ad takes

Three weight classes, because "long" means two different things. `media.fast`
(6 at once) is everything that finishes in seconds. `media.heavy` (8) is work
that WAITS on a vendor — a shot rendering, a song composing, a dub: the slot
holds a socket and a timer, not a core, so a four-shot ad renders its four
shots side by side rather than two at a time. `media.local` (1) is ffmpeg on
the dedicated 2 GB media worker — stitching really does need the CPU and its
process-wide `FFMPEG_CONCURRENCY=1` is deliberate. Concurrency comes from
`WORKER_FAST_CONCURRENCY`, `WORKER_HEAVY_CONCURRENCY` and
`WORKER_LOCAL_CONCURRENCY`; the main worker serves only fast/heavy and the
media worker serves only local.

A parent ad steps aside while its shots run (it holds no slot), and each
finished shot publishes the parent's score — "shot 3 of 4 · 2 rendering at
once" — so the card moves instead of showing one frozen sentence for five
minutes.

### How a post did

Every published post is re-read from its platform on a rota (`PublishingService.refreshMetrics`, every 15 minutes on the worker; a post under a day old is read hourly, older ones every six hours, nothing older than 30 days): Instagram's `like_count`/`comments_count` plus `/insights` for reach, saves, shares and views (needs `instagram_manage_insights`), TikTok's `video/query` for views, likes, comments and shares (needs `video.list`). The numbers land on `PublishJob.metrics` as `{views, reach, likes, comments, shares, saved}` — a figure the platform does not report stays **null**, never zero, so the UI can say "not reported" instead of "none". A refusal keeps the last numbers and touches `metricsAt` so one broken post cannot hold up the rota; a dead token marks the account `NEEDS_REAUTH`. Insights folds these into the Today page along with next steps.

### A presenter on camera ("filmed by a customer")

With `format: 'ugc'` and two or more shots, an IMAGE_TO_VIDEO request may carry `presenter`: a stock look from `PRESENTERS` (packages/shared — HeyGen studio avatars in everyday clothes, chosen by look) or the seller from one photo (`photoKey` + `consent: true`), a voice (any VoiceProfile incl. the workspace's own clone) and optionally their own words. `worker/pipelines/presenter.ts` records the script through the VOICEOVER route, then asks the HeyGen adapter's `PresenterLab` side door (`talkingVideo`: `POST /v2/video/generate` with `character` avatar or talking_photo and `voice: {type:'audio', audio_url}`, polled on `/v1/video_status.get`; a photo goes through `upload.heygen.com/v1/talking_photo` first) to film the person saying exactly that audio. The clip becomes shot one, the speech becomes the ad's `voiceoverKey` (laid from zero by the stitcher so lips and sound align), and the planner writes one fewer product shot plus `presenterScript`. Rendered before the shots are dispatched and written on the row as `presenterClip`, so a retry of the parent reuses it. Priced under `video.ad_<len>_presenter` (the server decides). HeyGen's talking-photo upload is marked deprecated in favour of photo avatars; if it goes, swap `uploadTalkingPhoto` for the v3 asset upload + Avatar IV route.

**Verify in the sandbox before launch:** ElevenLabs' dubbing `status` vocabulary (`dubbing`/`dubbed`/`failed` is what the docs show) and that a video source really comes back as MP4 from the `/audio/` endpoint; HeyGen v3's status wrapper (`data.status` vs top-level — both are read) and the exact language names (`GET /v3/video-translations/languages`); fal's `sync_mode` values; whether HeyGen `translate_audio_only: false` output should be trusted as lip-synced (it is, per their docs) so the second pass is skipped.
