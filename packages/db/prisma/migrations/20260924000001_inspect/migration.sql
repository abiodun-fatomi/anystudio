-- Is this photo the product?
--
-- INSPECT is a vision question, not a render: the pipeline asks a text model
-- that can see, through the TEXT_GENERATE route, so no ProviderConfig row of
-- its own is needed. This migration is the enum value and nothing else; the
-- price (image.inspect, one credit) comes from the seed like every other.
--
-- Postgres will not add an enum value inside a transaction it then uses, so
-- this migration adds it alone; the value is available to the next one.
ALTER TYPE "ProviderCapability" ADD VALUE IF NOT EXISTS 'INSPECT' AFTER 'LIPSYNC';
