-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "subtotalMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "taxRateBp" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL,
    "paidMinor" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "issueDate" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATETIME,
    "note" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "salesOrderId" TEXT,
    CONSTRAINT "Sale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Sale_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Sale" ("businessId", "createdAt", "customerId", "deletedAt", "discountMinor", "dueDate", "id", "issueDate", "note", "number", "paidMinor", "salesOrderId", "status", "subtotalMinor", "taxMinor", "taxRateBp", "totalMinor", "updatedAt") SELECT "businessId", "createdAt", "customerId", "deletedAt", "discountMinor", "dueDate", "id", "issueDate", "note", "number", "paidMinor", "salesOrderId", "status", "subtotalMinor", "taxMinor", "taxRateBp", "totalMinor", "updatedAt" FROM "Sale";
DROP TABLE "Sale";
ALTER TABLE "new_Sale" RENAME TO "Sale";
CREATE UNIQUE INDEX "Sale_salesOrderId_key" ON "Sale"("salesOrderId");
CREATE INDEX "Sale_businessId_deletedAt_createdAt_idx" ON "Sale"("businessId", "deletedAt", "createdAt");
CREATE INDEX "Sale_businessId_status_idx" ON "Sale"("businessId", "status");
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");
CREATE UNIQUE INDEX "Sale_businessId_number_key" ON "Sale"("businessId", "number");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
