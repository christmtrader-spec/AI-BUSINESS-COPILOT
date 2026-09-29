-- CreateTable
CREATE TABLE "DataExportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "format" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "requestedDatasets" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "recordCount" INTEGER,
    "fileSize" INTEGER,
    "checksum" TEXT,
    "storageKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "expiresAt" DATETIME,
    "failureCode" TEXT,
    "failureMessageSafe" TEXT,
    CONSTRAINT "DataExportJob_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "datasetType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileChecksum" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "mappingJson" TEXT,
    "duplicateMode" TEXT NOT NULL DEFAULT 'SKIP',
    "commitToken" TEXT,
    "rowCount" INTEGER,
    "validRows" INTEGER,
    "invalidRows" INTEGER,
    "duplicateRows" INTEGER,
    "wouldCreate" INTEGER,
    "wouldUpdate" INTEGER,
    "wouldSkip" INTEGER,
    "createdCount" INTEGER,
    "updatedCount" INTEGER,
    "skippedCount" INTEGER,
    "failedCount" INTEGER,
    "errorReport" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "expiresAt" DATETIME,
    "failureCode" TEXT,
    "failureMessageSafe" TEXT,
    CONSTRAINT "DataImportJob_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DataExportJob_businessId_createdAt_idx" ON "DataExportJob"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "DataExportJob_businessId_status_idx" ON "DataExportJob"("businessId", "status");

-- CreateIndex
CREATE INDEX "DataExportJob_status_createdAt_idx" ON "DataExportJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DataExportJob_expiresAt_idx" ON "DataExportJob"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DataExportJob_businessId_idempotencyKey_key" ON "DataExportJob"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DataImportJob_businessId_createdAt_idx" ON "DataImportJob"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "DataImportJob_businessId_status_idx" ON "DataImportJob"("businessId", "status");

-- CreateIndex
CREATE INDEX "DataImportJob_status_createdAt_idx" ON "DataImportJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DataImportJob_expiresAt_idx" ON "DataImportJob"("expiresAt");
