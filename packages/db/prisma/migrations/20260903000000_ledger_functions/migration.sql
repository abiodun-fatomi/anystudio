-- The credit ledger's invariants live in the database, not the application.
-- An ORM can be bypassed; a trigger cannot.
--
-- A NOTE ON IDENTIFIERS, because it has already cost one failed deploy:
-- schema.prisma maps TABLE names to snake_case with @@map, but leaves FIELD
-- names alone. So the tables are `ledger_entries` and `wallets` while the
-- columns are "walletId", "balanceAfter", "idempotencyKey" and friends —
-- mixed case, and therefore double-quoted everywhere in raw SQL. Written
-- unquoted, Postgres folds them to lowercase and the statement fails with
-- `column "balance_after" does not exist`.

-- ---------------------------------------------------------------------------
-- 1. Append-only. Nothing rewrites history, whoever is asking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

-- ---------------------------------------------------------------------------
-- 2. Apply one entry, atomically.
--
-- Locks the wallet row so two concurrent spends serialise, reads the balance
-- from the last entry, refuses an overdraft, and appends. The idempotency key
-- is checked INSIDE the lock, so a retry that races the original cannot
-- double-spend — it returns the row the first call wrote.
--
-- Returns the resulting entry. Raises `insufficient_credits` (custom SQLSTATE
-- AS001) on overdraft so the application can map it to a clean 402.
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
  v_row        ledger_entries;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'ledger_apply: delta must be non-zero' USING ERRCODE = 'check_violation';
  END IF;
  -- Sign discipline: the kind says which way money moves; the caller may not
  -- contradict it. A "refund" of -50 is a bug, not a feature.
  IF (p_kind IN ('DEBIT','EXPIRY') AND p_delta > 0)
     OR (p_kind IN ('PURCHASE','REFUND','PROMO') AND p_delta < 0) THEN
    RAISE EXCEPTION 'ledger_apply: delta sign contradicts kind %', p_kind
      USING ERRCODE = 'check_violation';
  END IF;

  -- Serialise every write to this wallet.
  PERFORM 1 FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_apply: wallet % not found', p_wallet_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Idempotency, checked under the lock.
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

  IF v_balance + p_delta < 0 THEN
    RAISE EXCEPTION 'insufficient_credits: balance % delta %', v_balance, p_delta
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

-- ---------------------------------------------------------------------------
-- 3. Balance, read the cheap way. Also the drift check: if this ever disagrees
--    with SUM(delta), something wrote around the function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_balance(p_wallet_id uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT "balanceAfter" FROM ledger_entries
     WHERE "walletId" = p_wallet_id
     ORDER BY "createdAt" DESC, id DESC LIMIT 1
  ), 0);
$$;

CREATE OR REPLACE FUNCTION ledger_drift(p_wallet_id uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT ledger_balance(p_wallet_id)
       - COALESCE((SELECT SUM(delta) FROM ledger_entries WHERE "walletId" = p_wallet_id), 0);
$$;
