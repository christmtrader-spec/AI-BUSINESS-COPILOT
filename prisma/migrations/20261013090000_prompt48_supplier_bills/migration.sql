-- Prompt 48 — Supplier Bills & Accounts Payable Documents (additive).
-- Creates exactly two new tables + their indexes/constraints. No existing
-- table is altered, rewritten, or dropped; existing rows stay untouched.
-- SupplierBill.expenseId → Expense.id is nullable + unique (at most one
-- payable per bill; NULL for DRAFT/CANCELLED). The reciprocal relation is
-- logical only (Expense gains no column).

-- ---------------------------------------------------------------------------
-- SupplierBill
-- ---------------------------------------------------------------------------
CREATE TABLE "SupplierBill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "supplierInvoiceReference" TEXT,
    "supplierNameAtBill" TEXT NOT NULL,
    "purchaseOrderReferenceAtBill" TEXT NOT NULL,
    "currencyCodeAtBill" TEXT NOT NULL,
    "currencySymbolAtBill" TEXT NOT NULL,
    "decimalPrecisionAtBill" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "billDate" DATETIME NOT NULL,
    "dueDate" DATETIME,
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "internalNotes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "postedAt" DATETIME,
    "cancelledAt" DATETIME,
    "expenseId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SupplierBill_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- Restrict: the supplier row must outlive its bill documents (soft-delete only).
    CONSTRAINT "SupplierBill_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Restrict: a posted bill never silently loses its source PO.
    CONSTRAINT "SupplierBill_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Restrict: the creator link follows the P40–P47 creator policy.
    CONSTRAINT "SupplierBill_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- SetNull: only ever fires inside business-cascade deletion, where the
    -- bill row is removed by the same cascade (see schema comment).
    CONSTRAINT "SupplierBill_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Business-local unique internal reference (concurrency-safe duplicates).
CREATE UNIQUE INDEX "SupplierBill_businessId_reference_key" ON "SupplierBill"("businessId", "reference");
-- Supplier invoice reference unique per (business, supplier); SQLite
-- multi-NULL semantics keep invoice-less bills conflict-free.
CREATE UNIQUE INDEX "SupplierBill_businessId_supplierId_supplierInvoiceReference_key" ON "SupplierBill"("businessId", "supplierId", "supplierInvoiceReference");
-- At most one payable per bill (the §2 no-duplicate-payable law, DB-enforced).
CREATE UNIQUE INDEX "SupplierBill_expenseId_key" ON "SupplierBill"("expenseId");

CREATE INDEX "SupplierBill_businessId_status_idx" ON "SupplierBill"("businessId", "status");
CREATE INDEX "SupplierBill_businessId_createdAt_idx" ON "SupplierBill"("businessId", "createdAt");
CREATE INDEX "SupplierBill_businessId_billDate_idx" ON "SupplierBill"("businessId", "billDate");
CREATE INDEX "SupplierBill_businessId_dueDate_idx" ON "SupplierBill"("businessId", "dueDate");
CREATE INDEX "SupplierBill_businessId_purchaseOrderId_idx" ON "SupplierBill"("businessId", "purchaseOrderId");
CREATE INDEX "SupplierBill_businessId_supplierId_idx" ON "SupplierBill"("businessId", "supplierId");

-- ---------------------------------------------------------------------------
-- SupplierBillLine
-- ---------------------------------------------------------------------------
CREATE TABLE "SupplierBillLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierBillId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "billedQty" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,
    "productNameAtBill" TEXT NOT NULL,
    "skuAtBill" TEXT,
    "unitAtBill" TEXT,
    "purchaseOrderUnitPriceMinor" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SupplierBillLine_supplierBillId_fkey" FOREIGN KEY ("supplierBillId") REFERENCES "SupplierBill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- Restrict: the PO line is the procurement authority; the chain only
    -- ever fires at business deletion (mirrors GoodsReceiptLine).
    CONSTRAINT "SupplierBillLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Restrict: a hard product delete can never destroy bill history.
    CONSTRAINT "SupplierBillLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- A PO line appears AT MOST ONCE per bill document (§6).
CREATE UNIQUE INDEX "SupplierBillLine_supplierBillId_purchaseOrderLineId_key" ON "SupplierBillLine"("supplierBillId", "purchaseOrderLineId");

CREATE INDEX "SupplierBillLine_supplierBillId_idx" ON "SupplierBillLine"("supplierBillId");
CREATE INDEX "SupplierBillLine_purchaseOrderLineId_idx" ON "SupplierBillLine"("purchaseOrderLineId");
CREATE INDEX "SupplierBillLine_productId_idx" ON "SupplierBillLine"("productId");
