-- Prompt 24 — seed datetime storage normalization.
--
-- LESSON (infrastructure): Prisma's SQLite adapter stores DateTime columns
-- as INTEGER unix-epoch MILLISECONDS. The Prompt 24 baseline seed in
-- migration 20260924113235_prompt24_price_books inserted the EUR-v1 rows
-- with ISO-8601 TEXT datetime literals; because SQLite's type ordering puts
-- INTEGER < TEXT, every range comparison (effectiveFrom <= now) against a
-- TEXT value silently fails and the seeded book would never resolve.
--
-- This migration normalizes the seeded rows to the integer-millis storage
-- Prisma writes. It is IDEMPOTENT: the typeof() guards make it a no-op once
-- values are already integers (and on fresh replays where migration 1 seeds
-- text again, this migration normalizes it right after — correct on every
-- replay order).
--
-- Epoch targets (all UTC):
--   2026-09-24T00:00:00.000Z = 1790208000000

UPDATE "PriceBook"
SET "effectiveFrom" = 1790208000000,
    "createdAt"     = 1790208000000,
    "updatedAt"     = 1790208000000
WHERE "id" = 'pricebook_eur_standard_v1'
  AND typeof("effectiveFrom") = 'text';

UPDATE "PriceBook"
SET "effectiveTo" = NULL
WHERE "id" = 'pricebook_eur_standard_v1'
  AND typeof("effectiveTo") = 'text'
  AND "effectiveTo" IS NULL;

UPDATE "PlanPrice"
SET "createdAt" = 1790208000000,
    "updatedAt" = 1790208000000
WHERE "priceBookId" = 'pricebook_eur_standard_v1'
  AND typeof("createdAt") = 'text';
