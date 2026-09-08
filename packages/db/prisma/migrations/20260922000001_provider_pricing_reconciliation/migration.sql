-- One-time production reconciliation for routing values that are intentionally
-- operator-owned after a ProviderModel row is first seeded. Veo 3.1 Fast and
-- Wan 2.5 both cost $0.10/s at 720p; prefer Veo for quality and retain Wan as
-- the independent fallback. Sora's API permanently shuts down on 2026-09-24.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

UPDATE "provider_models"
SET "priority" = 10,
    "costPerCall" = 80,
    "config" = COALESCE("config", '{}'::jsonb) || '{"resolution":"720p","costPerSecondMinor":10}'::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'vertex:veo-3.1-fast' AND "capability" = 'IMAGE_TO_VIDEO';

UPDATE "provider_models"
SET "priority" = 20, "costPerCall" = 80, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'fal:wan-2.5-i2v' AND "capability" = 'IMAGE_TO_VIDEO';

UPDATE "provider_models"
SET "priority" = 90, "enabled" = FALSE, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'openai:sora-2' AND "capability" = 'IMAGE_TO_VIDEO';

-- MiniMax Music 2.0 is currently $0.03 per successful generation, not $0.30.
UPDATE "provider_models"
SET "costPerCall" = 3, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'fal:minimax-music-v2' AND "capability" = 'MUSIC';

-- Eleven Music is $0.15 per generated minute. MUSIC defaults to a two-minute
-- track; the adapter records the exact duration-derived cost after success.
UPDATE "provider_models"
SET "costPerCall" = 30,
    "config" = COALESCE("config", '{}'::jsonb) || '{"costPerMinuteMinor":15}'::jsonb,
    "licenceNote" = 'Eleven Music: cleared for commercial use incl. ads and social video on paid plans (elevenlabs.io/music-terms). $0.15/generated minute on the API pricing page. Refuses artist names. Checked 2026-09-08.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'elevenlabs:music' AND "capability" = 'MUSIC';

-- Music generation is now billed by started 30-second units in application
-- code. The initial debit covers the provider work; unlock only exposes the
-- already-generated vault object, so it is no longer the margin backstop.
UPDATE "credit_costs"
SET "credits" = 10, "label" = 'Song generation (per 30 seconds)', "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'audio.music.preview';

UPDATE "credit_costs"
SET "credits" = 20, "label" = 'Song in your voice (per 30 seconds)', "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'audio.music.preview.my_voice';

UPDATE "credit_costs"
SET "credits" = 10, "label" = 'Unlock the full song', "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'audio.music.unlock';

UPDATE "credit_costs"
SET "label" = 'Translate video audio (per started minute)', "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'video.translate';

UPDATE "credit_costs"
SET "label" = 'Translate with lip-sync (per started 30 seconds)', "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'video.translate_lipsync';

UPDATE "credit_costs"
SET "label" = 'Lip-sync video (per started 30 seconds)', "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'video.lipsync';

COMMIT;
