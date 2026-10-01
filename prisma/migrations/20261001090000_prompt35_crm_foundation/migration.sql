-- CreateTable
CREATE TABLE "CrmLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "source" TEXT NOT NULL,
    "sourceDetail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "note" TEXT,
    "assignedToUserId" TEXT,
    "customerId" TEXT,
    "convertedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmLead_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmLead_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmLead_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CrmOpportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "leadId" TEXT,
    "customerId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'DISCOVERY',
    "probabilityPct" INTEGER NOT NULL DEFAULT 10,
    "expectedValueMinor" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "expectedCloseDate" DATETIME,
    "assignedToUserId" TEXT,
    "lostReason" TEXT,
    "wonAt" DATETIME,
    "lostAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmOpportunity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmOpportunity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "CrmLead" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmOpportunity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmOpportunity_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CrmLead_businessId_deletedAt_idx" ON "CrmLead"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "CrmLead_businessId_status_idx" ON "CrmLead"("businessId", "status");

-- CreateIndex
CREATE INDEX "CrmLead_businessId_createdAt_idx" ON "CrmLead"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmLead_businessId_assignedToUserId_idx" ON "CrmLead"("businessId", "assignedToUserId");

-- CreateIndex
CREATE INDEX "CrmLead_customerId_idx" ON "CrmLead"("customerId");

-- CreateIndex
CREATE INDEX "CrmOpportunity_businessId_deletedAt_idx" ON "CrmOpportunity"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "CrmOpportunity_businessId_stage_idx" ON "CrmOpportunity"("businessId", "stage");

-- CreateIndex
CREATE INDEX "CrmOpportunity_businessId_expectedCloseDate_idx" ON "CrmOpportunity"("businessId", "expectedCloseDate");

-- CreateIndex
CREATE INDEX "CrmOpportunity_businessId_assignedToUserId_idx" ON "CrmOpportunity"("businessId", "assignedToUserId");

-- CreateIndex
CREATE INDEX "CrmOpportunity_customerId_idx" ON "CrmOpportunity"("customerId");

-- CreateIndex
CREATE INDEX "CrmOpportunity_leadId_idx" ON "CrmOpportunity"("leadId");

