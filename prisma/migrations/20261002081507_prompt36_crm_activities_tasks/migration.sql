-- Prompt 36 — CRM Activities + Tasks (§96/§97).
-- Purely ADDITIVE: 2 CREATE TABLE + 16 CREATE INDEX. No DROP, no column
-- type change, no data backfill, no touch of financial tables (§97).
-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "durationMinutes" INTEGER,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "customerId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmActivity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmActivity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "CrmOpportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmActivity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmActivity_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CrmTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "dueAt" DATETIME,
    "completedAt" DATETIME,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "customerId" TEXT,
    "assignedToUserId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmTask_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmTask_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmTask_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "CrmOpportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmTask_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmTask_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CrmActivity_businessId_deletedAt_idx" ON "CrmActivity"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "CrmActivity_businessId_occurredAt_idx" ON "CrmActivity"("businessId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_businessId_type_idx" ON "CrmActivity"("businessId", "type");

-- CreateIndex
CREATE INDEX "CrmActivity_businessId_createdByUserId_idx" ON "CrmActivity"("businessId", "createdByUserId");

-- CreateIndex
CREATE INDEX "CrmActivity_customerId_occurredAt_idx" ON "CrmActivity"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_leadId_occurredAt_idx" ON "CrmActivity"("leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_opportunityId_occurredAt_idx" ON "CrmActivity"("opportunityId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmTask_businessId_deletedAt_idx" ON "CrmTask"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "CrmTask_businessId_status_idx" ON "CrmTask"("businessId", "status");

-- CreateIndex
CREATE INDEX "CrmTask_businessId_priority_idx" ON "CrmTask"("businessId", "priority");

-- CreateIndex
CREATE INDEX "CrmTask_businessId_dueAt_idx" ON "CrmTask"("businessId", "dueAt");

-- CreateIndex
CREATE INDEX "CrmTask_businessId_assignedToUserId_idx" ON "CrmTask"("businessId", "assignedToUserId");

-- CreateIndex
CREATE INDEX "CrmTask_customerId_dueAt_idx" ON "CrmTask"("customerId", "dueAt");

-- CreateIndex
CREATE INDEX "CrmTask_leadId_dueAt_idx" ON "CrmTask"("leadId", "dueAt");

-- CreateIndex
CREATE INDEX "CrmTask_opportunityId_dueAt_idx" ON "CrmTask"("opportunityId", "dueAt");

