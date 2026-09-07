-- Several photos in one picture.
--
-- COLLAGE is ours end to end: sharp on the worker's own box, no vendor and
-- no ProviderConfig row, so this migration is the enum value and nothing
-- else. The credit cost (image.collage) comes from the seed, like every
-- other price.
--
-- Postgres will not add an enum value inside a transaction it then uses, so
-- this migration adds it alone; the value is available to the next one.
ALTER TYPE "ProviderCapability" ADD VALUE IF NOT EXISTS 'COLLAGE' AFTER 'UPSCALE';
