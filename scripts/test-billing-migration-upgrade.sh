#!/usr/bin/env bash
# Exercise the newest billing migration as an upgrade, and prove its duplicate
# preflight is atomic. CI supplies two disposable PostgreSQL 18 databases.

set -euo pipefail

UPGRADE_URL="${BILLING_UPGRADE_DATABASE_URL:?BILLING_UPGRADE_DATABASE_URL is required}"
REJECT_URL="${BILLING_REJECT_DATABASE_URL:?BILLING_REJECT_DATABASE_URL is required}"
TARGET=packages/db/prisma/migrations/20260922000000_billing_invariants/migration.sql
PROVIDER_TARGET=packages/db/prisma/migrations/20260922000001_provider_pricing_reconciliation/migration.sql
ATTEMPT_TARGET=packages/db/prisma/migrations/20260922000002_provider_attempts/migration.sql
REFUND_CYCLE_TARGET=packages/db/prisma/migrations/20260922000003_refund_cycles/migration.sql
LEDGER_TARGET=packages/db/prisma/migrations/20260922000004_authoritative_ledger_balance/migration.sql
LEGACY_REFUND_TARGET=packages/db/prisma/migrations/20260922000005_legacy_refund_adjustments/migration.sql
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

mkdir -p "$SCRATCH/prisma"
cp packages/db/prisma/schema.prisma "$SCRATCH/prisma/schema.prisma"
cp -R packages/db/prisma/migrations "$SCRATCH/prisma/migrations"
# Keep this an actual upgrade from the migration immediately before TARGET.
# Later migrations may be added after this harness; letting them run here
# would silently turn this into a non-chronological schema state.
for migration in "$SCRATCH"/prisma/migrations/*; do
  [[ -d "$migration" ]] || continue
  name="${migration##*/}"
  if [[ "$name" > "20260922000000_billing_invariants" || "$name" == "20260922000000_billing_invariants" ]]; then
    rm -rf -- "$migration"
  fi
done

apply_previous() {
  local url="$1"
  DATABASE_URL="$url" DIRECT_URL="$url" \
    pnpm --filter @anystudio/db exec prisma migrate deploy --schema "$SCRATCH/prisma/schema.prisma" >/dev/null
}

apply_previous "$UPGRADE_URL"
apply_previous "$REJECT_URL"

# A real old-shape row: catalogueRef does not exist yet and Flutterwave's
# providerRef contains the true subscription id while the plan catalogue owns
# the billing-plan id used by the backfill.
psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "workspaces" (id, type, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'BUSINESS', 'Upgrade fixture');
INSERT INTO "wallets" (id, "workspaceId", currency, "overdraftLimit")
VALUES ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', 'NGN', 0);
INSERT INTO "plans" (code, credits, "priceByMarket", "providerRefs", "updatedAt")
VALUES (
  'growth', 100, '{"NGN":1000}',
  '{"flutterwave":{"month":"flw-plan-growth"},"paddle":{"month":"pri_growth"}}', now()
);
INSERT INTO "subscriptions" (
  id, "workspaceId", provider, "providerRef", "planCode", interval, status, "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'FLUTTERWAVE', 'flw-subscription-42', 'growth', 'month', 'ACTIVE', now()
);
INSERT INTO "payments" (
  id, "workspaceId", provider, kind, status, reference, "providerRef",
  "itemCode", credits, "amountMinor", currency, "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000001',
  'FLUTTERWAVE', 'SUBSCRIPTION', 'SUCCEEDED', 'upgrade-payment',
  'flw-charge-42', 'growth', 100, 1000, 'NGN', now()
);
INSERT INTO "payments" (
  id, "workspaceId", provider, kind, status, reference, "providerRef",
  "itemCode", credits, "amountMinor", currency, "refundedAt", "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000001',
  'FLUTTERWAVE', 'PACK', 'REFUNDED', 'upgrade-legacy-refund',
  'flw-charge-refunded', 'pack.legacy', 100, 1000, 'NGN', now(), now()
);
INSERT INTO "refund_requests" (
  id, "paymentId", "workspaceId", "requestedById", reason, status,
  "balanceAtRequest", "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000005',
  'upgrade test', 'REQUESTED', 100, now()
);
INSERT INTO "refund_requests" (
  id, "paymentId", "workspaceId", "requestedById", reason, status,
  "balanceAtRequest", "decidedAt", "decisionNote", "updatedAt"
) VALUES (
  '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000005',
  'legacy approved refund', 'APPROVED', 100, now(), 'flw-refund-legacy', now()
);
INSERT INTO "ledger_entries" (
  id, "walletId", kind, delta, "balanceAfter", "referenceId",
  "idempotencyKey", reason, "createdAt"
) VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000007',
   'PURCHASE', 100, 100, '00000000-0000-4000-8000-000000000008',
   'payment:00000000-0000-4000-8000-000000000008', 'legacy purchase', now()),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000007',
   'ADJUSTMENT', -100, 0, '00000000-0000-4000-8000-000000000008',
   'payment:00000000-0000-4000-8000-000000000008:clawback', 'legacy refund', now());
INSERT INTO "webhook_receipts" (
  id, provider, "eventId", "eventType", "signatureOk", payload
) VALUES (
  '00000000-0000-4000-8000-000000000006',
  'FLUTTERWAVE', 'upgrade-event', 'charge.completed', true, '{}'
);
INSERT INTO "provider_models" (
  "key", capability, priority, "costPerCall", enabled, config, "updatedAt"
) VALUES
  ('vertex:veo-3.1-fast', 'IMAGE_TO_VIDEO', 30, 260, true, '{}', now()),
  ('fal:wan-2.5-i2v', 'IMAGE_TO_VIDEO', 10, 80, true, '{}', now()),
  ('openai:sora-2', 'IMAGE_TO_VIDEO', 20, 80, true, '{}', now()),
  ('fal:minimax-music-v2', 'MUSIC', 20, 30, true, '{}', now());
INSERT INTO "credit_costs" (code, credits, label, "updatedAt") VALUES
  ('audio.music.preview', 10, 'Song preview', now()),
  ('audio.music.preview.my_voice', 25, 'Song preview, sung in your voice', now()),
  ('audio.music.unlock', 30, 'Unlock the full song', now()),
  ('video.translate', 90, 'Translate a video (voice only)', now()),
  ('video.translate_lipsync', 240, 'Translate a video with matching lips', now()),
  ('video.lipsync', 150, 'Lip-sync new words onto a video', now());
SQL

psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$TARGET" >/dev/null

psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF (SELECT "catalogueRef" FROM "subscriptions" WHERE id = '00000000-0000-4000-8000-000000000002') <> 'flw-plan-growth' THEN
    RAISE EXCEPTION 'catalogueRef backfill did not preserve the legacy Flutterwave subscription';
  END IF;
  IF to_regclass('public."payments_provider_providerRef_key"') IS NULL
     OR to_regclass('public.subscriptions_one_live_per_workspace_idx') IS NULL
     OR to_regclass('public."subscriptions_flutterwave_providerRef_key"') IS NULL
     OR to_regclass('public."subscriptions_paddle_providerRef_key"') IS NULL
     OR to_regclass('public.payment_adjustments') IS NULL THEN
    RAISE EXCEPTION 'one or more billing invariant objects are missing';
  END IF;
  IF to_regclass('public."payments_provider_providerRef_idx"') IS NOT NULL THEN
    RAISE EXCEPTION 'obsolete non-unique payment provider index still exists';
  END IF;
  IF to_regprocedure('ledger_force_clawback(uuid,integer,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'ledger_force_clawback function is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'RefundRequestStatus' AND e.enumlabel = 'NEEDS_REVIEW'
  ) THEN
    RAISE EXCEPTION 'RefundRequestStatus.NEEDS_REVIEW is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'webhook_receipts' AND column_name = 'nextAttemptAt'
  ) THEN
    RAISE EXCEPTION 'webhook receipt recovery columns are missing';
  END IF;
END $$;
SQL

psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$PROVIDER_TARGET" >/dev/null

psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "provider_models"
    WHERE "key" = 'vertex:veo-3.1-fast' AND capability = 'IMAGE_TO_VIDEO'
      AND priority = 10 AND "costPerCall" = 80 AND config @> '{"resolution":"720p","costPerSecondMinor":10}'::jsonb
  ) THEN
    RAISE EXCEPTION 'Veo routing/cost reconciliation failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "provider_models"
    WHERE "key" = 'fal:wan-2.5-i2v' AND capability = 'IMAGE_TO_VIDEO' AND priority = 20
  ) THEN
    RAISE EXCEPTION 'Wan fallback priority reconciliation failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "provider_models"
    WHERE "key" = 'openai:sora-2' AND capability = 'IMAGE_TO_VIDEO' AND enabled = false AND priority = 90
  ) THEN
    RAISE EXCEPTION 'Sora retirement reconciliation failed';
  END IF;
  IF (SELECT "costPerCall" FROM "provider_models" WHERE "key" = 'fal:minimax-music-v2' AND capability = 'MUSIC') <> 3 THEN
    RAISE EXCEPTION 'MiniMax music cost reconciliation failed';
  END IF;
  IF (SELECT credits FROM "credit_costs" WHERE code = 'audio.music.unlock') <> 10
     OR (SELECT credits FROM "credit_costs" WHERE code = 'audio.music.preview.my_voice') <> 20 THEN
    RAISE EXCEPTION 'music credit reconciliation failed';
  END IF;
END $$;
SQL

# Apply every later migration in chronological order, just as an existing
# deployment that already recorded the old checksums will.
psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$ATTEMPT_TARGET" >/dev/null
psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$REFUND_CYCLE_TARGET" >/dev/null
psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$LEDGER_TARGET" >/dev/null
psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$LEGACY_REFUND_TARGET" >/dev/null

psql "$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$
DECLARE
  migrated "payment_adjustments";
BEGIN
  SELECT * INTO migrated FROM "payment_adjustments"
   WHERE "paymentId" = '00000000-0000-4000-8000-000000000008';
  IF migrated."providerRef" <> 'legacy-refund:00000000-0000-4000-8000-000000000008'
     OR migrated."status" <> 'SUCCEEDED'
     OR migrated."amountDeltaMinor" <> -1000
     OR migrated."creditDelta" <> -100
     OR migrated."ledgerRevision" <> 1
     OR migrated."refundCycle" <> 0 THEN
    RAISE EXCEPTION 'legacy refunded payment was not represented by its exact historical money/credit deltas';
  END IF;
  IF migrated.payload->>'reportedProviderRef' <> 'flw-refund-legacy' THEN
    RAISE EXCEPTION 'legacy provider refund reference was not retained for audit';
  END IF;
END $$;

INSERT INTO "ledger_entries" (
  id, "walletId", kind, delta, "balanceAfter", "idempotencyKey", reason, "createdAt"
) VALUES
  ('ffffffff-ffff-4fff-8fff-000000000001', '00000000-0000-4000-8000-000000000007', 'PROMO', 100, 100, 'upgrade-tied-one', 'upgrade regression', now()),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000007', 'DEBIT', -30, 70, 'upgrade-tied-two', 'upgrade regression', now());

SELECT ledger_apply(
  '00000000-0000-4000-8000-000000000007', 'PURCHASE', 10,
  'upgrade-purchase', NULL, 'upgrade regression', NULL
);
SELECT ledger_force_clawback(
  '00000000-0000-4000-8000-000000000007', 20,
  'upgrade-force', NULL, 'upgrade regression'
);

DO $$
BEGIN
  IF ledger_balance('00000000-0000-4000-8000-000000000007') <> 60 THEN
    RAISE EXCEPTION 'authoritative ledger balance did not use SUM(delta)';
  END IF;
  IF ledger_drift('00000000-0000-4000-8000-000000000007') <> 0 THEN
    RAISE EXCEPTION 'authoritative ledger compatibility check was nonzero';
  END IF;
  IF (SELECT "balanceAfter" FROM "ledger_entries" WHERE "idempotencyKey" = 'upgrade-purchase') <> 80
     OR (SELECT "balanceAfter" FROM "ledger_entries" WHERE "idempotencyKey" = 'upgrade-force') <> 60 THEN
    RAISE EXCEPTION 'ledger writes followed timestamp/UUID order instead of signed deltas';
  END IF;
END $$;
COMMIT;
SQL

# Duplicate provider truth must stop before any DDL commits.
psql "$REJECT_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "workspaces" (id, type, name)
VALUES ('10000000-0000-4000-8000-000000000001', 'BUSINESS', 'Reject fixture');
INSERT INTO "payments" (
  id, "workspaceId", provider, kind, status, reference, "providerRef",
  "itemCode", credits, "amountMinor", currency, "updatedAt"
) VALUES
  ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'FLUTTERWAVE', 'PACK', 'SUCCEEDED', 'duplicate-a', 'same-charge', 'pack', 10, 100, 'NGN', now()),
  ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'FLUTTERWAVE', 'PACK', 'SUCCEEDED', 'duplicate-b', 'same-charge', 'pack', 10, 100, 'NGN', now());
SQL

if psql "$REJECT_URL" -v ON_ERROR_STOP=1 -f "$TARGET" >/dev/null 2>&1; then
  echo "billing migration unexpectedly accepted duplicate provider transactions" >&2
  exit 1
fi

psql "$REJECT_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF to_regclass('public."payments_provider_providerRef_key"') IS NOT NULL THEN
    RAISE EXCEPTION 'failed migration left its unique index behind';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'catalogueRef'
  ) THEN
    RAISE EXCEPTION 'failed migration left subscription columns behind';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'RefundRequestStatus' AND e.enumlabel = 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'failed migration left enum values behind';
  END IF;
END $$;
SQL

echo "✔ billing/provider/ledger migrations upgrade legacy rows and billing preflight rolls back atomically"
