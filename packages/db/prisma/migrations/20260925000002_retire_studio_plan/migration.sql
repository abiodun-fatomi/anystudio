-- Studio is no longer offered. Keep the row for subscription and invoice
-- history; inactive plans are excluded from the catalogue and new checkout.
-- The seed no longer creates Studio, so future releases will not restore it.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '1min';
UPDATE "plans"
SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'studio' AND "active" = true;
COMMIT;
