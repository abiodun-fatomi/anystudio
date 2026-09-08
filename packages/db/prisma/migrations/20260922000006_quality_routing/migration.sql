-- One-time research-informed default rerank. Preserve non-default operator
-- priorities, disabled flags, credentials/config and workspace restrictions.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
UPDATE "provider_models" AS p
SET "priority" = v.new_priority, "updatedAt" = CURRENT_TIMESTAMP
FROM (VALUES
  ('vertex:gemini-3-pro-image', 'IMAGE_EDIT', 10, 20),
  ('fal:seedream-4.5-edit', 'IMAGE_EDIT', 20, 10),
  ('photoroom:edit', 'BACKGROUND_REMOVE', 30, 10),
  ('replicate:birefnet', 'BACKGROUND_REMOVE', 10, 30)
) AS v(key, capability, old_priority, new_priority)
WHERE p."key" = v.key AND p."capability"::text = v.capability
  AND p."priority" = v.old_priority;
COMMIT;
