-- Prompt 26 — AI cost governance (provider cost ledger + unit economics).
-- Additive only: three new tables + indexes. No historical table is altered.

-- CreateTable
CREATE TABLE "AiCostRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "inputRateNanoMinorPer1K" BIGINT NOT NULL,
    "outputRateNanoMinorPer1K" BIGINT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "environment" TEXT NOT NULL,
    "verifiedAt" DATETIME,
    "verifiedBy" TEXT,
    "sourceReference" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiCostRecord" (
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
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiCostAnomaly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "businessId" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "metric" TEXT NOT NULL,
    "baseline" TEXT,
    "currentValue" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCostRate_provider_model_currency_version_environment_key" ON "AiCostRate"("provider", "model", "currency", "version", "environment");

-- CreateIndex
CREATE INDEX "AiCostRate_provider_model_environment_active_effectiveFrom_effectiveTo_idx" ON "AiCostRate"("provider", "model", "environment", "active", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "AiCostRate_currency_environment_active_idx" ON "AiCostRate"("currency", "environment", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AiCostRecord_usageEventId_key" ON "AiCostRecord"("usageEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AiCostRecord_businessId_requestId_key" ON "AiCostRecord"("businessId", "requestId");

-- CreateIndex
CREATE INDEX "AiCostRecord_businessId_createdAt_idx" ON "AiCostRecord"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostRecord_provider_model_createdAt_idx" ON "AiCostRecord"("provider", "model", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostRecord_costStatus_createdAt_idx" ON "AiCostRecord"("costStatus", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostRecord_rateId_idx" ON "AiCostRecord"("rateId");

-- CreateIndex
CREATE INDEX "AiCostRecord_usagePeriodId_idx" ON "AiCostRecord"("usagePeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "AiCostAnomaly_type_dedupeKey_key" ON "AiCostAnomaly"("type", "dedupeKey");

-- CreateIndex
CREATE INDEX "AiCostAnomaly_status_createdAt_idx" ON "AiCostAnomaly"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostAnomaly_businessId_createdAt_idx" ON "AiCostAnomaly"("businessId", "createdAt");
