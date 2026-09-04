-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "generations" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "costCode" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "providerKey" TEXT,
    "providerJobId" TEXT,
    "input" JSONB NOT NULL,
    "outputs" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generations_workspaceId_createdAt_idx" ON "generations"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "generations_status_heartbeatAt_idx" ON "generations"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "generations_providerJobId_idx" ON "generations"("providerJobId");

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
