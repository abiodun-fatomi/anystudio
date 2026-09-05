-- Phase 12: the developer platform (projects, API keys, webhooks) and the
-- WhatsApp channel (contacts, messages), plus where a generation came from.

CREATE TYPE "GenerationChannel" AS ENUM ('WEB', 'API', 'WHATSAPP');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
CREATE TYPE "WhatsappDirection" AS ENUM ('IN', 'OUT');

CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "projects_workspaceId_slug_key" ON "projects"("workspaceId", "slug");
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");
CREATE INDEX "api_keys_workspaceId_revokedAt_idx" ON "api_keys"("workspaceId", "revokedAt");
CREATE INDEX "api_keys_projectId_idx" ON "api_keys"("projectId");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_endpoints_workspaceId_idx" ON "webhook_endpoints"("workspaceId");
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");
CREATE INDEX "webhook_deliveries_endpointId_createdAt_idx" ON "webhook_deliveries"("endpointId", "createdAt");
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "whatsapp_contacts" (
    "id" UUID NOT NULL,
    "waId" TEXT NOT NULL,
    "userId" UUID,
    "workspaceId" UUID,
    "name" TEXT,
    "state" JSONB,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "whatsapp_contacts_waId_key" ON "whatsapp_contacts"("waId");
CREATE INDEX "whatsapp_contacts_userId_idx" ON "whatsapp_contacts"("userId");
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "waMessageId" TEXT,
    "direction" "WhatsappDirection" NOT NULL,
    "type" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "generationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "whatsapp_messages_waMessageId_key" ON "whatsapp_messages"("waMessageId");
CREATE INDEX "whatsapp_messages_contactId_createdAt_idx" ON "whatsapp_messages"("contactId", "createdAt");
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "whatsapp_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Where a generation came from, and for API requests, who made it.
ALTER TABLE "generations"
    ADD COLUMN "channel" "GenerationChannel" NOT NULL DEFAULT 'WEB',
    ADD COLUMN "apiKeyId" UUID,
    ADD COLUMN "projectId" UUID,
    ADD COLUMN "merchantRef" TEXT;
CREATE INDEX "generations_projectId_createdAt_idx" ON "generations"("projectId", "createdAt");
CREATE INDEX "generations_apiKeyId_createdAt_idx" ON "generations"("apiKeyId", "createdAt");
ALTER TABLE "generations" ADD CONSTRAINT "generations_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "generations" ADD CONSTRAINT "generations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
