-- Prompt 65 §10 — two-person approval for high-risk platform mutations.
-- CreateTable
CREATE TABLE "PlatformApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requesterId" TEXT NOT NULL,
    "approverId" TEXT,
    "approvalNote" TEXT,
    "rejectionReason" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "executedAt" DATETIME,
    "executeError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlatformApprovalRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "PlatformOperator" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlatformApprovalRequest_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "PlatformOperator" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PlatformApprovalRequest_status_expiresAt_idx" ON "PlatformApprovalRequest"("status", "expiresAt");
CREATE INDEX "PlatformApprovalRequest_kind_status_createdAt_idx" ON "PlatformApprovalRequest"("kind", "status", "createdAt");
CREATE INDEX "PlatformApprovalRequest_requesterId_createdAt_idx" ON "PlatformApprovalRequest"("requesterId", "createdAt");
CREATE INDEX "PlatformApprovalRequest_approverId_idx" ON "PlatformApprovalRequest"("approverId");
