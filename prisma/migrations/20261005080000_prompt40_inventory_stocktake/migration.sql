-- CreateTable
CREATE TABLE "InventoryStocktake" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "countType" TEXT NOT NULL DEFAULT 'SELECTED',
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "startedAt" DATETIME,
    "reviewedAt" DATETIME,
    "finalizedAt" DATETIME,
    "canceledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryStocktake_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InventoryStocktake_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryStocktakeLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stocktakeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "systemQtyAtCount" INTEGER NOT NULL,
    "countedQty" INTEGER NOT NULL,
    "varianceQty" INTEGER NOT NULL,
    "countedAt" DATETIME NOT NULL,
    "countedByUserId" TEXT NOT NULL,
    "productNameAtCount" TEXT NOT NULL,
    "skuAtCount" TEXT,
    "unitAtCount" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryStocktakeLine_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "InventoryStocktake" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InventoryStocktakeLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InventoryStocktakeLine_countedByUserId_fkey" FOREIGN KEY ("countedByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InventoryStocktake_businessId_status_idx" ON "InventoryStocktake"("businessId", "status");

-- CreateIndex
CREATE INDEX "InventoryStocktake_businessId_createdAt_idx" ON "InventoryStocktake"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryStocktake_businessId_createdByUserId_idx" ON "InventoryStocktake"("businessId", "createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryStocktake_businessId_reference_key" ON "InventoryStocktake"("businessId", "reference");

-- CreateIndex
CREATE INDEX "InventoryStocktakeLine_stocktakeId_idx" ON "InventoryStocktakeLine"("stocktakeId");

-- CreateIndex
CREATE INDEX "InventoryStocktakeLine_productId_idx" ON "InventoryStocktakeLine"("productId");

-- CreateIndex
CREATE INDEX "InventoryStocktakeLine_countedAt_idx" ON "InventoryStocktakeLine"("countedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryStocktakeLine_stocktakeId_productId_key" ON "InventoryStocktakeLine"("stocktakeId", "productId");

