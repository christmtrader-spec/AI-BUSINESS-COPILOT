-- CreateTable
CREATE TABLE "UsagePeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "start" DATETIME NOT NULL,
    "end" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsagePeriod_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "usagePeriodId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UsageCounter_usagePeriodId_fkey" FOREIGN KEY ("usagePeriodId") REFERENCES "UsagePeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "usagePeriodId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMMITTED',
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "metaJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UsageEvent_usagePeriodId_fkey" FOREIGN KEY ("usagePeriodId") REFERENCES "UsagePeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "UsagePeriod_businessId_start_idx" ON "UsagePeriod"("businessId", "start");

-- CreateIndex
CREATE INDEX "UsagePeriod_subscriptionId_idx" ON "UsagePeriod"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "UsagePeriod_businessId_start_key" ON "UsagePeriod"("businessId", "start");

-- CreateIndex
CREATE INDEX "UsageCounter_metric_idx" ON "UsageCounter"("metric");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_usagePeriodId_metric_key" ON "UsageCounter"("usagePeriodId", "metric");

-- CreateIndex
CREATE INDEX "UsageEvent_businessId_createdAt_idx" ON "UsageEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_usagePeriodId_metric_idx" ON "UsageEvent"("usagePeriodId", "metric");

-- CreateIndex
CREATE INDEX "UsageEvent_requestId_idx" ON "UsageEvent"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_businessId_metric_idempotencyKey_key" ON "UsageEvent"("businessId", "metric", "idempotencyKey");
