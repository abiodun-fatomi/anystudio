-- Financial invariants belong in Postgres as well as application code. Two
-- API processes, two webhook event types, or two browser tabs must not be able
-- to create duplicate money/subscription rows between a read and a write.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

-- Stop before changing anything when historical data violates a new money
-- invariant. Silently deleting or choosing a winner would rewrite financial
-- history; the error names the exact reconciliation query operators must run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payments"
     WHERE "providerRef" IS NOT NULL
     GROUP BY "provider", "providerRef" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'billing invariant: duplicate payments(provider, providerRef); reconcile duplicates before deploy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "subscriptions"
     WHERE "status" IN ('ACTIVE', 'PAST_DUE', 'PAUSED')
     GROUP BY "workspaceId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'billing invariant: workspace has multiple live subscriptions; reconcile before deploy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "subscriptions"
     WHERE "provider" = 'PADDLE' AND "providerRef" IS NOT NULL
     GROUP BY "providerRef" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'billing invariant: duplicate Paddle subscription id; reconcile before deploy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "invoices"
     WHERE "paymentId" IS NOT NULL
     GROUP BY "paymentId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'billing invariant: one payment is attached to multiple invoices; reconcile before deploy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "payments"
     WHERE "kind" = 'INVOICE' AND "status" = 'PENDING'
     GROUP BY "workspaceId", "itemCode" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'billing invariant: invoice has multiple pending checkout payments; reconcile before deploy';
  END IF;
END $$;

-- A gateway transaction is globally unique inside that gateway. PostgreSQL
-- permits multiple NULL values, so pending rows without a provider reference
-- remain valid.
CREATE UNIQUE INDEX "payments_provider_providerRef_key"
  ON "payments" ("provider", "providerRef");
DROP INDEX IF EXISTS "payments_provider_providerRef_idx";

-- Reserve an invoice to exactly one hosted checkout before leaving for the
-- provider. Backfill the single pending legacy checkout, then enforce that a
-- Payment cannot be attached to two invoices.
UPDATE "invoices" AS i
   SET "paymentId" = p."id"
  FROM "payments" AS p
 WHERE i."paymentId" IS NULL
   AND p."kind" = 'INVOICE'
   AND p."status" = 'PENDING'
   AND p."workspaceId" = i."workspaceId"
   AND p."itemCode" = i."number";
CREATE UNIQUE INDEX "invoices_paymentId_key" ON "invoices" ("paymentId");

-- Prisma cannot express a partial unique index, so this invariant lives in
-- the migration. Cancelled subscriptions remain as history; at most one live
-- subscription can exist for a workspace.
CREATE UNIQUE INDEX "subscriptions_one_live_per_workspace_idx"
  ON "subscriptions" ("workspaceId")
  WHERE "status" IN ('ACTIVE', 'PAST_DUE', 'PAUSED');

ALTER TABLE "subscriptions"
  ADD COLUMN "catalogueRef" TEXT,
  ADD COLUMN "providerUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "providerCancelPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "providerCancelAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "providerCancelNextAt" TIMESTAMP(3),
  ADD COLUMN "providerCancelError" TEXT;

-- Old Flutterwave rows stored the shared plan id in providerRef. Populate the
-- new catalogue column from the server-side plan catalogue so cancellation
-- can resolve the true subscription id and the next renewal can replace the
-- legacy value without an outage. Paddle rows receive their price id too.
UPDATE "subscriptions" AS s
   SET "catalogueRef" = CASE
     WHEN s."provider" = 'FLUTTERWAVE' THEN p."providerRefs"->'flutterwave'->>s."interval"
     WHEN s."provider" = 'PADDLE' THEN p."providerRefs"->'paddle'->>s."interval"
     ELSE NULL
   END
  FROM "plans" AS p
 WHERE p."code" = s."planCode" AND s."catalogueRef" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "subscriptions"
     WHERE "provider" = 'FLUTTERWAVE' AND "providerRef" IS NOT NULL
       AND "providerRef" IS DISTINCT FROM "catalogueRef"
     GROUP BY "providerRef" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'billing invariant: duplicate Flutterwave subscription id; reconcile before deploy';
  END IF;
END $$;

CREATE UNIQUE INDEX "subscriptions_flutterwave_providerRef_key"
  ON "subscriptions" ("providerRef")
  WHERE "provider" = 'FLUTTERWAVE'
    AND "providerRef" IS NOT NULL
    AND "providerRef" IS DISTINCT FROM "catalogueRef";
CREATE INDEX "subscriptions_provider_catalogueRef_customerRef_idx"
  ON "subscriptions" ("provider", "catalogueRef", "customerRef");
CREATE INDEX "subscriptions_providerCancelPending_providerCancelNextAt_idx"
  ON "subscriptions" ("providerCancelPending", "providerCancelNextAt");

-- Paddle exposes a true subscription id, so duplicates are always corrupt.
CREATE UNIQUE INDEX "subscriptions_paddle_providerRef_key"
  ON "subscriptions" ("providerRef")
  WHERE "provider" = 'PADDLE' AND "providerRef" IS NOT NULL;

-- Refund APIs acknowledge a request before funds are actually returned.
-- PROCESSING survives crashes and is reconciled from the gateway until an
-- approved/completed event makes the credit clawback authoritative.
ALTER TYPE "RefundRequestStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "RefundRequestStatus" ADD VALUE 'NEEDS_REVIEW';
ALTER TYPE "PaymentStatus" ADD VALUE 'NEEDS_REVIEW';
ALTER TYPE "InvoiceStatus" ADD VALUE 'REFUNDED';
ALTER TYPE "InvoiceStatus" ADD VALUE 'DISPUTED';

ALTER TABLE "refund_requests"
  ALTER COLUMN "requestedById" DROP NOT NULL,
  ADD COLUMN "gatewayRef" TEXT,
  ADD COLUMN "processingAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT;

CREATE INDEX "refund_requests_status_nextAttemptAt_idx"
  ON "refund_requests" ("status", "nextAttemptAt");

-- Refunds and disputes are a stream, not a boolean on Payment. Persist every
-- provider adjustment once so partial refunds and reversals can apply only
-- their own proportional credit delta and can be reconciled independently.
CREATE TYPE "PaymentAdjustmentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REVERSED', 'NEEDS_REVIEW');
CREATE TYPE "PaymentAdjustmentReason" AS ENUM ('REFUND', 'CHARGEBACK');

CREATE TABLE "payment_adjustments" (
  "id" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "providerRef" TEXT NOT NULL,
  "reason" "PaymentAdjustmentReason" NOT NULL,
  "status" "PaymentAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
  "amountMinor" INTEGER,
  "amountDeltaMinor" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT,
  "creditDelta" INTEGER NOT NULL DEFAULT 0,
  "ledgerRevision" INTEGER NOT NULL DEFAULT 0,
  "providerUpdatedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_adjustments_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "payment_adjustments_provider_providerRef_key"
  ON "payment_adjustments" ("provider", "providerRef");
CREATE INDEX "payment_adjustments_paymentId_status_idx"
  ON "payment_adjustments" ("paymentId", "status");

-- Webhook delivery is not the retry mechanism of record: providers eventually
-- stop retrying. Persist enough claim/backoff state for the worker to redrive
-- a verified event after an API restart or a transient dependency failure.
ALTER TABLE "webhook_receipts"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "webhook_receipts_outcome_nextAttemptAt_idx"
  ON "webhook_receipts" ("outcome", "nextAttemptAt");

-- Once a verified gateway refund or chargeback has happened, the corresponding
-- service credits are no longer funded. Unlike an ordinary customer spend,
-- this adjustment must be recorded even when it takes the wallet below zero;
-- future purchases first repay that debt. The dedicated function keeps this
-- exceptional rule out of the normal ledger_apply path.
CREATE OR REPLACE FUNCTION ledger_force_clawback(
  p_wallet_id        uuid,
  p_amount           integer,
  p_idempotency_key  text,
  p_reference_id     uuid DEFAULT NULL,
  p_reason           text DEFAULT NULL
) RETURNS ledger_entries
LANGUAGE plpgsql AS $$
DECLARE
  v_existing ledger_entries;
  v_balance  integer;
  v_row      ledger_entries;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'ledger_force_clawback: amount must be positive' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_force_clawback: wallet % not found', p_wallet_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT * INTO v_existing FROM ledger_entries
   WHERE "walletId" = p_wallet_id AND "idempotencyKey" = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT COALESCE("balanceAfter", 0) INTO v_balance
    FROM ledger_entries
   WHERE "walletId" = p_wallet_id
   ORDER BY "createdAt" DESC, id DESC
   LIMIT 1;
  v_balance := COALESCE(v_balance, 0);

  INSERT INTO ledger_entries
    (id, "walletId", kind, delta, "balanceAfter", "referenceId", "idempotencyKey", reason, "actorId", "createdAt")
  VALUES
    (gen_random_uuid(), p_wallet_id, 'ADJUSTMENT', -p_amount, v_balance - p_amount,
     p_reference_id, p_idempotency_key, p_reason, NULL, now())
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;

COMMIT;
