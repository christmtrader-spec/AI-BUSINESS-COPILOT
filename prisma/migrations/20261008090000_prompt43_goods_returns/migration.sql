-- Prompt 43 — Goods Returns / Supplier Returns (§117).
-- EXACTLY ONE additive migration: GoodsReturn + GoodsReturnLine.
-- No old-migration edits, no destructive operations (§117/§118).
-- All DDL is SQLite-supported table creation + index creation only.

-- CreateTable
CREATE TABLE "GoodsReturn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "supplierNameAtReturn" TEXT NOT NULL,
    "goodsReceiptReferenceAtReturn" TEXT NOT NULL,
    "purchaseOrderReferenceAtReturn" TEXT NOT NULL,
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "postedAt" DATETIME,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GoodsReturn_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GoodsReturn_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GoodsReturn_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoodsReturnLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goodsReturnId" TEXT NOT NULL,
    "goodsReceiptLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "returnedQty" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "productNameAtReturn" TEXT NOT NULL,
    "skuAtReturn" TEXT,
    "unitAtReturn" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GoodsReturnLine_goodsReturnId_fkey" FOREIGN KEY ("goodsReturnId") REFERENCES "GoodsReturn" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GoodsReturnLine_goodsReceiptLineId_fkey" FOREIGN KEY ("goodsReceiptLineId") REFERENCES "GoodsReceiptLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GoodsReturnLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GoodsReturn_businessId_status_idx" ON "GoodsReturn"("businessId", "status");

-- CreateIndex
CREATE INDEX "GoodsReturn_businessId_createdAt_idx" ON "GoodsReturn"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "GoodsReturn_businessId_postedAt_idx" ON "GoodsReturn"("businessId", "postedAt");

-- CreateIndex
CREATE INDEX "GoodsReturn_businessId_goodsReceiptId_idx" ON "GoodsReturn"("businessId", "goodsReceiptId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReturn_businessId_reference_key" ON "GoodsReturn"("businessId", "reference");

-- CreateIndex
CREATE INDEX "GoodsReturnLine_goodsReceiptLineId_idx" ON "GoodsReturnLine"("goodsReceiptLineId");

-- CreateIndex
CREATE INDEX "GoodsReturnLine_productId_idx" ON "GoodsReturnLine"("productId");

-- CreateIndex
CREATE INDEX "GoodsReturnLine_goodsReturnId_idx" ON "GoodsReturnLine"("goodsReturnId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReturnLine_goodsReturnId_goodsReceiptLineId_key" ON "GoodsReturnLine"("goodsReturnId", "goodsReceiptLineId");

