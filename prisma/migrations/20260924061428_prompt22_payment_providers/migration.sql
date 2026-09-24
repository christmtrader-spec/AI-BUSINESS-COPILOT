-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "billingPeriod" TEXT NOT NULL DEFAULT 'MONTHLY',
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "fulfilledAt" DATETIME,
    "metaJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CheckoutSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checkoutSessionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metaJson" TEXT,
    CONSTRAINT "PaymentTransaction_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessedWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CheckoutSession_businessId_createdAt_idx" ON "CheckoutSession"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_expiresAt_idx" ON "CheckoutSession"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_provider_providerRef_key" ON "CheckoutSession"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "PaymentTransaction_checkoutSessionId_idx" ON "PaymentTransaction"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_processedAt_idx" ON "PaymentTransaction"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_provider_providerEventId_key" ON "PaymentTransaction"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "ProcessedWebhookEvent_receivedAt_idx" ON "ProcessedWebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhookEvent_provider_eventId_key" ON "ProcessedWebhookEvent"("provider", "eventId");
