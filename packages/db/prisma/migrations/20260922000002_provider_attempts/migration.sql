-- A paid async provider can accept work milliseconds before a worker dies.
-- The generation row is too coarse for multi-step pipelines, so journal each
-- external operation before POST and persist its vendor id before polling.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "ProviderAttemptStatus" AS ENUM ('SUBMITTING', 'SUBMITTED', 'SUCCEEDED', 'FAILED');

CREATE TABLE "provider_attempts" (
    "id" UUID NOT NULL,
    "generationId" UUID NOT NULL,
    "operationKey" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "capability" "ProviderCapability" NOT NULL,
    "submissionNo" INTEGER NOT NULL DEFAULT 1,
    "generationAttempt" INTEGER NOT NULL,
    "status" "ProviderAttemptStatus" NOT NULL DEFAULT 'SUBMITTING',
    "providerJobId" TEXT,
    "costMinor" INTEGER,
    "resumeData" JSONB,
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_attempts_submission_key"
ON "provider_attempts"("generationId", "operationKey", "providerKey", "submissionNo");

CREATE INDEX "provider_attempts_generationId_operationKey_status_idx"
ON "provider_attempts"("generationId", "operationKey", "status");

CREATE INDEX "provider_attempts_providerKey_providerJobId_idx"
ON "provider_attempts"("providerKey", "providerJobId");

ALTER TABLE "provider_attempts"
ADD CONSTRAINT "provider_attempts_generationId_fkey"
FOREIGN KEY ("generationId") REFERENCES "generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
