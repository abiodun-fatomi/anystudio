# Production readiness — 2026-09-08

The permanent code changes have been implemented and locally tested. This is
not a certification that the application is bug-free or that the deployed
services already run these changes. No release was deployed during this review.

## Permanent controls

- The main worker consumes `media.fast,media.heavy`. Final assembly runs on a
  separate 2 GB worker consuming only `media.local`. Both processes serialize
  FFmpeg with `FFMPEG_CONCURRENCY=1`; local queue and database-fallback concurrency
  are also one. Development, staging and production have separate Blueprints.
- Worker readiness checks and release checks verify the queue split and the
  tested commit. Durable provider-attempt records preserve accepted async job
  IDs across worker restarts. An unknown submission outcome is not proof that
  it is safe to create another paid job.
- Image-to-video defaults to Veo 3.1 Fast, with Wan 2.5 as fallback. Image editing
  defaults to Gemini 3 Pro Image, with Seedream and Flux fallbacks. These are
  informed defaults, not a measured guarantee that one model wins every prompt.
  Compare approved product/face/text examples before changing production order.
  Sora is disabled ahead of its documented API retirement. See [Providers](PROVIDERS.md).
- Flutterwave and Paddle use their own verified transaction, subscription and
  adjustment adapters. Refund command cycles, provider adjustment IDs, ledger
  locking and reconciliation protect against duplicate grants and incorrect
  clawbacks. Invoice settlement checks both the payment binding and the provider
  transaction identity. Annual allowances are tied to the payment that funded
  them; cancellation and failed/late payment paths do not silently grant service.
- Unsupported Paddle credit-note adjustments are recorded for review and can
  suspend the affected usage-billing account; they are not silently treated as
  cash refunds. Production refuses test credentials and unapproved Paddle use.
- Organization documentation now maps all 15 public generation capabilities
  and all eight product-photo modes to shared, schema-tested request examples.
  Public quote and song unlock-price routes support cost disclosure before
  submission. API discovery excludes internal pipeline inputs and VIDEO_STITCH.
- Public generation reads/actions and clientKey replays enforce project
  ownership, including concurrent cross-project collisions and song unlocking.
  Replay checks precede source availability and daily quota checks. Projects
  do not isolate the workspace-wide wallet or uploads; separate workspaces are
  required for untrusted tenants. See [Organization API](API.md).
- The portal's copyable webhook verifier is tested against malformed headers,
  expired/future timestamps, invalid signatures and body tampering. Production
  documentation no longer points integrations to disabled Swagger routes.

## Local verification

- Full API suite: **804 passed, none skipped**, using PostgreSQL 18 and real
  FFmpeg, with normal test-file parallelism.
- Web suite: **79 passed**; web type-checking, lint and production build passed.
- Audio catalogue seed checks: **2 passed**. Workspace-wide lint passed.
- API type-checking, lint and build passed.
- All 34 migrations applied to a clean disposable database. Prisma's comparison
  reported **no schema differences**.
- Upgrade fixtures and duplicate-data rejection/rollback checks passed.
- Render Blueprint contracts and the live-preflight response parser passed.

FFmpeg was installed locally for media tests. The Docker PostgreSQL container
`anystudio-billing-audit-20260908` was stopped after testing; it retains disposable
test data, not production data. These tests use stubbed vendor responses; they do not prove real gateway
approval, real provider output quality, or deployed service health.

## Required before accepting production customers

1. Review and commit the patch, pass CI, and release through the environment's
   deployment workflow. Back up production data and rehearse the migrations on
   a sanitized copy first. Resolve any duplicate-data migration preflight error;
   do not bypass the invariant checks.
2. Confirm the live Render settings match the correct Blueprint. The main worker
   must exclude `media.local`; the media worker must consume only `media.local`
   on the 2 GB plan. Set the environment's `RENDER_MEDIA_SERVICE_ID` to that worker.
   Confirm both workers report the released commit and healthy heartbeats.
3. Configure real catalogue IDs, credentials and webhook destinations. Follow
   the payment rehearsal in [Deployment](DEPLOY.md): purchases, duplicate webhook
   delivery, refunds, renewals, cancellations and usage-invoice settlement. Confirm
   gateway money and the application's ledger agree, including a failed refund.
4. Obtain written Paddle approval for the exact AI face, voice, video,
   advertising and publishing feature set. Seller-account approval alone is not
   enough evidence. Set `PADDLE_PRODUCT_APPROVED=true` only after that approval;
   if refused, choose another approved gateway before launching those markets.
5. Generate a real representative multi-shot ad and check stitching, output
   quality, billed credits and worker memory. Rehearse a worker restart in
   staging to verify accepted provider jobs resume and final assembly recovers.
6. Verify storage access, provider usage permissions, monitoring and alert
   delivery. Resolve remaining manual payment/adjustment reviews before launch.

See [Environment](ENV.md) for configuration and [Deployment](DEPLOY.md) for the
release and smoke-test procedure.
