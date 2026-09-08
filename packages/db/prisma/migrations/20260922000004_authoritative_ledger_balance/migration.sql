-- A ledger row's UUID is random and `now()` is the transaction start time.
-- Consequently, entries written by one transaction (and transactions that
-- waited on the wallet lock) cannot be put back into financial order with
-- ORDER BY "createdAt", id. The signed entries are the source of truth; every
-- balance decision must aggregate them while holding the wallet row lock.
--
-- This is a new forward migration rather than an edit to 20260903/20260917:
-- databases that already recorded those migration checksums must receive the
-- correction too. A fresh install ends at these definitions for the same
-- reason.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

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

  -- This lock is the serialization point for every supported ledger write.
  SELECT "overdraftLimit" INTO v_overdraft
    FROM wallets
   WHERE id = p_wallet_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_apply: wallet % not found', p_wallet_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT * INTO v_existing
    FROM ledger_entries
   WHERE "walletId" = p_wallet_id
     AND "idempotencyKey" = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT COALESCE(SUM(delta), 0)::integer INTO v_balance
    FROM ledger_entries
   WHERE "walletId" = p_wallet_id;

  IF v_balance + p_delta < -COALESCE(v_overdraft, 0) THEN
    RAISE EXCEPTION 'insufficient_credits: balance % delta % overdraft %', v_balance, p_delta, v_overdraft
      USING ERRCODE = 'AS001';
  END IF;

  INSERT INTO ledger_entries
    (id, "walletId", kind, delta, "balanceAfter", "referenceId", "idempotencyKey", reason, "actorId", "createdAt")
  VALUES
    (gen_random_uuid(), p_wallet_id, p_kind, p_delta, v_balance + p_delta,
     p_reference_id, p_idempotency_key, p_reason, p_actor_id, clock_timestamp())
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;

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

  SELECT * INTO v_existing
    FROM ledger_entries
   WHERE "walletId" = p_wallet_id
     AND "idempotencyKey" = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT COALESCE(SUM(delta), 0)::integer INTO v_balance
    FROM ledger_entries
   WHERE "walletId" = p_wallet_id;

  INSERT INTO ledger_entries
    (id, "walletId", kind, delta, "balanceAfter", "referenceId", "idempotencyKey", reason, "actorId", "createdAt")
  VALUES
    (gen_random_uuid(), p_wallet_id, 'ADJUSTMENT', -p_amount, v_balance - p_amount,
     p_reference_id, p_idempotency_key, p_reason, NULL, clock_timestamp())
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;

-- The aggregate is authoritative. `balanceAfter` remains a useful per-entry
-- audit snapshot, but it is deliberately not used to decide spendability.
CREATE OR REPLACE FUNCTION ledger_balance(p_wallet_id uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(delta), 0)::integer
    FROM ledger_entries
   WHERE "walletId" = p_wallet_id;
$$;

-- Kept for API/operations compatibility. Because both sides now use the same
-- authoritative aggregate, a successful query reports zero. PostgreSQL still
-- raises on an invalid/overflowing aggregate instead of presenting a false
-- cached balance as trustworthy.
CREATE OR REPLACE FUNCTION ledger_drift(p_wallet_id uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT ledger_balance(p_wallet_id)
       - COALESCE((SELECT SUM(delta)::integer FROM ledger_entries WHERE "walletId" = p_wallet_id), 0);
$$;

COMMIT;
