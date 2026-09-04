-- The provider plane: every capability the product will have, the rows that
-- route it, the media it reads and writes, and the brand kit it composites.
--
-- The enum swap below is the one hand-written piece. Prisma's own version of
-- this statement casts "capability"::text straight into the new type, which
-- fails on any row still holding an old value. The CASE maps the five old
-- names onto their successors in the same statement, so a dev database that
-- already has provider rows migrates instead of refusing.

-- CreateEnum
CREATE TYPE "GenerationKind" AS ENUM ('STANDALONE', 'PARENT', 'CHILD');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('SOURCE', 'OUTPUT', 'DERIVED');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "ProviderCapability_new" AS ENUM ('IMAGE_GENERATE', 'IMAGE_EDIT', 'BACKGROUND_REMOVE', 'BACKGROUND_REPLACE', 'RELIGHT', 'UPSCALE', 'IMAGE_TO_VIDEO', 'VIDEO_STITCH', 'TEXT_GENERATE', 'VOICEOVER', 'MUSIC', 'DUB', 'LIPSYNC');
ALTER TABLE "provider_models" ALTER COLUMN "capability" TYPE "ProviderCapability_new" USING (
  CASE "capability"::text
    WHEN 'IMAGE' THEN 'IMAGE_GENERATE'
    WHEN 'EDIT'  THEN 'IMAGE_EDIT'
    WHEN 'VIDEO' THEN 'IMAGE_TO_VIDEO'
    WHEN 'TEXT'  THEN 'TEXT_GENERATE'
    ELSE "capability"::text
  END
)::"ProviderCapability_new";
ALTER TYPE "ProviderCapability" RENAME TO "ProviderCapability_old";
ALTER TYPE "ProviderCapability_new" RENAME TO "ProviderCapability";
DROP TYPE "ProviderCapability_old";
COMMIT;

-- AlterTable
-- One row per (model, capability): the same vendor model can serve several
-- capabilities with independent priority, cost and switch.
ALTER TABLE "provider_models" DROP CONSTRAINT "provider_models_pkey",
ADD COLUMN     "config" JSONB,
ADD COLUMN     "licenceNote" TEXT,
ADD COLUMN     "workspaceType" "WorkspaceType",
ADD CONSTRAINT "provider_models_pkey" PRIMARY KEY ("key", "capability");

-- AlterTable
-- `capability` is required. Existing rows (dev only — the pipeline had no
-- consumers before this migration) are backfilled as IMAGE_EDIT, then the
-- default is dropped so the column carries no default in the final schema.
ALTER TABLE "generations" ADD COLUMN     "capability" "ProviderCapability" NOT NULL DEFAULT 'IMAGE_EDIT',
ADD COLUMN     "clientKey" TEXT,
ADD COLUMN     "failureKind" TEXT,
ADD COLUMN     "kind" "GenerationKind" NOT NULL DEFAULT 'STANDALONE',
ADD COLUMN     "parentId" UUID,
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "providerCostMinor" INTEGER,
ADD COLUMN     "stage" TEXT;
ALTER TABLE "generations" ALTER COLUMN "capability" DROP DEFAULT;

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "uploadedById" UUID,
    "generationId" UUID,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "key" TEXT NOT NULL,
    "mime" TEXT,
    "bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "sha256" TEXT,
    "filename" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_kits" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "businessName" TEXT,
    "logoKey" TEXT,
    "palette" JSONB,
    "fontDisplay" TEXT,
    "fontBody" TEXT,
    "tone" TEXT,
    "watermark" JSONB,
    "showPrice" BOOLEAN NOT NULL DEFAULT true,
    "defaultSizes" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_key_key" ON "media_assets"("key");

-- CreateIndex
CREATE INDEX "media_assets_workspaceId_createdAt_idx" ON "media_assets"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "media_assets_workspaceId_sha256_idx" ON "media_assets"("workspaceId", "sha256");

-- CreateIndex
CREATE INDEX "media_assets_generationId_idx" ON "media_assets"("generationId");

-- CreateIndex
CREATE UNIQUE INDEX "brand_kits_workspaceId_key" ON "brand_kits"("workspaceId");

-- CreateIndex
CREATE INDEX "generations_parentId_idx" ON "generations"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "generations_workspaceId_clientKey_key" ON "generations"("workspaceId", "clientKey");

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
