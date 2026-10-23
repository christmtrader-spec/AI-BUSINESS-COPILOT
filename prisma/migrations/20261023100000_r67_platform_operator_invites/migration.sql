-- R67 — platform operator invitation ("admin registration").
-- An authorized super admin mints a single-use, expiring opaque token for a
-- named email + role; the invitee redeems it by setting their own password.
-- No public bootstrap, no default credentials (§9/§61 laws preserved).
-- CreateTable
CREATE TABLE "PlatformOperatorInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdById" TEXT,
    "acceptedUserId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformOperatorInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PlatformOperatorInvite_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperatorInvite_token_key" ON "PlatformOperatorInvite"("token");
CREATE INDEX "PlatformOperatorInvite_email_idx" ON "PlatformOperatorInvite"("email");
CREATE INDEX "PlatformOperatorInvite_createdAt_idx" ON "PlatformOperatorInvite"("createdAt");
