-- Prompt 25 — commercial conversion events (funnel analytics, internal).
-- Additive only: one new table + indexes. No historical table is altered.

-- CreateTable
CREATE TABLE "CommercialEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "anonymousSessionKey" TEXT,
    "userId" TEXT,
    "businessId" TEXT,
    "planCode" TEXT,
    "billingPeriod" TEXT,
    "currency" TEXT,
    "source" TEXT,
    "route" TEXT,
    "dedupeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "CommercialEvent_eventType_dedupeKey_key" ON "CommercialEvent"("eventType", "dedupeKey");

-- CreateIndex
CREATE INDEX "CommercialEvent_eventType_createdAt_idx" ON "CommercialEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "CommercialEvent_businessId_createdAt_idx" ON "CommercialEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "CommercialEvent_userId_createdAt_idx" ON "CommercialEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CommercialEvent_anonymousSessionKey_createdAt_idx" ON "CommercialEvent"("anonymousSessionKey", "createdAt");
