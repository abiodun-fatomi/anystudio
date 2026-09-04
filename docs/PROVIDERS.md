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
| `HIGGSFIELD_API_KEY` | Higgsfield | already held | **Prototyping only.** The Kling row is disabled: Kling's ToS §4.6 forbids commercial use of outputs without written permission and §4.5 requires attribution. Ask Higgsfield in writing whether their route carries a pass-through licence. | — |
| `HEYGEN_API_KEY` | HeyGen | already held | Dubbing and avatars (Phase 11) | per-minute; not public, sales call |

Later phases, not yet needed: ElevenLabs (`ELEVENLABS_API_KEY` — voiceover, dubbing v1, music), Spitch (Yoruba/Igbo/Hausa TTS; direct quote), Mubert (music with sub-licensing; direct contract), sync.so (lip sync).

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

## The video margin problem (open)

Seeded plans put a credit at ~$0.015 (business: 2,400 credits for $29). `video.reel` at 120 credits is ~$1.80. Wan 2.5 and Sora 2 clear that; Veo 3.1 Fast (~$2–3.20 per 8 s) does not. The seed routes budget-first for this reason. Repricing `video.reel` or promoting Veo is a row change.
