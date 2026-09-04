-- Phase 7: the account itself. Profile fields, the email-change token, and
-- the security events the settings screens show.

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "avatarKey" TEXT,
  ADD COLUMN "locale" TEXT,
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "prefs" JSONB,
  ADD COLUMN "deleteRequestedAt" TIMESTAMP(3);

-- AlterEnum
-- Postgres refuses to USE a new enum value inside the transaction that added
-- it; nothing below uses these, so adding them here is safe.
ALTER TYPE "TokenPurpose" ADD VALUE 'EMAIL_CHANGE';

ALTER TYPE "AuthEventType" ADD VALUE 'EMAIL_CHANGE_REQUESTED';
ALTER TYPE "AuthEventType" ADD VALUE 'EMAIL_CHANGED';
ALTER TYPE "AuthEventType" ADD VALUE 'IDENTITY_UNLINKED';
ALTER TYPE "AuthEventType" ADD VALUE 'RECOVERY_CODES_REGENERATED';
ALTER TYPE "AuthEventType" ADD VALUE 'ACCOUNT_DELETION_REQUESTED';
ALTER TYPE "AuthEventType" ADD VALUE 'ACCOUNT_DELETION_CANCELLED';

-- The deletion sweeper (a later phase) asks "whose grace period has ended?"
CREATE INDEX "users_deleteRequestedAt_idx" ON "users"("deleteRequestedAt") WHERE "deleteRequestedAt" IS NOT NULL;
