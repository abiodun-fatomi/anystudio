-- Help & support: the chat floater's conversations and messages.

CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SupportRole" AS ENUM ('USER', 'ASSISTANT', 'STAFF', 'SYSTEM');

CREATE TABLE "support_conversations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID,
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "topic" TEXT,
    "page" TEXT,
    "needsHuman" BOOLEAN NOT NULL DEFAULT false,
    "staffJoinedAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "transcriptSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_conversations_userId_status_idx" ON "support_conversations"("userId", "status");
CREATE INDEX "support_conversations_status_needsHuman_lastMessageAt_idx" ON "support_conversations"("status", "needsHuman", "lastMessageAt");
CREATE INDEX "support_conversations_lastMessageAt_idx" ON "support_conversations"("lastMessageAt");
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" "SupportRole" NOT NULL,
    "text" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_messages_conversationId_createdAt_idx" ON "support_messages"("conversationId", "createdAt");
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "support_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
