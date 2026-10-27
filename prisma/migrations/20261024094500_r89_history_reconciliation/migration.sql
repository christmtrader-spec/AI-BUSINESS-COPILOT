-- R89 — MIGRATION HISTORY RECONCILIATION (closes the R81-documented
-- shadow-db replay breakage). Generated with:
--   prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script
-- after permanently removing the DUPLICATED 20260924140000_prompt26
-- migration (a conflicting second draft of 20260924130000 that re-created
-- AiCostRate/AiCostRecord — replay died there, so `migrate dev`'s shadow db
-- could never build and a fresh `migrate deploy` bootstrap would crash).
--
-- This single migration captures every later drift between the migration
-- history and schema.prisma (the dev path had been db push for several
-- features): SupportTicket/SupportTicketMessage/ApiKey/WebhookEndpoint/
-- WebhookDelivery tables, User suspension columns, Business/Sale column
-- normalization, and the missing indexes. Applied to this dev db via
-- `migrate resolve --applied` (the db already matches schema.prisma via
-- db push — the SQL executes only on FRESH bootstraps, where replaying
-- history + this file now lands EXACTLY on schema.prisma).
--
-- Proof battery (R89): statement replay clean (35/35), history-vs-schema
-- diff EMPTY, live-db-vs-schema diff EMPTY, migrate status up to date,
-- migrate dev in sync with NO reset offer.

-- DropIndex
DROP INDEX "AnalyticsEvent_businessId_idx";

-- DropIndex
DROP INDEX "AnalyticsEvent_name_createdAt_idx";

-- DropIndex
DROP INDEX "AnalyticsEvent_dedupeKey_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN "suspendedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "suspendedByOperatorId" TEXT;
ALTER TABLE "User" ADD COLUMN "suspensionReason" TEXT;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AnalyticsEvent";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ContactLead";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" INTEGER NOT NULL,
    "requesterId" TEXT,
    "requesterEmailAtCreation" TEXT NOT NULL,
    "requesterNameAtCreation" TEXT,
    "businessId" TEXT,
    "businessNameAtCreation" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigneeOperatorId" TEXT,
    "firstResponseAt" DATETIME,
    "resolvedAt" DATETIME,
    "closedAt" DATETIME,
    "resolutionSummary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupportTicket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_assigneeOperatorId_fkey" FOREIGN KEY ("assigneeOperatorId") REFERENCES "PlatformOperator" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupportTicketMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorKind" TEXT NOT NULL,
    "authorNameAtPost" TEXT,
    "visibility" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupportTicketMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'read',
    "lastUsedAt" DATETIME,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TEXT,
    "periodCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT,
    "url" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretBox" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastStatus" INTEGER,
    "lastDeliveryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEndpoint_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WebhookEndpoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Business" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "currencySymbol" TEXT NOT NULL DEFAULT '$',
    "decimalPrecision" INTEGER NOT NULL DEFAULT 2,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "vatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Business_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Business" ("createdAt", "currencyCode", "currencySymbol", "decimalPrecision", "id", "locale", "name", "ownerId", "slug", "timezone", "updatedAt") SELECT "createdAt", "currencyCode", "currencySymbol", "decimalPrecision", "id", "locale", "name", "ownerId", "slug", "timezone", "updatedAt" FROM "Business";
DROP TABLE "Business";
ALTER TABLE "new_Business" RENAME TO "Business";
CREATE UNIQUE INDEX "Business_slug_key" ON "Business"("slug");
CREATE INDEX "Business_ownerId_idx" ON "Business"("ownerId");
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
    "issueDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
INSERT INTO "new_Sale" ("businessId", "createdAt", "customerId", "deletedAt", "discountMinor", "dueDate", "id", "issueDate", "note", "number", "paidMinor", "salesOrderId", "status", "subtotalMinor", "totalMinor", "updatedAt") SELECT "businessId", "createdAt", "customerId", "deletedAt", "discountMinor", "dueDate", "id", "issueDate", "note", "number", "paidMinor", "salesOrderId", "status", "subtotalMinor", "totalMinor", "updatedAt" FROM "Sale";
DROP TABLE "Sale";
ALTER TABLE "new_Sale" RENAME TO "Sale";
CREATE UNIQUE INDEX "Sale_salesOrderId_key" ON "Sale"("salesOrderId");
CREATE INDEX "Sale_businessId_deletedAt_createdAt_idx" ON "Sale"("businessId", "deletedAt", "createdAt");
CREATE INDEX "Sale_businessId_status_idx" ON "Sale"("businessId", "status");
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");
CREATE UNIQUE INDEX "Sale_businessId_number_key" ON "Sale"("businessId", "number");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_number_key" ON "SupportTicket"("number");

-- CreateIndex
CREATE INDEX "SupportTicket_status_createdAt_idx" ON "SupportTicket"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_requesterId_createdAt_idx" ON "SupportTicket"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_businessId_idx" ON "SupportTicket"("businessId");

-- CreateIndex
CREATE INDEX "SupportTicket_assigneeOperatorId_status_idx" ON "SupportTicket"("assigneeOperatorId", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_priority_status_idx" ON "SupportTicket"("priority", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_category_status_idx" ON "SupportTicket"("category", "status");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_idx" ON "SupportTicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_authorUserId_idx" ON "SupportTicketMessage"("authorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_businessId_createdAt_idx" ON "ApiKey"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_businessId_createdAt_idx" ON "WebhookEndpoint"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_businessId_createdAt_idx" ON "WebhookDelivery"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");

