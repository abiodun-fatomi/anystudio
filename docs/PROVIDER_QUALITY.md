# Quality routing review — 2026-09-08

These are engineering recommendations among **already integrated providers**,
not an independent benchmark or a promise that one model always wins. Vendor
documentation establishes capabilities, not comparative win rates. No paid
generations were run during this review. Existing commercial/account gates
have not been re-certified or relaxed. New model families need adapter tests,
account/terms review and a representative visual evaluation before activation.

## Selected order

| Use case                                                                                                   | Preferred order                                                                                    | Rationale / evidence                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flyers, posters, typography; new or reference-photo designs                                                | Gemini 3 Pro Image; then FLUX.2 Pro for generation, Seedream 4.5 Edit then Kontext Pro for editing | Google's [image guidance](https://ai.google.dev/gemini-api/docs/image-generation) covers text rendering, layout and editing. Keep exact dates/prices/logos in deterministic overlays where possible; generated spelling still needs review.                                                                                                                                      |
| Photographic generation (`useCase: photography`)                                                           | FLUX.2 Pro → Gemini                                                                                | BFL documents [photorealistic production imagery and product photography](https://bfl.ai/models/flux-2). This preference is an inference from task fit, not a head-to-head victory claim.                                                                                                                                                                                        |
| Product-reference / new-scene editing (default IMAGE_EDIT)                                                 | Seedream 4.5 Edit → Gemini → Kontext Pro                                                           | [Seedream's identity/detail preservation](https://blog.fal.ai/seedream-4-5-is-now-available-on-fal/) fits reference-led commerce. [Kontext](https://bfl.ai/blog/flux-1-kontext) remains useful for targeted edits; do not mistake previous-generation status for an unavailable model.                                                                                           |
| Cutouts, personal/business                                                                                 | Photoroom → BiRefNet                                                                               | Prefer a [commerce-specialized image API](https://www.photoroom.com/api) over the previous cost-led default. This is not a measured segmentation accuracy comparison.                                                                                                                                                                                                            |
| Cutouts, organization                                                                                      | BRIA RMBG 2 → Photoroom → existing eligible fallback                                               | Retain the existing organization-only [BRIA route](https://fal.ai/models/fal-ai/bria/background/remove); no workspace eligibility changes. Current behavior is a preference, not a hard enterprise-only allowlist.                                                                                                                                                               |
| Background replacement / relighting                                                                        | Photoroom → Gemini                                                                                 | Specialist background and lighting controls; retain existing order.                                                                                                                                                                                                                                                                                                              |
| Merchant shots: on-model, ghost mannequin, flat lay, ironing, beautify, text removal, free edit, expansion | Photoroom                                                                                          | Only integrated PRODUCT_SHOT provider. Generic image adapters do not implement the same mode contract and are not interchangeable fallbacks.                                                                                                                                                                                                                                     |
| Upscale                                                                                                    | Clarity                                                                                            | Only integrated upscaler. [Creativity controls](https://fal.ai/models/fal-ai/clarity-upscaler/api) imply possible invented detail; do not promise restoration of true labels or fine print.                                                                                                                                                                                      |
| Image-to-video / product ads                                                                               | Veo 3.1 Fast → Wan 2.5                                                                             | Retain order: [Veo](https://ai.google.dev/gemini-api/docs/veo) supports image-led video and native audio; [Wan](https://fal.ai/models/fal-ai/wan-25-preview/image-to-video/api) is an independent fallback. No evidence here proves Wan should replace Veo globally. Full Veo, newer Wan/Kling and other unintegrated models were not enabled.                                   |
| Copy and shot planning                                                                                     | Gemini 3.5 Flash-Lite → Haiku 4.5                                                                  | Retained: both are small/fast models. [Gemini model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) and [Haiku's system card](https://assets.anthropic.com/m/99128ddd009bdcb/Claude-Haiku-4-5-System-Card.pdf) do not establish a creative-writing winner for our prompts. Premium writing models require a separate adapter/cost evaluation. |
| Voiceover                                                                                                  | Selected voice's provider only                                                                     | [ElevenLabs TTS](https://elevenlabs.io/docs/overview/capabilities/text-to-speech) remains the primary catalogue family; changing vendors cannot preserve a vendor-owned voice identity. No cross-voice fallback.                                                                                                                                                                 |
| Music                                                                                                      | Eleven Music → MiniMax Music v2                                                                    | Keep [Eleven Music's structure, vocal/instrumental and multilingual controls](https://elevenlabs.io/docs/overview/capabilities/music); MiniMax is the existing alternative. Plan-specific music terms still apply.                                                                                                                                                               |
| Dubbing without lip animation                                                                              | ElevenLabs → HeyGen, language-filtered                                                             | [Speaker preservation](https://elevenlabs.io/docs/overview/capabilities/dubbing) supports the current choice. Newer vendor documentation does not automatically expand the language list supported by our v1 adapter.                                                                                                                                                            |
| Dubbing with lip animation                                                                                 | HeyGen first, language-filtered                                                                    | [Integrated translation and lip synchronization](https://www.heygen.com/translate) avoids a separate lip-sync pass when available.                                                                                                                                                                                                                                               |
| Existing-video lip-sync                                                                                    | Sync via fal → HeyGen                                                                              | Retain integrated specialist [Sync Lipsync 2](https://fal.ai/models/fal-ai/sync-lipsync/v2). Direct Sync remains disabled.                                                                                                                                                                                                                                                       |
| Collage, branding, crops, final video assembly                                                             | Local deterministic pipelines                                                                      | No AI rank: these are layout/rendering operations. Batch uses each child's capability routing. Voice cloning, presenters and voice conversion retain vendor ownership/consent constraints.                                                                                                                                                                                       |

## Implementation and API

`IMAGE_GENERATE` and `IMAGE_EDIT` accept optional `useCase: "design"` or
`"photography"`. The Flyer UI sends `design` on both its new-image and
reference-photo paths. Untagged image generation retains Gemini first;
untagged image editing uses the new Seedream-first database default. Existing
clients remain valid. We do not guess intent from words inside a prompt.

Example generation params:

```json
{
  "prompt": "A photorealistic ceramic mug on a linen table",
  "aspect": "4:5",
  "count": 1,
  "useCase": "photography"
}
```

Example flyer edit params (use a real uploaded object key):

```json
{
  "sourceKey": "your-uploaded-object-key",
  "prompt": "Design a launch flyer around this product",
  "aspect": "4:5",
  "preserveProduct": true,
  "useCase": "design"
}
```

Explicit intent uses the router's existing `prefer` mechanism; it outranks
numeric priority for that request only. Administrative `enabled=false`, missing
credentials, workspace filtering, breakers and `only`/`exclude` constraints
still apply. For untagged requests, numeric priorities remain authoritative.
No fallback is added for content/request rejection or ambiguous submission.

The one-time `20260922000006_quality_routing` migration updates only the four
old default priorities. Non-default priorities and disabled flags are retained.
Seed creation matches the new defaults, but seed updates still leave operator
priorities alone. A value manually set equal to an old default cannot be
distinguished from the default; review those four rows before migration.
No database, deployment or provider-account settings were changed by this review.

## Release validation still required

Run API/schema/router/UI tests, then deploy the migrations and worker together.
Check actual routed provider keys: missing keys may change the effective order.
Before calling this production-quality, run an approved, budgeted comparison
on real products (dark/transparent bottles, labels, clothing), flyers with exact
dates/prices, and video prompts. Blind-score identity, spelling, composition,
motion/flicker, latency, refunds and provider cost. Do not raise quality scores
or relax safety/licensing rules just to make a candidate win.
