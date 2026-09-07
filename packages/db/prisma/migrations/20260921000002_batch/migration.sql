-- A batch: one parent holding the money, one child per photo doing the work.
--
-- No ProviderConfig row and no adapter — a batch never calls a vendor itself,
-- it creates ordinary children that do. The price is the child's own credit
-- cost times the number of photos, worked out on the server from the params.
ALTER TYPE "ProviderCapability" ADD VALUE IF NOT EXISTS 'BATCH' AFTER 'PRODUCT_SHOT';
