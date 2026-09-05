-- The bell: personal notifications, and platform messages read by many.

CREATE TYPE "NotificationKind" AS ENUM ('GENERATION_DONE', 'GENERATION_FAILED', 'CREDITS', 'MEMBER', 'PUBLISH', 'SYSTEM');
CREATE TYPE "PlatformAudience" AS ENUM ('ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION');

CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "refId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "platform_messages" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "audience" "PlatformAudience" NOT NULL DEFAULT 'ALL',
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_messages_publishedAt_idx" ON "platform_messages"("publishedAt");

CREATE TABLE "platform_message_reads" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_message_reads_pkey" PRIMARY KEY ("messageId", "userId")
);
ALTER TABLE "platform_message_reads" ADD CONSTRAINT "platform_message_reads_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "platform_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_message_reads" ADD CONSTRAINT "platform_message_reads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
