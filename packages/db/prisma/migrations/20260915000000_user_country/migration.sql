-- Where a person is, for pricing and defaults. ISO 3166-1 alpha-2.
ALTER TABLE "users" ADD COLUMN "country" VARCHAR(2);
-- Everyone so far signed up with a Nigerian number.
UPDATE "users" SET "country" = 'NG' WHERE "phone" LIKE '+234%';
UPDATE "users" SET "country" = 'GB' WHERE "phone" LIKE '+44%';
UPDATE "users" SET "country" = 'US' WHERE "phone" LIKE '+1%';
