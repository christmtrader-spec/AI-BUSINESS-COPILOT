-- CreateTable
CREATE TABLE "PriceBook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATETIME,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "priceBookId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "billingPeriod" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlanPrice_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CheckoutSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "billingPeriod" TEXT NOT NULL DEFAULT 'MONTHLY',
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reconciliationReason" TEXT,
    "pricingVersion" TEXT,
    "priceBookId" TEXT,
    "priceBookCode" TEXT,
    "initiatedByUserId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "fulfilledAt" DATETIME,
    "metaJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CheckoutSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CheckoutSession_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_CheckoutSession" ("amountMinor", "billingPeriod", "businessId", "completedAt", "createdAt", "currency", "expiresAt", "fulfilledAt", "id", "initiatedByUserId", "metaJson", "planCode", "pricingVersion", "provider", "providerRef", "reconciliationReason", "status", "updatedAt") SELECT "amountMinor", "billingPeriod", "businessId", "completedAt", "createdAt", "currency", "expiresAt", "fulfilledAt", "id", "initiatedByUserId", "metaJson", "planCode", "pricingVersion", "provider", "providerRef", "reconciliationReason", "status", "updatedAt" FROM "CheckoutSession";
DROP TABLE "CheckoutSession";
ALTER TABLE "new_CheckoutSession" RENAME TO "CheckoutSession";
CREATE INDEX "CheckoutSession_businessId_createdAt_idx" ON "CheckoutSession"("businessId", "createdAt");
CREATE INDEX "CheckoutSession_status_expiresAt_idx" ON "CheckoutSession"("status", "expiresAt");
CREATE UNIQUE INDEX "CheckoutSession_provider_providerRef_key" ON "CheckoutSession"("provider", "providerRef");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PriceBook_currency_active_idx" ON "PriceBook"("currency", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBook_code_version_key" ON "PriceBook"("code", "version");

-- CreateIndex
CREATE INDEX "PlanPrice_priceBookId_active_idx" ON "PlanPrice"("priceBookId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PlanPrice_priceBookId_planCode_billingPeriod_key" ON "PlanPrice"("priceBookId", "planCode", "billingPeriod");

-- ---------------------------------------------------------------------------
-- Prompt 24 §28/§37 — idempotent EUR-v1 seed.
--
-- Migrates the previously hard-coded Prompt 22 prices (src/lib/payments/
-- pricing.ts) into the database catalog WITHOUT changing any amount:
--   STARTER  monthly 900   yearly 9000
--   BUSINESS monthly 1900  yearly 19000
--   PRO      monthly 4900  yearly 49000
-- YEARLY rows are EXPLICIT stored amounts (the 10× policy becomes data,
-- never runtime arithmetic — §21/§61). Deterministic ids + INSERT OR IGNORE
-- make this seed re-runnable; existing rows are never modified. FREE and
-- ENTERPRISE get NO price rows (§38/§39).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO "PriceBook" ("id", "code", "version", "currency", "active", "effectiveFrom", "effectiveTo", "description", "createdAt", "updatedAt")
VALUES (
  'pricebook_eur_standard_v1', 'EUR_STANDARD', 'v1-2026-09', 'EUR', 1,
  '2026-09-24T00:00:00.000Z', NULL,
  'Prompt 24 baseline catalog — migrated verbatim from the Prompt 22 EUR prices. Amounts unchanged; yearly = 2 months free (10x monthly).',
  '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'
);

INSERT OR IGNORE INTO "PlanPrice" ("id", "priceBookId", "planCode", "billingPeriod", "amountMinor", "active", "createdAt", "updatedAt")
VALUES
  ('planprice_eur_v1_starter_m',  'pricebook_eur_standard_v1', 'STARTER',  'MONTHLY', 900,   1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'),
  ('planprice_eur_v1_starter_y',  'pricebook_eur_standard_v1', 'STARTER',  'YEARLY',  9000,  1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'),
  ('planprice_eur_v1_business_m', 'pricebook_eur_standard_v1', 'BUSINESS', 'MONTHLY', 1900,  1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'),
  ('planprice_eur_v1_business_y', 'pricebook_eur_standard_v1', 'BUSINESS', 'YEARLY',  19000, 1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'),
  ('planprice_eur_v1_pro_m',      'pricebook_eur_standard_v1', 'PRO',      'MONTHLY', 4900,  1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'),
  ('planprice_eur_v1_pro_y',      'pricebook_eur_standard_v1', 'PRO',      'YEARLY',  49000, 1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
