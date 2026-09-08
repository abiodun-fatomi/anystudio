-- Before payment_adjustments existed, a confirmed refund was represented by
-- Payment.status=REFUNDED and (when the customer still had the credits) the
-- immutable ledger key payment:<paymentId>:clawback. Preserve that financial
-- history before the new webhook state machine sees a redelivery or reversal.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

INSERT INTO "payment_adjustments" (
  "id",
  "paymentId",
  "provider",
  "providerRef",
  "reason",
  "status",
  "amountMinor",
  "amountDeltaMinor",
  "currency",
  "creditDelta",
  "ledgerRevision",
  "refundCycle",
  "appliedAt",
  "payload",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  p."id",
  p."provider",
  'legacy-refund:' || p."id"::text,
  'REFUND'::"PaymentAdjustmentReason",
  'SUCCEEDED'::"PaymentAdjustmentStatus",
  p."amountMinor",
  -p."amountMinor",
  p."currency",
  COALESCE(clawback.delta, 0),
  CASE WHEN COALESCE(clawback.delta, 0) <> 0 THEN 1 ELSE 0 END,
  rr."refundCycle",
  COALESCE(p."refundedAt", p."updatedAt", p."createdAt"),
  jsonb_build_object(
    'migratedLegacyRefund', true,
    'reportedProviderRef', rr."decisionNote",
    'legacyClawbackKey', 'payment:' || p."id"::text || ':clawback'
  ),
  COALESCE(p."refundedAt", p."updatedAt", p."createdAt"),
  now()
FROM "payments" AS p
LEFT JOIN "wallets" AS w
  ON w."workspaceId" = p."workspaceId"
LEFT JOIN "ledger_entries" AS clawback
  ON clawback."walletId" = w."id"
 AND clawback."idempotencyKey" = 'payment:' || p."id"::text || ':clawback'
LEFT JOIN "refund_requests" AS rr
  ON rr."paymentId" = p."id" AND rr."status" = 'APPROVED'
WHERE p."status" = 'REFUNDED'
  AND NOT EXISTS (
    SELECT 1 FROM "payment_adjustments" AS existing
    WHERE existing."paymentId" = p."id"
  );

COMMIT;
