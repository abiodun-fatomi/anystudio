-- Publishing: connected social accounts and the posts that go out through them.

CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'TIKTOK');
CREATE TYPE "SocialAccountStatus" AS ENUM ('CONNECTED', 'NEEDS_REAUTH', 'DISCONNECTED');
CREATE TYPE "PublishStatus" AS ENUM ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');
CREATE TYPE "PublishFormat" AS ENUM ('IMAGE', 'VIDEO', 'REEL', 'STORY');

CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "pageId" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastError" TEXT,
    "connectedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),
    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "social_accounts_workspaceId_platform_externalId_key" ON "social_accounts"("workspaceId", "platform", "externalId");
CREATE INDEX "social_accounts_workspaceId_status_idx" ON "social_accounts"("workspaceId", "status");
CREATE INDEX "social_accounts_status_tokenExpiresAt_idx" ON "social_accounts"("status", "tokenExpiresAt");
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "publish_jobs" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "generationId" UUID,
    "createdById" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "format" "PublishFormat" NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "mediaMime" TEXT,
    "caption" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'SCHEDULED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failureReason" TEXT,
    "log" JSONB,
    "externalPostId" TEXT,
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "publish_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "publish_jobs_workspaceId_scheduledFor_idx" ON "publish_jobs"("workspaceId", "scheduledFor");
CREATE INDEX "publish_jobs_status_nextAttemptAt_idx" ON "publish_jobs"("status", "nextAttemptAt");
CREATE INDEX "publish_jobs_accountId_idx" ON "publish_jobs"("accountId");
CREATE INDEX "publish_jobs_generationId_idx" ON "publish_jobs"("generationId");
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
