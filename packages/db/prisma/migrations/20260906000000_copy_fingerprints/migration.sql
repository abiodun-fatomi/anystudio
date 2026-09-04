-- CreateTable
CREATE TABLE "copy_fingerprints" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "generationId" UUID NOT NULL,
    "productKey" TEXT,
    "minhash" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copy_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copy_fingerprints_workspaceId_createdAt_idx" ON "copy_fingerprints"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "copy_fingerprints" ADD CONSTRAINT "copy_fingerprints_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
