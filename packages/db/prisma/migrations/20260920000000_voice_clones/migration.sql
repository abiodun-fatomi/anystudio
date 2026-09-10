-- A workspace's own voice: cloned from a recording its owner consented to.
CREATE TYPE "VoiceKind" AS ENUM ('PRESET', 'CLONE');

ALTER TABLE "voice_profiles"
  ADD COLUMN "kind" "VoiceKind" NOT NULL DEFAULT 'PRESET',
  ADD COLUMN "workspaceId" UUID,
  ADD COLUMN "sampleKey" TEXT,
  ADD COLUMN "consentAt" TIMESTAMP(3),
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "voice_profiles"
  ADD CONSTRAINT "voice_profiles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "voice_profiles_workspaceId_idx" ON "voice_profiles"("workspaceId");
