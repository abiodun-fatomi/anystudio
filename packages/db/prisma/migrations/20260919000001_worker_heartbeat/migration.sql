-- Worker liveness for the staff console.
CREATE TABLE "worker_heartbeats" (
  "id" TEXT NOT NULL,
  "service" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "version" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "worker_heartbeats_seenAt_idx" ON "worker_heartbeats"("seenAt");
