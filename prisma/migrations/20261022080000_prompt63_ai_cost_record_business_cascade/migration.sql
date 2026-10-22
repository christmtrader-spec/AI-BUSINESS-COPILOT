-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiCostRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "usageEventId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "usagePeriodId" TEXT,
    "planCodeAtUsage" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "currency" TEXT,
    "rateId" TEXT,
    "rateVersion" TEXT,
    "environment" TEXT,
    "inputRateNanoMinorPer1K" BIGINT,
    "outputRateNanoMinorPer1K" BIGINT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "tokenStatus" TEXT NOT NULL,
    "costStatus" TEXT NOT NULL,
    "costNanoMinor" BIGINT,
    "unknownReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiCostRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiCostRecord" ("businessId", "costNanoMinor", "costStatus", "createdAt", "currency", "environment", "id", "inputRateNanoMinorPer1K", "inputTokens", "model", "outputRateNanoMinorPer1K", "outputTokens", "planCodeAtUsage", "provider", "rateId", "rateVersion", "requestId", "tokenStatus", "totalTokens", "unknownReason", "updatedAt", "usageEventId", "usagePeriodId") SELECT "businessId", "costNanoMinor", "costStatus", "createdAt", "currency", "environment", "id", "inputRateNanoMinorPer1K", "inputTokens", "model", "outputRateNanoMinorPer1K", "outputTokens", "planCodeAtUsage", "provider", "rateId", "rateVersion", "requestId", "tokenStatus", "totalTokens", "unknownReason", "updatedAt", "usageEventId", "usagePeriodId" FROM "AiCostRecord";
DROP TABLE "AiCostRecord";
ALTER TABLE "new_AiCostRecord" RENAME TO "AiCostRecord";
CREATE UNIQUE INDEX "AiCostRecord_usageEventId_key" ON "AiCostRecord"("usageEventId");
CREATE INDEX "AiCostRecord_businessId_createdAt_idx" ON "AiCostRecord"("businessId", "createdAt");
CREATE INDEX "AiCostRecord_provider_model_createdAt_idx" ON "AiCostRecord"("provider", "model", "createdAt");
CREATE INDEX "AiCostRecord_costStatus_createdAt_idx" ON "AiCostRecord"("costStatus", "createdAt");
CREATE INDEX "AiCostRecord_rateId_idx" ON "AiCostRecord"("rateId");
CREATE INDEX "AiCostRecord_usagePeriodId_idx" ON "AiCostRecord"("usagePeriodId");
CREATE UNIQUE INDEX "AiCostRecord_businessId_requestId_key" ON "AiCostRecord"("businessId", "requestId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

