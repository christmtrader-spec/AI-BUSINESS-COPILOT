-- Prompt 47 — Sales Quotations + conversion traceability.
-- ADDITIVE ONLY (§2.8): two new tables + one optional link column on the
-- existing SalesOrder table. No existing column is dropped or redefined —
-- the altered table gains a nullable column via plain SQLite ADD COLUMN
-- (data-safe by construction; no table-redefinition, no data copy). Every
-- existing SalesOrder row keeps sourceQuotationId NULL and remains valid.

-- CreateTable (§5)
CREATE TABLE "SalesQuotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerNameAtQuotation" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currencyCodeAtQuotation" TEXT NOT NULL,
    "currencySymbolAtQuotation" TEXT NOT NULL,
    "decimalPrecisionAtQuotation" INTEGER NOT NULL,
    "quotationDate" DATETIME NOT NULL,
    "validUntilDate" DATETIME NOT NULL,
    "expectedDeliveryDate" DATETIME,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "customerNotes" TEXT,
    "internalNotes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "sentAt" DATETIME,
    "acceptedAt" DATETIME,
    "rejectedAt" DATETIME,
    "cancelledAt" DATETIME,
    "convertedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesQuotation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesQuotation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SalesQuotation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable (§6)
CREATE TABLE "SalesQuotationLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesQuotationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "productNameAtQuotation" TEXT NOT NULL,
    "skuAtQuotation" TEXT,
    "unitAtQuotation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesQuotationLine_salesQuotationId_fkey" FOREIGN KEY ("salesQuotationId") REFERENCES "SalesQuotation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesQuotationLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AddColumn (§7) — the ONE authoritative source-quotation link. Nullable:
-- every legacy/direct order keeps sourceQuotationId NULL. The UNIQUE index
-- below is the DATABASE authority behind "one quotation → at most one
-- SalesOrder" (§7/§13) — a losing concurrent conversion is a constraint
-- violation, never a second order.
ALTER TABLE "SalesOrder" ADD COLUMN "sourceQuotationId" TEXT CONSTRAINT "SalesOrder_sourceQuotationId_fkey" REFERENCES "SalesQuotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex (§7/§13) — conversion-race authority.
CREATE UNIQUE INDEX "SalesOrder_sourceQuotationId_key" ON "SalesOrder"("sourceQuotationId");

-- CreateIndex (§6) — business-scoped quotation listing + status filtering.
CREATE INDEX "SalesQuotation_businessId_status_idx" ON "SalesQuotation"("businessId", "status");

-- CreateIndex (§6) — quotation-date filtering (business-timezone windows).
CREATE INDEX "SalesQuotation_businessId_quotationDate_idx" ON "SalesQuotation"("businessId", "quotationDate");

-- CreateIndex (§6/§9) — validity filtering / expiration scans.
CREATE INDEX "SalesQuotation_businessId_validUntilDate_idx" ON "SalesQuotation"("businessId", "validUntilDate");

-- CreateIndex (§6/§19) — customer quotation history.
CREATE INDEX "SalesQuotation_customerId_idx" ON "SalesQuotation"("customerId");

-- CreateIndex (§5/§10) — business-local unique reference (concurrency
-- safe: duplicate inserts lose the race with a constraint error → 409).
CREATE UNIQUE INDEX "SalesQuotation_businessId_reference_key" ON "SalesQuotation"("businessId", "reference");

-- CreateIndex (§6) — quotation-to-order traceability / bounded detail reads.
CREATE INDEX "SalesQuotationLine_salesQuotationId_idx" ON "SalesQuotationLine"("salesQuotationId");

-- CreateIndex (§6/§19) — product quotation history.
CREATE INDEX "SalesQuotationLine_productId_idx" ON "SalesQuotationLine"("productId");

-- CreateIndex (§6) — at most one line per product per quotation (stable
-- duplicate-product rejection, §6/§11).
CREATE UNIQUE INDEX "SalesQuotationLine_salesQuotationId_productId_key" ON "SalesQuotationLine"("salesQuotationId", "productId");
