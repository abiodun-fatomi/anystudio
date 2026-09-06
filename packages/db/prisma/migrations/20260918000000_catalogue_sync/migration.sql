-- Catalogue sync: stores connected to a workspace and the products read from them.

CREATE TYPE "StoreKind" AS ENUM ('SHOPIFY', 'WOOCOMMERCE');
CREATE TYPE "StoreStatus" AS ENUM ('CONNECTED', 'NEEDS_ATTENTION', 'DISCONNECTED');

CREATE TABLE "store_connections" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" "StoreKind" NOT NULL,
    "label" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "credentialsEnc" TEXT NOT NULL,
    "status" "StoreStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "syncingSince" TIMESTAMP(3),
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "connectedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),
    CONSTRAINT "store_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_connections_workspaceId_kind_domain_key" ON "store_connections"("workspaceId", "kind", "domain");
CREATE INDEX "store_connections_status_nextSyncAt_idx" ON "store_connections"("status", "nextSyncAt");
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "catalogue_products" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER,
    "currency" TEXT,
    "url" TEXT,
    "productKey" TEXT NOT NULL,
    "images" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "externalUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catalogue_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "catalogue_products_storeId_externalId_key" ON "catalogue_products"("storeId", "externalId");
CREATE INDEX "catalogue_products_workspaceId_active_title_idx" ON "catalogue_products"("workspaceId", "active", "title");
CREATE INDEX "catalogue_products_workspaceId_productKey_idx" ON "catalogue_products"("workspaceId", "productKey");
ALTER TABLE "catalogue_products" ADD CONSTRAINT "catalogue_products_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalogue_products" ADD CONSTRAINT "catalogue_products_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "store_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
