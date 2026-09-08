-- Fal/Wan first for new image-to-video work, including UGC product shots.
-- Preserve custom priorities, enabled flags, credentials, pricing and scopes.
-- Existing provider attempts retain their recorded vendor; this does not
-- resubmit completed/rejected shots or change the HeyGen presenter path.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
UPDATE "provider_models" AS p
SET "priority" = v.new_priority, "updatedAt" = CURRENT_TIMESTAMP
FROM (VALUES
  ('fal:wan-2.5-i2v', 20, 10),
  ('vertex:veo-3.1-fast', 10, 20)
) AS v(key, old_priority, new_priority)
WHERE p."key" = v.key AND p."capability"::text = 'IMAGE_TO_VIDEO'
  AND p."priority" = v.old_priority;
COMMIT;
