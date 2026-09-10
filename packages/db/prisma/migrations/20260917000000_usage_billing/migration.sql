-- Usage-based billing: postpaid organizations, a rate card, monthly invoices,
-- and the one change the ledger needs — a wallet may be allowed below zero.

ALTER TYPE "PaymentKind" ADD VALUE IF NOT EXISTS 'INVOICE';

CREATE TYPE "BillingAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'OVERDUE', 'VOID');

ALTER TABLE "wallets" ADD COLUMN "overdraftLimit" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "usage_rates" (
    "currency" TEXT NOT NULL,
    "per100Minor" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "usage_rates_pkey" PRIMARY KEY ("currency")
);

CREATE TABLE "billing_accounts" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "status" "BillingAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" TEXT NOT NULL,
    "per100Minor" INTEGER,
    "minimumMinor" INTEGER NOT NULL DEFAULT 0,
    "creditLimit" INTEGER NOT NULL,
    "netDays" INTEGER NOT NULL DEFAULT 14,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "billingEmail" TEXT,
    "billTo" JSONB,
    "notes" TEXT,
    "limitWarnedFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_accounts_workspaceId_key" ON "billing_accounts"("workspaceId");
CREATE INDEX "billing_accounts_status_idx" ON "billing_accounts"("status");
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "per100Minor" INTEGER NOT NULL,
    "usageMinor" INTEGER NOT NULL,
    "minimumMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "lines" JSONB NOT NULL,
    "billTo" JSONB,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidVia" TEXT,
    "paidReference" TEXT,
    "paymentId" UUID,
    "ledgerEntryId" UUID,
    "remindedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");
CREATE UNIQUE INDEX "invoices_accountId_periodStart_key" ON "invoices"("accountId", "periodStart");
CREATE INDEX "invoices_workspaceId_issuedAt_idx" ON "invoices"("workspaceId", "issuedAt");
CREATE INDEX "invoices_status_dueAt_idx" ON "invoices"("status", "dueAt");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "billing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ledger_apply, now honouring the wallet's overdraft limit. Identical to the
-- 20260903 version otherwise: same lock, same idempotency check under it,
-- same sign discipline. The limit is read in the same FOR UPDATE that
-- serialises the write, so a staff change to the limit and a spend cannot
-- interleave.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_apply(
  p_wallet_id        uuid,
  p_kind             "LedgerKind",
  p_delta            integer,
  p_idempotency_key  text,
  p_reference_id     uuid    DEFAULT NULL,
  p_reason           text    DEFAULT NULL,
  p_actor_id         uuid    DEFAULT NULL
) RETURNS ledger_entries
LANGUAGE plpgsql AS $$
DECLARE
  v_existing   ledger_entries;
  v_balance    integer;
  v_overdraft  integer;
  v_row        ledger_entries;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'ledger_apply: delta must be non-zero' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_kind IN ('DEBIT','EXPIRY') AND p_delta > 0)
     OR (p_kind IN ('PURCHASE','REFUND','PROMO') AND p_delta < 0) THEN
    RAISE EXCEPTION 'ledger_apply: delta sign contradicts kind %', p_kind
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT "overdraftLimit" INTO v_overdraft FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_apply: wallet % not found', p_wallet_id
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

  -- Below zero is allowed only as far as the wallet's overdraft says.
  IF v_balance + p_delta < -COALESCE(v_overdraft, 0) THEN
    RAISE EXCEPTION 'insufficient_credits: balance % delta % overdraft %', v_balance, p_delta, v_overdraft
      USING ERRCODE = 'AS001';
  END IF;

  INSERT INTO ledger_entries
    (id, "walletId", kind, delta, "balanceAfter", "referenceId", "idempotencyKey", reason, "actorId", "createdAt")
  VALUES
    (gen_random_uuid(), p_wallet_id, p_kind, p_delta, v_balance + p_delta,
     p_reference_id, p_idempotency_key, p_reason, p_actor_id, now())
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;
