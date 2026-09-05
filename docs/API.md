# The AnyStudio API

Everything the studio makes, from your own code. One key, one base URL,
the same pipelines and prices the web studio uses.

    Base URL   https://api.anystudio.ai/api/v1      (api.dev.… / api.staging.… per environment)
    Auth       Authorization: Bearer as_live_…      (as_test_… outside production)
    Envelope   { "status": 201, "message": "…", "data": { … } }
    Errors     { "status": 400, "code": "invalid_input", "message": "…", "fields": { "params.prompt": "…" } }
    Docs       https://api.anystudio.ai/api/v1/docs (interactive; every route, every field)

Keys are minted in the portal (**Developer → API keys**), belong to a
project, carry scopes, and are shown once. Send them from a server; never
from a browser or an app.

## The loop

1. **Put a file in.** `POST /uploads/from-url` with a public HTTPS URL, or
   `POST /uploads` for a presigned PUT followed by
   `POST /uploads/{id}/complete`. Either way you get a storage `key`.
2. **Ask.** `POST /generations` with a `capability`, its `params`, your
   `clientKey` (idempotency) and, if you serve many merchants, a
   `merchantRef`. Credits are held; `402` when there are none.
3. **Hear back.** `GET /generations/{id}` until `status` is `SUCCEEDED` or
   `FAILED`, or add a webhook endpoint and receive the same object. Output
   URLs are signed and last an hour.

## Routes

| Method | Path | Scope | What |
|---|---|---|---|
| GET | `/capabilities` | catalogue:read | Every capability with its price and the params it takes (name, type, required, default, enum values) — derived from the validators, never stale |
| GET | `/balance` | balance:read | `{ credits, currency }` |
| POST | `/uploads/from-url` | media:write | `{ url }` → we fetch it (HTTPS, public, image/video/audio, size limits as the studio) |
| POST | `/uploads` | media:write | `{ filename, mime, bytes }` → `{ url, method, headers }` for a presigned PUT |
| POST | `/uploads/{id}/complete` | media:write | Verify the object; it becomes usable |
| POST | `/generations` | generations:write | `{ capability, params, clientKey?, merchantRef?, costCode? }` → `{ generation, balance }` (201) |
| GET | `/generations` | generations:read | This key's project, newest first; `?limit=&cursor=&merchantRef=` |
| GET | `/generations/{id}` | generations:read | The generation with signed `url` on every output |
| POST | `/generations/{id}/cancel` | generations:write | Only while `QUEUED`; credits back |
| POST | `/generations/{id}/unlock` | generations:write | Pay for the rest of a song |
| GET | `/audio/genres`, `/audio/voices`, `/audio/dub-languages` | catalogue:read | The catalogues the studio's pickers use |

A key sees its own project's generations and nothing from a sibling
project. Revoked keys get `401`; a missing scope gets `403`.

## Capabilities

| Capability | Default price | Notes |
|---|---|---|
| `IMAGE_EDIT` | 10 | `sourceKey`, `prompt` (where the product should be), `aspect`, `sizes[]`, `price`, `businessName`. The product is kept pixel-identical; the brand kit is applied |
| `BACKGROUND_REMOVE` | 2 | `sourceKey`, `background: "transparent" \| "#RRGGBB"` |
| `BACKGROUND_REPLACE` | 10 | `sourceKey`, `prompt`, `shadow`, `relight` |
| `UPSCALE` | 3 | `sourceKey`, `factor: 2 \| 4` |
| `IMAGE_GENERATE` | 10 | `prompt`, `aspect`, `style`, `count` |
| `TEXT_GENERATE` | 2 | `productName`, `details`, `price`, `language`, `platforms[]`; returns description, captions per platform, hashtags, alt text, SEO |
| `IMAGE_TO_VIDEO` | 120 (reel) · 260 / 480 (15 s / 30 s ad via `costCode`) | `sourceKey`, `prompt`, `shots: 1 \| 2 \| 4`, `format`, `durationSec`, `aspect` |
| `VOICEOVER` | 8 | `script`, `voiceId` (from `/audio/voices`), `style`, `speed` |
| `MUSIC` | 10 preview + 30 unlock | `brief`, `genre` (from `/audio/genres`), `vocal`, `language`, `durationSec`, optional `lyrics`. Returns a 30-second `preview` and a locked `audio`; `/unlock` opens it |
| `DUB` | 90 · 240 with lips | `sourceKey` (video), `targetLanguage` (from `/audio/dub-languages`), `lipsync`, `speakers`, `keepBackground`, `quality`, **`consent: true`** |
| `LIPSYNC` | 150 | `sourceKey` (video), `audioKey` **or** `script` + `voiceId`, `quality`, **`consent: true`** |

`GET /capabilities` is the source of truth for the exact fields.

## The generation object

```json
{
  "id": "0d0e…", "status": "SUCCEEDED", "capability": "IMAGE_EDIT",
  "clientKey": "order-8812-hero", "merchantRef": "store-441", "projectId": "…",
  "credits": 10, "costCode": "image.storefront",
  "createdAt": "…", "finishedAt": "…",
  "outputs": [
    { "role": "image",   "mime": "image/jpeg", "width": 1080, "height": 1080, "key": "…", "url": "https://…" },
    { "role": "variant", "size": "story", "mime": "image/jpeg", "width": 1080, "height": 1920, "key": "…", "url": "https://…" },
    { "role": "text",    "mime": "application/json", "text": { "captions": { "instagram": "…" } } }
  ],
  "urlsExpireInSec": 3600
}
```

A failed one carries `"failure": { "kind": "CONTENT_REJECTED", "message": "…" }`
— `message` is written to be shown to a merchant; credits are already back.
A locked song track has `"locked": true` and an empty `key`/`url` until
unlocked.

## Webhooks

Add an endpoint in **Developer → Webhooks** (HTTPS, public). Events:
`generation.succeeded`, `generation.failed`; a `ping` from the portal's
test button. The body:

```json
{ "id": "evt_…", "type": "generation.succeeded", "createdAt": "…", "data": { …the generation object… } }
```

Headers: `X-AnyStudio-Event`, `X-AnyStudio-Delivery` (unique per attempt
series) and `X-AnyStudio-Signature: t=<unix seconds>,v1=<hex>` where `v1`
is HMAC-SHA256 of `"<t>.<raw body>"` with the endpoint's secret. Reject
anything older than five minutes. Answer `2xx` within ten seconds and do
the work afterwards; anything else is retried with a doubling backoff from
one minute, eight times. Twenty consecutive failures pause the endpoint;
resume it from the portal, where every delivery and its body can be
replayed.

## Limits

- `POST /generations`: 60/min per key, 10/min per `merchantRef`.
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and
  `Retry-After` on every answer.
- Twenty videos per workspace per rolling day (raised per customer).
- Files: images 25 MB, video 250 MB, audio 30 MB; dubs up to five minutes,
  lip-syncs up to three.
- Fifty active keys and twenty endpoints per workspace.

## Idempotency

Same `clientKey` → same generation, charged once. Omit it and one is minted
per request. Use your own order or job id; it is stored on the row and
returned in every object and webhook.
