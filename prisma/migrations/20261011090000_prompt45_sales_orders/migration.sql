-- Prompt 45 — Sales Orders + Fulfillment + Invoice Integration.
-- ADDITIVE ONLY (§119): two new tables + optional link columns on the
-- existing Sale / GoodsDispatch / GoodsDispatchLine tables. No existing
-- column is dropped or redefined — the three altered tables gain nullable
-- columns via plain SQLite ADD COLUMN (data-safe by construction; no
-- table-redefinition, no data copy).

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerNameAtOrder" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currencyCodeAtOrder" TEXT NOT NULL,
    "currencySymbolAtOrder" TEXT NOT NULL,
    "decimalPrecisionAtOrder" INTEGER NOT NULL,
    "orderDate" DATETIME NOT NULL,
    "expectedDate" DATETIME,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "confirmedAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesOrder_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SalesOrder_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderedQty" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "productNameAtOrder" TEXT NOT NULL,
    "skuAtOrder" TEXT,
    "unitAtOrder" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesOrderLine_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AddColumn (§52) — the ONE order-linked invoice. Nullable: every legacy
-- direct Sale keeps salesOrderId NULL. The UNIQUE index below is the
-- DATABASE authority behind "one invoice per order" (§52/§105).
ALTER TABLE "Sale" ADD COLUMN "salesOrderId" TEXT CONSTRAINT "Sale_salesOrderId_fkey" REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddColumn (§32/§35) — OPTIONAL order-fulfillment link. NOT unique: one
-- order is fulfilled by MANY dispatches (§3/§39).
ALTER TABLE "GoodsDispatch" ADD COLUMN "salesOrderId" TEXT CONSTRAINT "GoodsDispatch_salesOrderId_fkey" REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GoodsDispatch" ADD COLUMN "salesOrderReferenceAtDispatch" TEXT;

-- AddColumn (§32/§41) — OPTIONAL source-order line. NOT unique: one order
-- line is fulfilled across MANY dispatches (§39).
ALTER TABLE "GoodsDispatchLine" ADD COLUMN "salesOrderLineId" TEXT CONSTRAINT "GoodsDispatchLine_salesOrderLineId_fkey" REFERENCES "SalesOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "Sale_salesOrderId_key" ON "Sale"("salesOrderId");

-- CreateIndex
CREATE INDEX "GoodsDispatch_salesOrderId_idx" ON "GoodsDispatch"("salesOrderId");

-- CreateIndex
CREATE INDEX "GoodsDispatchLine_salesOrderLineId_idx" ON "GoodsDispatchLine"("salesOrderLineId");

-- CreateIndex
CREATE INDEX "SalesOrder_businessId_status_idx" ON "SalesOrder"("businessId", "status");

-- CreateIndex
CREATE INDEX "SalesOrder_businessId_createdAt_idx" ON "SalesOrder"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesOrder_businessId_orderDate_idx" ON "SalesOrder"("businessId", "orderDate");

-- CreateIndex
CREATE INDEX "SalesOrder_customerId_idx" ON "SalesOrder"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_businessId_reference_key" ON "SalesOrder"("businessId", "reference");

-- CreateIndex
CREATE INDEX "SalesOrderLine_salesOrderId_idx" ON "SalesOrderLine"("salesOrderId");

-- CreateIndex
CREATE INDEX "SalesOrderLine_productId_idx" ON "SalesOrderLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLine_salesOrderId_productId_key" ON "SalesOrderLine"("salesOrderId", "productId");
