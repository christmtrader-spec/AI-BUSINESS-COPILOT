-- R68 — platform setup key (cold-start fix for the first operator).
-- Minted ONLY by the offline CLI; redeemed by an authenticated session at
-- the console setup gate. Display-once, hashed-at-rest, single-use, expiring
-- (§9/§60/§61 laws preserved — no public bootstrap, no default credentials).
-- CreateTable
CREATE TABLE "PlatformSetupKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyHash" TEXT NOT NULL,
    "boundEmail" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "usedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformSetupKey_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSetupKey_keyHash_key" ON "PlatformSetupKey"("keyHash");
CREATE INDEX "PlatformSetupKey_expiresAt_idx" ON "PlatformSetupKey"("expiresAt");
