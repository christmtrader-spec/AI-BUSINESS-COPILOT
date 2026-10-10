-- CreateTable
CREATE TABLE "AiCostRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "inputRateNanoMinorPerToken" BIGINT NOT NULL,
    "outputRateNanoMinorPerToken" BIGINT NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "environment" TEXT NOT NULL DEFAULT 'PRODUCTION',
    "verifiedAt" DATETIME NOT NULL,
    "verifiedBy" TEXT,
    "sourceReference" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiCostRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "usageEventId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "usagePeriodId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "planCodeAtUsage" TEXT NOT NULL,
    "rateId" TEXT,
    "rateVersion" TEXT,
    "currency" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "tokenStatus" TEXT NOT NULL DEFAULT 'NONE',
    "costNanoMinor" BIGINT,
    "costStatus" TEXT NOT NULL,
    "unknownReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiCostRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiCostRecord_usageEventId_fkey" FOREIGN KEY ("usageEventId") REFERENCES "UsageEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiCostRecord_rateId_fkey" FOREIGN KEY ("rateId") REFERENCES "AiCostRate" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE INDEX "AiCostRate_provider_model_environment_active_effectiveFrom_idx" ON "AiCostRate"("provider", "model", "environment", "active", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AiCostRate_environment_idx" ON "AiCostRate"("environment");

-- CreateIndex
CREATE UNIQUE INDEX "AiCostRate_provider_model_currency_version_environment_key" ON "AiCostRate"("provider", "model", "currency", "version", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "AiCostRecord_usageEventId_key" ON "AiCostRecord"("usageEventId");

-- CreateIndex
CREATE INDEX "AiCostRecord_businessId_createdAt_idx" ON "AiCostRecord"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostRecord_usagePeriodId_idx" ON "AiCostRecord"("usagePeriodId");

-- CreateIndex
CREATE INDEX "AiCostRecord_provider_model_idx" ON "AiCostRecord"("provider", "model");

-- CreateIndex
CREATE INDEX "AiCostRecord_costStatus_createdAt_idx" ON "AiCostRecord"("costStatus", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostRecord_planCodeAtUsage_createdAt_idx" ON "AiCostRecord"("planCodeAtUsage", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostRecord_rateId_idx" ON "AiCostRecord"("rateId");

-- CreateIndex
CREATE UNIQUE INDEX "AiCostRecord_businessId_requestId_key" ON "AiCostRecord"("businessId", "requestId");

