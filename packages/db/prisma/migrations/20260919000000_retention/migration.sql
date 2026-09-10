-- Retention sweeper: a media row whose object has been removed from storage.
ALTER TYPE "MediaStatus" ADD VALUE IF NOT EXISTS 'PURGED';
-- The object purge scans soft-deleted media; the account query already has
-- its partial index on users(deleteRequestedAt) from 20260907000000_account.
CREATE INDEX "media_assets_deletedAt_idx" ON "media_assets"("deletedAt");
