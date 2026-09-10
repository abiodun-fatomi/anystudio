BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "refund_requests"
  ADD COLUMN "refundCycle" INTEGER;

-- Cycle zero preserves the ledger keys used by refund approvals that were
-- already in flight when this release began. New requests start at one.
UPDATE "refund_requests" SET "refundCycle" = 0;

-- Safe for an intermediate deployment of the billing state machine: a row
-- marked processing before the provider POST but lacking an acknowledgement
-- must re-enter discover-before-submit recovery.
UPDATE "refund_requests"
SET "processingAt" = NULL
WHERE "status" = 'PROCESSING' AND "gatewayRef" IS NULL;

ALTER TABLE "refund_requests"
  ALTER COLUMN "refundCycle" SET NOT NULL,
  ALTER COLUMN "refundCycle" SET DEFAULT 1;

ALTER TABLE "payment_adjustments"
  ADD COLUMN "refundCycle" INTEGER;

COMMIT;
