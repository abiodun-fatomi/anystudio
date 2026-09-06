-- Retention sweeper: a media row whose object has been removed from storage.
ALTER TYPE "MediaStatus" ADD VALUE IF NOT EXISTS 'PURGED';
-- The sweeper's account query.
CREATE INDEX IF NOT EXISTS "users_deleteRequestedAt_idx" ON "users"("deleteRequestedAt");
CREATE INDEX IF NOT EXISTS "media_assets_deletedAt_idx" ON "media_assets"("deletedAt");
