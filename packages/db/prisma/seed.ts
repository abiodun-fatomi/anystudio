/**
 * Seeding.
 *
 * Two tiers, and the split matters:
 *
 *   Reference data  — plans, credit costs, provider routing. This is
 *                     CONFIGURATION THE APPLICATION READS AT RUNTIME, which is
 *                     why it lives in the database rather than in constants: a
 *                     provider outage should be a toggle in the admin console,
 *                     not a deploy. Runs in every environment, every deploy.
 *
 *   Fixtures        — a demo workspace, a seeded wallet, a test organization.
 *                     Guarded by SEED_ENV, and production refuses outright.
 *
 * Everything is an upsert keyed on a natural key, so running this twice changes
 * nothing. A seed that is not idempotent cannot be part of a deploy, and a seed
 * that is not part of a deploy drifts until it is wrong.
 */

import { GENRES, VOICES } from './seed-audio';
import { PrismaClient, type Prisma, type ProviderCapability, type WorkspaceType } from '@prisma/client';

const db = new PrismaClient();

/**
 * The dev account's password. Printed by the seed, never used anywhere real:
 * fixtures() only runs with SEED_ENV=dev and production refuses that outright.
 */
const DEV_PASSWORD = 'anystudio-dev';
const DEV_WALLET_ID = '00000000-0000-4000-8000-000000000003';

/** What each operation costs. Referenced by generation jobs; never hard-coded. */
const CREDIT_COSTS = [
  { code: 'image.storefront', credits: 10, label: 'Branded product image' },
  { code: 'image.background', credits: 10, label: 'Background replacement' },
  { code: 'image.bg_remove', credits: 2, label: 'Background removal' },
  { code: 'image.upscale', credits: 3, label: 'Upscale' },
  { code: 'image.relight', credits: 5, label: 'Relight and shadow' },
  // Ours end to end — sharp on our own box, no vendor — so it is priced to be
  // used freely: a seller who makes a collage of every batch posts more often.
  { code: 'image.collage', credits: 2, label: 'Photo collage' },
  // The merchant shots. One vendor call each, seconds long, ~$0.10 of vendor
  // cost against ~$0.15 of credits — the same margin the scene tool runs at.
  { code: 'image.product_shot', credits: 10, label: 'Product shot' },
  // Priced above the rest because it replaces a model and a photographer.
  { code: 'image.on_model', credits: 16, label: 'Worn by a model' },
  // The same shot, bigger. A merchant posting to Status wants the first one
  // and should not pay for pixels WhatsApp is going to throw away; a seller
  // printing a banner needs the last one and knows it. The vendor renders
  // roughly 1K, 2K and 4K on the long side, so the prices step with the work.
  { code: 'image.on_model.2k', credits: 24, label: 'Worn by a model, for listing' },
  { code: 'image.on_model.4k', credits: 38, label: 'Worn by a model, for printing' },
  { code: 'text.description', credits: 2, label: 'Product description' },
  { code: 'text.caption', credits: 1, label: 'Social caption' },
  // A reel is 5–8 seconds of provider video. At launch pricing a credit is
  // about $0.015, so 120 credits is ~$1.80. Veo 3.1 Fast and Wan 2.5 are both
  // $0.10/s at 720p; the quality-first route still leaves operating margin.
  { code: 'video.reel', credits: 120, label: 'Reel ad' },
  { code: 'video.stitch', credits: 20, label: 'Assemble a multi-shot ad' },
  { code: 'video.ad_15s', credits: 260, label: '15-second ad (two shots)' },
  { code: 'video.ad_30s', credits: 480, label: '30-second ad (four shots)' },
  { code: 'video.ad_45s', credits: 700, label: '45-second ad (six shots)' },
  { code: 'video.ad_60s', credits: 920, label: '60-second ad (eight shots)' },
  // With a presenter talking to camera first: the same shots less one, plus a voice and a rendered talking segment.
  { code: 'video.ad_15s_presenter', credits: 400, label: '15-second ad with a presenter' },
  { code: 'video.ad_30s_presenter', credits: 620, label: '30-second ad with a presenter' },
  { code: 'video.ad_45s_presenter', credits: 840, label: '45-second ad with a presenter' },
  { code: 'video.ad_60s_presenter', credits: 1060, label: '60-second ad with a presenter' },
  // A shot of a multi-shot ad. The PARENT row holds the price; its children
  // are work units, not money units, and carry zero credits by design.
  { code: 'video.shot', credits: 0, label: 'One shot of an ad' },
  // Dubbing and lip animation are metered by verified source duration because
  // their vendors meter the same way. Quantity is computed before the debit.
  { code: 'video.translate', credits: 90, label: 'Translate video audio (per started minute)' },
  { code: 'video.translate_lipsync', credits: 240, label: 'Translate with lip-sync (per started 30 seconds)' },
  { code: 'video.lipsync', credits: 150, label: 'Lip-sync video (per started 30 seconds)' },
  { code: 'audio.voiceover', credits: 8, label: 'Voiceover' },
  // The whole song is generated before its preview is cut, so generation is
  // charged up front per started 30 seconds. Unlocking is only the vault copy.
  { code: 'audio.music.preview', credits: 10, label: 'Song generation (per 30 seconds)' },
  { code: 'audio.music.unlock', credits: 10, label: 'Unlock the full song' },
  { code: 'audio.music', credits: 40, label: 'Full song' },
  // Sung in the seller's own voice: the song, then stems and a voice conversion on top — vendor cost roughly double.
  { code: 'audio.music.preview.my_voice', credits: 20, label: 'Song in your voice (per 30 seconds)' },
];

/**
 * Prices are fixed per market, never converted at the day's rate. A seller
 * budgeting in naira must see the same number every month.
 */
/**
 * Plans: monthly credits and fixed local prices. Yearly is ten months for
 * twelve. `providerRefs` (Paddle price ids, Flutterwave payment-plan ids)
 * are NOT seeded — they are set in each environment once the products exist
 * at the gateway, and a plan without a ref cannot be bought through that
 * gateway. `starter` is the free tier: a row so invoices and the plans page
 * can name it, never sold.
 */
const PLANS = [
  { code: 'starter', credits: 30, usd: 0, ngn: 0, gbp: 0, sort: 0, active: false },
  { code: 'creator', credits: 600, usd: 9, ngn: 12000, gbp: 7, sort: 10, active: true },
  { code: 'business', credits: 2400, usd: 29, ngn: 39000, gbp: 24, sort: 20, active: true },
  { code: 'org', credits: 12000, usd: 199, ngn: 265000, gbp: 165, sort: 30, active: true },
];

/** One-time top-ups. Priced a little above the plan rate, so the plan is the better deal. */
const PACKS = [
  { code: 'pack.small', credits: 200, usd: 4, ngn: 5000, gbp: 3, sort: 10 },
  { code: 'pack.medium', credits: 600, usd: 10, ngn: 13500, gbp: 8, sort: 20 },
  { code: 'pack.large', credits: 2000, usd: 29, ngn: 39000, gbp: 24, sort: 30 },
  { code: 'pack.video', credits: 6000, usd: 79, ngn: 105000, gbp: 65, sort: 40 },
];

/**
 * The organization rate card: minor units per 100 credits for postpaid
 * accounts without a negotiated rate. Sits just under the biggest pack
 * (pack.video works out at 1.3¢ / ₦17.5 per credit), because an invoiced
 * organization is committing to volume, not buying a bundle.
 */
const USAGE_RATES = [
  { currency: 'USD', per100Minor: 125 }, // $1.25 per 100 credits
  { currency: 'GBP', per100Minor: 100 }, // £1.00
  { currency: 'NGN', per100Minor: 160000 }, // ₦1,600
  { currency: 'GHS', per100Minor: 1600 }, // GH₵16
  { currency: 'KES', per100Minor: 16000 }, // KSh160
  { currency: 'ZAR', per100Minor: 2300 }, // R23
];

/**
 * Provider routing. `priority` picks the default and the fallback order, so a
 * failing provider is demoted from the admin console without a release.
 *
 * `costPerCall` is OUR cost in minor units of USD (cents), from the vendor's
 * September 2026 price list — the input to the margin figure. `config` is
 * what the adapter reads: the vendor's model id and any defaults. A row is
 * only `enabled` once its `licenceNote` records that reselling the output to
 * customers is permitted; a row with no note is routable in dev and nowhere
 * else. See docs/PROVIDERS.md for the reasoning behind each choice.
 *
 * `workspaceType` narrows a row to one tier. Background removal is the worked
 * example: BiRefNet is 36× cheaper, Bria is trained only on licensed data, and
 * an ORGANIZATION customer's procurement team asks about exactly that.
 */
const PROVIDERS: Array<{
  key: string;
  capability: ProviderCapability;
  priority: number;
  costPerCall: number;
  enabled: boolean;
  workspaceType?: WorkspaceType;
  config?: Prisma.InputJsonObject;
  licenceNote?: string;
}> = [
  // ---- image editing: put the product in a new scene, keep it identical ----
  {
    key: 'fal:flux-2-pro-edit',
    capability: 'IMAGE_EDIT',
    priority: 5,
    // Conservative reservation used by the live comparison, not an invoice.
    costPerCall: 30,
    enabled: true,
    config: { endpoint: 'fal-ai/flux-2-pro/edit' },
    licenceNote: 'FLUX.2 Pro Edit via fal; selected after development comparison.',
  },
  {
    key: 'vertex:gemini-3-pro-image',
    capability: 'IMAGE_EDIT',
    priority: 20,
    costPerCall: 13,
    enabled: true,
    config: { model: 'gemini-3-pro-image' },
    licenceNote: 'Google Cloud generative AI indemnification covers GA Vertex models; paid-tier inputs are not used for training. Checked 2026-09-04.',
  },
  {
    key: 'fal:seedream-4.5-edit',
    capability: 'IMAGE_EDIT',
    priority: 10,
    costPerCall: 4,
    enabled: true,
    config: { endpoint: 'fal-ai/bytedance/seedream/v4.5/edit' },
    licenceNote: 'fal.ai commercial terms; output ownership retained by caller. ByteDance enterprise terms not separately verified. Checked 2026-09-04.',
  },
  {
    key: 'bfl:flux-kontext-pro',
    capability: 'IMAGE_EDIT',
    priority: 30,
    costPerCall: 4,
    enabled: true,
    config: { endpoint: 'flux-kontext-pro' },
    licenceNote: 'BFL paid API grants commercial rights on outputs. Checked 2026-09-04.',
  },

  // ---- image generation: scenes, flyers, posters --------------------------
  {
    key: 'vertex:gemini-3-pro-image',
    capability: 'IMAGE_GENERATE',
    priority: 10,
    costPerCall: 13,
    enabled: true,
    config: { model: 'gemini-3-pro-image' },
    licenceNote: 'As above. Checked 2026-09-04.',
  },
  {
    key: 'fal:flux-2-pro',
    capability: 'IMAGE_GENERATE',
    priority: 20,
    costPerCall: 5,
    enabled: true,
    config: { endpoint: 'fal-ai/flux-2-pro' },
    licenceNote: 'BFL commercial licence via fal.ai. Checked 2026-09-04.',
  },

  // ---- background removal ---------------------------------------------------
  {
    key: 'replicate:birefnet',
    capability: 'BACKGROUND_REMOVE',
    priority: 30,
    costPerCall: 1,
    enabled: true,
    config: { model: '851-labs/background-remover' },
    licenceNote: 'BiRefNet weights MIT-family; training-data provenance not documented — not for the ORGANIZATION tier. Checked 2026-09-04.',
  },
  {
    key: 'fal:bria-rmbg-2',
    capability: 'BACKGROUND_REMOVE',
    priority: 5,
    costPerCall: 2,
    enabled: true,
    workspaceType: 'ORGANIZATION',
    config: { endpoint: 'fal-ai/bria/background/remove' },
    licenceNote: 'Bria trains only on licensed data and sells enterprise resale terms. Checked 2026-09-04.',
  },
  // Commerce-specific cutouts first; BiRefNet remains an available fallback.
  // (Bria cannot appear twice: a row is keyed on vendor + capability.)
  {
    key: 'photoroom:edit',
    capability: 'BACKGROUND_REMOVE',
    priority: 10,
    costPerCall: 2,
    enabled: true,
    config: {},
    licenceNote: 'Photoroom API is sold for embedding in third-party products. Checked 2026-09-04.',
  },

  // ---- background replace, relight, shadow ---------------------------------
  {
    key: 'photoroom:edit',
    capability: 'BACKGROUND_REPLACE',
    priority: 10,
    costPerCall: 10,
    enabled: true,
    config: { shadow: 'ai.soft', relight: true },
    licenceNote: 'Photoroom API is sold for embedding in third-party products. Checked 2026-09-04.',
  },
  {
    key: 'vertex:gemini-3-pro-image',
    capability: 'BACKGROUND_REPLACE',
    priority: 20,
    costPerCall: 13,
    enabled: true,
    config: { model: 'gemini-3-pro-image' },
    licenceNote: 'As above.',
  },
  { key: 'photoroom:edit', capability: 'RELIGHT', priority: 10, costPerCall: 10, enabled: true, config: { relight: true }, licenceNote: 'As above.' },
  // Gemini relights by instruction — a good result, a little less controllable
  // than Photoroom's, so it takes the call when Photoroom has no key here.
  {
    key: 'vertex:gemini-3-pro-image',
    capability: 'RELIGHT',
    priority: 20,
    costPerCall: 13,
    enabled: true,
    config: { model: 'gemini-3-pro-image' },
    licenceNote: 'As above.',
  },

  // ---- upscale ---------------------------------------------------------------
  {
    key: 'fal:clarity-upscaler',
    capability: 'UPSCALE',
    priority: 10,
    costPerCall: 6,
    enabled: true,
    config: { endpoint: 'fal-ai/clarity-upscaler' },
    licenceNote: 'Open weights served under fal.ai commercial terms. Checked 2026-09-04.',
  },

  // ---- image to video --------------------------------------------------------
  // Fal/Kling first for reels and UGC product footage; HeyGen separately renders
  // the UGC presenter. Veo is the independent fallback for eligible failures.
  // This is a product routing choice, not a claim of benchmark supremacy.
  // Sora is disabled ahead of its permanent API
  // shutdown on 2026-09-24; keeping the row preserves historical attribution.
  {
    key: 'fal:kling-3-pro-i2v',
    capability: 'IMAGE_TO_VIDEO',
    priority: 5,
    costPerCall: 135,
    enabled: true,
    config: { endpoint: 'fal-ai/kling-video/v3/pro/image-to-video', costPerSecondMinor: 16.8, costPerSecondSilentMinor: 11.2 },
    licenceNote:
      'fal endpoint lists commercial use. $0.168/s with native audio, $0.112/s without; no voice-control surcharge used. Checked 2026-09-09. Separate from Higgsfield licensing.',
  },
  {
    key: 'fal:wan-2.5-i2v',
    capability: 'IMAGE_TO_VIDEO',
    priority: 10,
    costPerCall: 80,
    enabled: true,
    config: { endpoint: 'fal-ai/wan-25-preview/image-to-video', resolution: '720p', costPerSecondMinor: 10 },
    licenceNote: 'Open-weight lineage served under fal.ai commercial terms. Checked 2026-09-04.',
  },
  {
    key: 'openai:sora-2',
    capability: 'IMAGE_TO_VIDEO',
    priority: 90,
    costPerCall: 80,
    enabled: false,
    config: { model: 'sora-2' },
    licenceNote: 'Disabled ahead of the Sora API permanent shutdown on 2026-09-24; retained only for historical attribution. Checked 2026-09-08.',
  },
  {
    key: 'vertex:veo-3.1-fast',
    capability: 'IMAGE_TO_VIDEO',
    priority: 20,
    costPerCall: 80,
    enabled: true,
    // Vertex and the Gemini Developer API currently use different Veo ids;
    // the adapter selects the right one from the configured credential door.
    config: { resolution: '720p', costPerSecondMinor: 10 },
    licenceNote: 'Google Cloud generative AI terms; Veo 3.1 Fast at 720p is $0.10/s with native audio. Checked 2026-09-08.',
  },
  // Higgsfield's own DoP models (not Kling — a different row). Off until
  // their resale terms are on file; the adapter is ready.
  {
    key: 'higgsfield:dop-turbo',
    capability: 'IMAGE_TO_VIDEO',
    priority: 40,
    costPerCall: 60,
    enabled: false,
    config: { model: 'dop-turbo' },
    licenceNote: 'Higgsfield platform terms not yet reviewed for resale; enable after confirmation. Checked 2026-09-04.',
  },
  // Kling: cheapest per second in the market and NOT routable. Its terms (§4.6)
  // forbid commercial use of outputs without written permission and (§4.5)
  // require "Kling AI" attribution. Enable only with that permission on file.
  {
    key: 'higgsfield:kling3_0',
    capability: 'IMAGE_TO_VIDEO',
    priority: 90,
    costPerCall: 31,
    enabled: false,
    licenceNote:
      'BLOCKED: Kling ToS §4.6 forbids commercial use of outputs without written permission; §4.5 requires attribution. Ask Higgsfield whether their route carries a pass-through licence. Checked 2026-09-04.',
  },

  // ---- copy ------------------------------------------------------------------
  {
    key: 'google:gemini-3.5-flash-lite',
    capability: 'TEXT_GENERATE',
    priority: 10,
    costPerCall: 1,
    enabled: true,
    config: { model: 'gemini-3.5-flash-lite' },
    licenceNote: 'Gemini API paid tier; outputs owned by caller. Model renamed 2026-09-07: 2.5-flash-lite now 404s for new callers.',
  },
  {
    key: 'anthropic:claude-haiku-4.5',
    capability: 'TEXT_GENERATE',
    priority: 20,
    costPerCall: 2,
    enabled: true,
    config: { model: 'claude-haiku-4-5' },
    licenceNote: 'Anthropic commercial terms; outputs owned by caller. Checked 2026-09-04.',
  },

  // ---- stitching is ours: ffmpeg in the worker, no vendor ----------------------
  { key: 'local:ffmpeg', capability: 'VIDEO_STITCH', priority: 10, costPerCall: 0, enabled: true, licenceNote: 'No third party involved.' },
  {
    key: 'photoroom:edit',
    capability: 'PRODUCT_SHOT',
    priority: 10,
    costPerCall: 10,
    enabled: true,
    licenceNote: 'Photoroom Plus tier. Their own foundation model; output is ours to sell.',
  },

  // ---- later phases: declared so the router knows they exist, disabled -------
  // ---- audio (Phase 10) --------------------------------------------------------
  {
    key: 'elevenlabs:music',
    capability: 'MUSIC',
    priority: 10,
    // Default MUSIC duration is 120 seconds. The adapter replaces this
    // estimate with the exact duration cost on success.
    costPerCall: 30,
    enabled: true,
    config: { model: 'music_v2', outputFormat: 'mp3_44100_128', costPerMinuteMinor: 15 },
    licenceNote:
      'Eleven Music: cleared for commercial use incl. ads and social video on paid plans (elevenlabs.io/music-terms). $0.15/generated minute on the API pricing page. Refuses artist names. Checked 2026-09-08.',
  },
  {
    key: 'fal:minimax-music-v2',
    capability: 'MUSIC',
    priority: 20,
    costPerCall: 3,
    enabled: true,
    config: { endpoint: 'fal-ai/minimax-music/v2' },
    licenceNote: 'MiniMax Music v2 via fal: fal lists "Commercial use" on the model page. Lyrics with [Verse]/[Chorus] tags. Checked 2026-09-05.',
  },
  {
    key: 'elevenlabs:tts',
    capability: 'VOICEOVER',
    priority: 10,
    costPerCall: 5,
    enabled: true,
    config: { model: 'eleven_multilingual_v2', outputFormat: 'mp3_44100_128' },
    licenceNote: 'Commercial from Starter tier. 29+ languages; no Yoruba/Igbo/Hausa — see spitch. Checked 2026-09-05.',
  },
  {
    key: 'google:tts',
    capability: 'VOICEOVER',
    priority: 20,
    costPerCall: 2,
    enabled: true,
    licenceNote:
      "Google Cloud Text-to-Speech; needs a service account with the TTS API enabled. Only voice ids in Google's published catalogue are active; the previously seeded en-NG/en-KE/en-ZA ids are retained disabled. Standard commercial terms. Checked 2026-09-07.",
  },
  {
    key: 'openai:tts',
    capability: 'VOICEOVER',
    priority: 30,
    costPerCall: 2,
    enabled: true,
    config: { model: 'gpt-4o-mini-tts' },
    licenceNote: 'OpenAI TTS; output usable commercially under the API terms. Checked 2026-09-05.',
  },
  {
    key: 'spitch:tts',
    capability: 'VOICEOVER',
    priority: 40,
    costPerCall: 5,
    enabled: false,
    licenceNote: 'Yoruba, Igbo, Hausa. Priced by direct quote; not yet on contract.',
  },
  {
    key: 'mubert:track',
    capability: 'MUSIC',
    priority: 30,
    costPerCall: 15,
    enabled: false,
    licenceNote: 'Paid tiers include sub-licensing and monetized content. Not yet on contract.',
  },
  // ---- dubbing and lip-sync (Phase 11) ------------------------------------------
  // The runner narrows DUB to the vendors that speak the target language and
  // puts HeyGen first when the lips must move (it does both in one pass);
  // otherwise ElevenLabs dubs the sound and a LIPSYNC row finishes the job.
  {
    key: 'elevenlabs:dubbing-v1',
    capability: 'DUB',
    priority: 10,
    costPerCall: 50,
    enabled: true,
    config: { watermark: 'false', highestResolution: 'true' },
    licenceNote:
      'ElevenLabs Dubbing: ~$0.50–1.00/min, 30 languages, voice preserved; commercial on paid plans. No African languages beyond Arabic/French/Portuguese. Checked 2026-09-05.',
  },
  {
    key: 'heygen:translate',
    capability: 'DUB',
    priority: 20,
    costPerCall: 190,
    enabled: true,
    config: {},
    licenceNote:
      'HeyGen Video Translate v3: 175+ languages incl. English (Nigeria/Kenya/SA), Swahili, Zulu, Amharic; lip resync built in. Credits per minute on the API plan; commercial use on paid plans. Consent terms apply to real faces. Checked 2026-09-05.',
  },
  {
    key: 'fal:sync-lipsync',
    capability: 'LIPSYNC',
    priority: 10,
    costPerCall: 120,
    enabled: true,
    config: { endpoint: 'fal-ai/sync-lipsync/v2', syncMode: 'cut_off' },
    licenceNote: 'sync.so lipsync-2 via fal; billed per second of output. Commercial use per fal terms. Checked 2026-09-05.',
  },
  {
    key: 'heygen:lipsync',
    capability: 'LIPSYNC',
    priority: 20,
    costPerCall: 190,
    enabled: true,
    config: {},
    licenceNote: 'HeyGen Lipsync v3. Same plan and consent terms as translate. Checked 2026-09-05.',
  },
  {
    key: 'sync:lipsync-2',
    capability: 'LIPSYNC',
    priority: 30,
    costPerCall: 260,
    enabled: false,
    licenceNote: 'sync.so direct; needs SYNC_API_KEY and a contract. Registered but off until then.',
  },
];

async function reference() {
  for (const c of CREDIT_COSTS) {
    await db.creditCost.upsert({ where: { code: c.code }, create: c, update: c });
  }
  for (const p of PLANS) {
    await db.plan.upsert({
      where: { code: p.code },
      create: {
        code: p.code,
        credits: p.credits,
        priceByMarket: { USD: p.usd, NGN: p.ngn, GBP: p.gbp },
        yearlyPriceByMarket: p.usd ? { USD: p.usd * 10, NGN: p.ngn * 10, GBP: p.gbp * 10 } : undefined,
        sort: p.sort,
        active: p.active,
      },
      update: {
        credits: p.credits,
        priceByMarket: { USD: p.usd, NGN: p.ngn, GBP: p.gbp },
        yearlyPriceByMarket: p.usd ? { USD: p.usd * 10, NGN: p.ngn * 10, GBP: p.gbp * 10 } : undefined,
        sort: p.sort,
        active: p.active,
      },
    });
  }
  for (const k of PACKS) {
    await db.creditPack.upsert({
      where: { code: k.code },
      create: { code: k.code, credits: k.credits, priceByMarket: { USD: k.usd, NGN: k.ngn, GBP: k.gbp }, sort: k.sort },
      update: { credits: k.credits, priceByMarket: { USD: k.usd, NGN: k.ngn, GBP: k.gbp }, sort: k.sort },
    });
  }
  for (const r of USAGE_RATES) {
    await db.usageRate.upsert({ where: { currency: r.currency }, create: r, update: { per100Minor: r.per100Minor } });
  }
  for (const pr of PROVIDERS) {
    const previous = await db.providerModel.findUnique({ where: { key_capability: { key: pr.key, capability: pr.capability } }, select: { config: true } });
    const oldConfig = previous?.config as Prisma.JsonObject | null;
    const config = {
      ...((pr.config as Prisma.JsonObject) ?? {}),
      ...(typeof oldConfig?.scenePriority === 'number' ? { scenePriority: oldConfig.scenePriority } : {}),
      ...(typeof oldConfig?.sceneAcceptance === 'number' ? { sceneAcceptance: oldConfig.sceneAcceptance } : {}),
      ...(oldConfig?.preservationAcceptance && typeof oldConfig.preservationAcceptance === 'object'
        ? { preservationAcceptance: oldConfig.preservationAcceptance }
        : {}),
    };
    await db.providerModel.upsert({
      where: { key_capability: { key: pr.key, capability: pr.capability } },
      create: pr,
      // `enabled` and `priority` are operator-owned after first creation. A
      // release may refresh model config/cost/licensing metadata, but must not
      // undo an outage kill switch or a deliberate routing change.
      update: { costPerCall: pr.costPerCall, workspaceType: pr.workspaceType, config, licenceNote: pr.licenceNote },
    });
  }
  for (const gsd of GENRES) {
    const data = {
      name: gsd.name,
      region: gsd.region,
      family: gsd.family,
      description: gsd.description,
      promptHints: gsd.promptHints,
      bpmMin: gsd.bpm?.[0],
      bpmMax: gsd.bpm?.[1],
      languages: gsd.languages,
      sort: gsd.sort,
    };
    await db.musicGenre.upsert({ where: { key: gsd.key }, create: { key: gsd.key, ...data }, update: data });
  }
  for (const vs of VOICES) {
    const data = {
      providerKey: vs.providerKey,
      providerVoiceId: vs.providerVoiceId,
      name: vs.name,
      language: vs.language,
      accent: vs.accent,
      gender: vs.gender,
      tags: vs.tags,
      sort: vs.sort,
      ...(vs.active === undefined ? {} : { active: vs.active }),
    };
    await db.voiceProfile.upsert({ where: { key: vs.key }, create: { key: vs.key, ...data }, update: data });
  }
  console.log(
    `reference: ${CREDIT_COSTS.length} costs, ${PLANS.length} plans, ${PACKS.length} packs, ${USAGE_RATES.length} rates, ${PROVIDERS.length} models, ${GENRES.length} genres, ${VOICES.length} voices`,
  );
}

async function fixtures() {
  // A developer account that is BOTH a customer and staff — the exact shape the
  // policy layer has to handle, so it is wrong to only ever test them apart.
  const dev = await db.user.upsert({
    where: { email: 'dev@anystudio.test' },
    create: {
      email: 'dev@anystudio.test',
      phone: '+2348000000001',
      name: 'Dev Account',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      phoneIsWhatsApp: true,
    },
    update: {},
  });

  const ws = await db.workspace.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'BUSINESS',
      name: 'Bimbo Fabrics',
      region: 'ng',
      currency: 'NGN',
    },
    update: {},
  });

  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: ws.id, userId: dev.id } },
    create: { workspaceId: ws.id, userId: dev.id, role: 'OWNER' },
    update: {},
  });

  // A wallet with credits in it, moved through the same Postgres function as
  // every real movement — the seed gets no back door into the ledger either.
  // The idempotency key makes a second seed run a no-op rather than a second grant.
  await db.wallet.upsert({
    where: { workspaceId: ws.id },
    create: { id: DEV_WALLET_ID, workspaceId: ws.id, currency: 'NGN' },
    update: {},
  });
  await db.$queryRaw`
    SELECT * FROM ledger_apply(
      ${DEV_WALLET_ID}::uuid, 'PROMO'::"LedgerKind", 1000, 'seed:dev-wallet', NULL::uuid, 'Seeded development credits', NULL::uuid
    )`;

  // Staff access on the SAME user. Note grantedById is the user itself here,
  // which the policy layer forbids at runtime — acceptable only as a bootstrap,
  // and it is exactly why real grants record who issued them.
  await db.staffGrant.upsert({
    where: { id: '00000000-0000-4000-8000-000000000002' },
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      userId: dev.id,
      role: 'SUPERADMIN',
      grantedById: dev.id,
      reason: 'local development bootstrap',
    },
    update: {},
  });

  console.log(`fixtures: dev@anystudio.test / ${DEV_PASSWORD} — owner of Bimbo Fabrics (1000 credits) AND superadmin`);
  console.log('          use it to check that the console refuses to action its own workspace');
}

/**
 * The first staff member. Nobody can grant themselves staff access from the
 * console, so the very first SUPERADMIN comes from the environment: set
 * BOOTSTRAP_SUPERADMIN_EMAIL to an account that exists (and has a second
 * factor), run the seed once, remove the variable. Re-running is a no-op
 * while the grant stands.
 */
async function bootstrapStaff() {
  const email = process.env.BOOTSTRAP_SUPERADMIN_EMAIL?.toLowerCase();
  if (!email) return;
  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.log(`bootstrap staff: no account for ${email}; sign up first, then seed again`);
    return;
  }
  const existing = await db.staffGrant.findFirst({ where: { userId: user.id, revokedAt: null } });
  if (existing) {
    console.log(`bootstrap staff: ${email} already holds ${existing.role}`);
    return;
  }
  await db.staffGrant.create({ data: { userId: user.id, role: 'SUPERADMIN', grantedById: user.id, reason: 'bootstrap from BOOTSTRAP_SUPERADMIN_EMAIL' } });
  console.log(`bootstrap staff: ${email} is SUPERADMIN. Remove BOOTSTRAP_SUPERADMIN_EMAIL from the environment.`);
}

async function main() {
  await reference();
  await bootstrapStaff();

  const env = process.env.SEED_ENV;
  if (env === 'dev') {
    await fixtures();
  } else if (process.env.NODE_ENV === 'production' && env) {
    // Loud, not silent. A production database with demo accounts in it is a
    // security finding, not a tidiness problem.
    throw new Error(`Refusing to seed fixtures in production (SEED_ENV=${env})`);
  } else {
    console.log('fixtures: skipped (set SEED_ENV=dev to include them)');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
