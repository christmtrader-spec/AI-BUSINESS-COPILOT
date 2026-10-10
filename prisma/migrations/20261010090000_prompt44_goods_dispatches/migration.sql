-- Prompt 44 — Goods Dispatch / Outbound Inventory (§44).
-- EXACTLY ONE additive migration: GoodsDispatch + GoodsDispatchLine.
-- No old-migration edits, no destructive operations.
-- All DDL is SQLite-supported table creation + index creation only.

-- CreateTable
CREATE TABLE "GoodsDispatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerNameAtDispatch" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "postedAt" DATETIME,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GoodsDispatch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GoodsDispatch_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "GoodsDispatch_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoodsDispatchLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goodsDispatchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "productNameAtDispatch" TEXT NOT NULL,
    "skuAtDispatch" TEXT,
    "unitAtDispatch" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GoodsDispatchLine_goodsDispatchId_fkey" FOREIGN KEY ("goodsDispatchId") REFERENCES "GoodsDispatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GoodsDispatchLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GoodsDispatch_businessId_status_idx" ON "GoodsDispatch"("businessId", "status");

-- CreateIndex
CREATE INDEX "GoodsDispatch_businessId_createdAt_idx" ON "GoodsDispatch"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "GoodsDispatch_businessId_postedAt_idx" ON "GoodsDispatch"("businessId", "postedAt");

-- CreateIndex
CREATE INDEX "GoodsDispatch_businessId_customerId_idx" ON "GoodsDispatch"("businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsDispatch_businessId_reference_key" ON "GoodsDispatch"("businessId", "reference");

-- CreateIndex
CREATE INDEX "GoodsDispatchLine_productId_idx" ON "GoodsDispatchLine"("productId");

-- CreateIndex
CREATE INDEX "GoodsDispatchLine_goodsDispatchId_idx" ON "GoodsDispatchLine"("goodsDispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsDispatchLine_goodsDispatchId_productId_key" ON "GoodsDispatchLine"("goodsDispatchId", "productId");
