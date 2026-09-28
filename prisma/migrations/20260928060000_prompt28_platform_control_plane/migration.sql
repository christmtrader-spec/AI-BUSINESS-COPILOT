-- Prompt 28 — PLATFORM CONTROL PLANE (additive only).
-- PlatformOperator + PlatformAuditLog. No existing table is altered beyond
-- the two new foreign keys; SQLite-compatible; no data backfill required.

-- CreateTable
CREATE TABLE "PlatformOperator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlatformOperator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operatorId" TEXT,
    "operatorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "targetUserId" TEXT,
    "targetBusinessId" TEXT,
    "reason" TEXT,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAuditLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperator_userId_key" ON "PlatformOperator"("userId");

-- CreateIndex
CREATE INDEX "PlatformOperator_role_active_idx" ON "PlatformOperator"("role", "active");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_action_createdAt_idx" ON "PlatformAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_entityType_entityId_idx" ON "PlatformAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_operatorId_createdAt_idx" ON "PlatformAuditLog"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_targetUserId_idx" ON "PlatformAuditLog"("targetUserId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_targetBusinessId_idx" ON "PlatformAuditLog"("targetBusinessId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_requestId_idx" ON "PlatformAuditLog"("requestId");
