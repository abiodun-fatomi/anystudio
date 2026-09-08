# The AnyStudio organization API

Base URL: `https://api.anystudio.ai/api/v1` (use your development/staging host in those environments).
Send `Authorization: Bearer as_live_…` from your server. Keys are created under
**Developer → API keys**, belong to a project and are shown once. Test-prefixed
keys are environment credentials, not a free-payment or free-generation sandbox.

The production reference is **Developer → Docs**. Interactive Swagger is
available only outside production. All paths below are relative to the base URL.

## Response contract

Success: `{ "status": 201, "message": "…", "data": { … } }`.
Validation errors use `error`, not `code`; `fields` is an array:

```json
{
  "status": 400,
  "error": "invalid_input",
  "message": "…",
  "data": null,
  "fields": [{ "path": "prompt", "message": "…" }]
}
```

The fields array above is used for DTO validation. Capability/business validation
may instead include field messages at the top level (for example,
`{ "error": "invalid_input", "sourceKey": "Required", … }`); always display the
general message as a fallback. Other errors may include details and a requestId. Handle 401 (invalid/revoked
key), 403 (scope/access), 404 (not found in this project), 409 (conflict),
402 (credits), 429 (rate/daily limit) and 5xx. Never blindly retry a chargeable
POST with a new clientKey after an ambiguous network failure.

## Routes and scopes

The table describes the contents of the success envelope's `data`.

| Method | Path                                 | Required scope    | Result / use                                                                                       |
| ------ | ------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/capabilities`                      | catalogue:read    | Array of public capabilities, parameter summaries, base rates and scenario examples                |
| GET    | `/balance`                           | balance:read      | `{ credits, currency }`; workspace-wide wallet                                                     |
| POST   | `/uploads/from-url`                  | media:write       | `{ url }` → `{ upload }`; public HTTPS media only                                                  |
| POST   | `/uploads`                           | media:write       | `{ filename, mime, bytes }` → `{ upload: { id, key, url, method, headers, expiresInSec } }`        |
| POST   | `/uploads/{uploadId}/complete`       | media:write       | No body; verify a completed PUT → `{ upload }` (200)                                               |
| POST   | `/generations/quote`                 | catalogue:read    | `{ capability, params }` → `{ costCode, credits, label, balance, balanceAfter, expectedMs }` (200) |
| POST   | `/generations`                       | generations:write | `{ capability, params, clientKey?, merchantRef? }` → `{ generation, balance }` (201)               |
| GET    | `/generations`                       | generations:read  | `{ generations, nextCursor }`; project summaries, not signed output URLs                           |
| GET    | `/generations/{generationId}`        | generations:read  | `{ generation }` with fresh output URLs                                                            |
| POST   | `/generations/{generationId}/cancel` | generations:write | No body; QUEUED only → `{ generation }` (200), credits returned                                    |
| POST   | `/generations/{generationId}/unlock` | generations:write | No body; unlock a completed song (200); fetch the generation again afterwards                      |
| GET    | `/catalogue/audio/genres`            | catalogue:read    | Music genre catalogue                                                                              |
| GET    | `/catalogue/audio/voices`            | catalogue:read    | Voices available in this environment                                                               |
| GET    | `/catalogue/audio/dub-languages`     | catalogue:read    | Languages available in this environment                                                            |
| GET    | `/catalogue/audio/unlock-price`      | catalogue:read    | `{ costCode, credits, label }` for the additional song unlock charge                               |

List query: `limit` 1–100 (default 50), UUID `cursor` from nextCursor, optional
`merchantRef`. Reads, cancel and unlock are scoped to the key's project.
Child shots, studio-channel generations and deleted generations are not public resources.

## Upload → quote → generate → collect

1. For a public image/video/audio URL, call `POST /uploads/from-url`.
   For a local file, call `POST /uploads`, PUT the **raw file bytes** to
   `data.upload.url` using the returned method and headers, then call
   `POST /uploads/{uploadId}/complete`. Do not send your API bearer token to
   the storage host; do not send multipart form data to a presigned PUT.
2. Use the completed upload's **key**, not its URL or ID, in sourceKey,
   sourceKeys or audioKey. Use the final READY upload response: normalization
   can change the key. The source must belong to the key's workspace.
3. Get the applicable scenario from `GET /capabilities` or the portal. Replace
   every workspace/media/voice/genre placeholder. Quote the complete
   `{ capability, params }` before offering a price to your customer.
4. Submit the same capability and params to `POST /generations` with a
   workspace-unique clientKey. The server selects the price code and reserves
   credits; clients cannot select a cheaper costCode.
5. Poll `GET /generations/{id}` about every three seconds until **SUCCEEDED,
   FAILED or CANCELLED**, or use webhooks. The multi-shot parent automatically
   runs its child shots and assembly; never submit VIDEO_STITCH yourself.
6. Read outputs by role and mime, not fixed array positions. Copy/download
   successful media before the signed URL expires. Refresh with a new GET.

A quote validates the complete public schema and estimates current pricing;
it does not reserve a price, create a job, debit credits, or certify provider
availability, media eligibility, consent, or quota. Generation remains authoritative.

## Which capability for each scenario?

Runnable request bodies are maintained in
`packages/shared/src/generation/api-scenarios.ts`, shown in **Developer → Docs**
and returned in each capability's `examples`. They are validated in tests.

| Scenario                               | capability         | Important inputs / follow-up                                                            |
| -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| Product in a designed, branded scene   | IMAGE_EDIT         | sourceKey, prompt, aspect, sizes; review fidelity before publishing                     |
| Poster or image without an input photo | IMAGE_GENERATE     | prompt, aspect, count                                                                   |
| Transparent or flat-colour cutout      | BACKGROUND_REMOVE  | sourceKey, background                                                                   |
| Replace a product's background         | BACKGROUND_REPLACE | sourceKey, prompt, shadow, relight                                                      |
| Change product lighting                | RELIGHT            | sourceKey, prompt                                                                       |
| Enlarge a photo                        | UPSCALE            | sourceKey, numeric factor 2 or 4                                                        |
| Combine 2–9 photos                     | COLLAGE            | ordered sourceKeys, layout, aspect, labels                                              |
| Fashion / product-specific editing     | PRODUCT_SHOT       | sourceKey, mode; examples cover all eight modes below                                   |
| Apply one edit to multiple sources     | BATCH              | sourceKeys, of, nested params                                                           |
| Descriptions, captions and SEO copy    | TEXT_GENERATE      | productName, details, language, platforms; sourceKey optional                           |
| Single photo-to-video reel             | IMAGE_TO_VIDEO     | sourceKey, prompt, shots: 1, durationSec: 5 or 8                                        |
| Multi-shot advertisement               | IMAGE_TO_VIDEO     | shots: 2/4/6/8 selects 15/30/45/60-second ad; format and benefits                       |
| Consenting photo presenter             | IMAGE_TO_VIDEO     | presenter photo configuration and explicit consent; see example                         |
| Narration                              | VOICEOVER          | script, voiceId from voice catalogue, style, speed                                      |
| Song or instrumental                   | MUSIC              | brief, genre from genre catalogue, vocal, durationSec; song unlock is a separate charge |
| Translate an existing video            | DUB                | sourceKey, targetLanguage, lipsync, quality, consent: true                              |
| Make a video speak new words           | LIPSYNC            | sourceKey plus audioKey OR script + voiceId, quality, consent: true                     |

PRODUCT_SHOT modes: `on_model`, `ghost_mannequin`, `flat_lay`, `ironing`,
`beautify`, `text_removal`, `edit`, `expand`. Custom edit needs a prompt.
Remove only text you have the right to remove. Do not fabricate endorsements
or use a face/voice without permission.

Photo creation and copywriting are separate requests; do not assume every image
response contains copy. The capability catalogue is a parameter **summary**,
not JSON Schema: conditional constraints are enforced by the validators/quote.
Internal pipeline fields and unsupported negativePrompt are not public inputs.

BATCH can succeed with partial results; failed items refund their share. Its
outputs are not a per-input success/failure manifest. When exact SKU-to-result
mapping is required, submit one generation per SKU using distinct clientKeys.

## Idempotency and tenant boundaries

clientKey is workspace-wide (maximum 80 characters: letters, digits, underscore,
hyphen, colon, period). Prefix it with your project/merchant/job identifier.
A retry within the same project returns the first accepted generation without
another charge; the original body wins. A changed request needs a new key.
A collision with another project's key returns 409, not that project's data.
If omitted, every request gets a new key.

merchantRef is attribution/filtering, **not authorization** (1–120 characters:
letters, digits, underscore, hyphen, colon, period, @). Projects isolate public
generation reads/actions, but uploads and the wallet are workspace-wide.
Use separate workspaces when untrusted tenants require asset and wallet isolation.
Rotated keys in the same project can read the project's prior generations.

## Output and song handling

The generation object includes id, status, capability, clientKey, merchantRef,
projectId, credits, costCode, createdAt, finishedAt, outputs and
`urlsExpireInSec: 3600`. A failed generation has
`failure: { kind, message }`. A URL can be null; do not assume every output is
a downloadable file. Text outputs contain inline text. The credits field is the
original reservation, not a net-of-refunds ledger statement.

A locked song output has `locked: true`, an empty key and a null URL.
Show the preview, read `/catalogue/audio/unlock-price`, obtain the customer's
agreement, then POST unlock. Already-unlocked retries do not charge again.
Finally GET the generation for the standard public payload and fresh URLs.

## Webhooks

Create endpoints in **Developer → Webhooks**. Events are
`generation.succeeded`, `generation.failed`, and portal test `ping`.
There is no cancellation webhook; poll when cancellation matters.

```json
{
  "id": "evt_…",
  "type": "generation.succeeded",
  "createdAt": "…",
  "data": { "id": "generation UUID", "status": "SUCCEEDED", "outputs": [] }
}
```

Unlike the GET response, webhook `data` is the generation itself, not
`data.generation`. Headers: X-AnyStudio-Event, X-AnyStudio-Delivery and
`X-AnyStudio-Signature: t=<unix seconds>,v1=<hex>`. Verify HMAC-SHA256 of
`<t>.<untouched raw body>` with the endpoint secret, using constant-time
comparison. Reject malformed signatures and timestamps more than five minutes
in the past **or future**. The portal includes a tested Node.js verification example.

Durably persist/enqueue the event and deduplicate by payload.id before returning
2xx within ten seconds. Deliveries retry with exponential backoff starting at
one minute, up to eight total attempts. Twenty consecutive failures pause an
endpoint. Retries/replays retain the stored body/event ID but use a fresh signing
timestamp. Old output URLs in a replay can be expired: GET the generation again.

## Limits

- POST generations: 60/minute per key, plus 10/minute per merchantRef behind that key.
- POST generations/quote: 60/minute per key; generation list/get: 300/minute per key.
- RateLimit-Limit/Remaining/Reset describe the evaluated rule; Retry-After is sent
  on 429, not every response. Respect it and apply backoff.
- Default rolling 24-hour video limit: 20 per workspace (configurable).
- File limits: images 25 MiB, video 250 MiB, audio 30 MiB.
- DUB: up to 300 seconds without lips, 180 seconds with lips. LIPSYNC: 180 seconds.
- Fifty active keys and twenty webhook endpoints per workspace.

## Control plane versus public API

Projects, keys, webhook configuration and usage reports are managed through the
authenticated portal and its session-based
`/workspaces/{workspaceId}/developer/…` endpoints. They are not public API-key
routes. There are no public `/products`, `/usage` or `/webhooks` endpoints.
Likewise `/audio/*` is studio/session API; integrations must use
`/catalogue/audio/*` with their API key.
