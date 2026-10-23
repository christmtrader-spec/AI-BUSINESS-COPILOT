-- R69 (Prompt 69 §3.4 F1) — invitation tokens are no longer stored raw.
--
-- Before: PlatformOperatorInvite.token held the raw 48-char bearer token, so
-- a database read (backup, support dump, SQL injection elsewhere) could
-- redeem a PENDING invite. After: only a SHA-256 digest is persisted and the
-- unique lookup happens over the digest (same law as the R68 setup key).
--
-- ENGINE CONSTRAINT (documented): Prisma's bundled SQLite exposes NO sha256()
-- SQL function, so legacy rows cannot be hashed inside this migration.
-- Instead the raw token is COPIED into tokenHash as a LEGACY value (48-char
-- base64url vs 64-char hex digest — always distinguishable). The one-time
-- idempotent ops script `scripts/r69-invite-rehash.mjs` (run automatically
-- during R69; also shipped for other deployments) re-hashes every 48-char
-- legacy row in JS, which restores full hash-only storage AND keeps invite
-- links already handed out-of-band working. No invite data is lost.
--
-- SQLite caveat: ALTER TABLE cannot add a UNIQUE column with backfill, so
-- the recreate-table pattern is used.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE `new_PlatformOperatorInvite` (
    `id` TEXT NOT NULL PRIMARY KEY,
    `tokenHash` TEXT NOT NULL,
    `email` TEXT NOT NULL,
    `name` TEXT NOT NULL,
    `role` TEXT NOT NULL,
    `createdById` TEXT,
    `acceptedUserId` TEXT,
    `expiresAt` DATETIME NOT NULL,
    `acceptedAt` DATETIME,
    `revokedAt` DATETIME,
    `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT `PlatformOperatorInvite_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `PlatformOperatorInvite_acceptedUserId_fkey` FOREIGN KEY (`acceptedUserId`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Legacy copy: raw token lands in tokenHash as a 48-char LEGACY value.
-- `scripts/r69-invite-rehash.mjs` converts these to real digests post-deploy.
INSERT INTO `new_PlatformOperatorInvite`
    (`id`, `tokenHash`, `email`, `name`, `role`, `createdById`, `acceptedUserId`, `expiresAt`, `acceptedAt`, `revokedAt`, `createdAt`)
SELECT
    `id`, `token`, `email`, `name`, `role`, `createdById`, `acceptedUserId`,
    `expiresAt`, `acceptedAt`, `revokedAt`, `createdAt`
FROM `PlatformOperatorInvite`;

DROP TABLE `PlatformOperatorInvite`;
ALTER TABLE `new_PlatformOperatorInvite` RENAME TO `PlatformOperatorInvite`;

CREATE UNIQUE INDEX `PlatformOperatorInvite_tokenHash_key` ON `PlatformOperatorInvite`(`tokenHash`);
CREATE INDEX `PlatformOperatorInvite_email_idx` ON `PlatformOperatorInvite`(`email`);
CREATE INDEX `PlatformOperatorInvite_createdAt_idx` ON `PlatformOperatorInvite`(`createdAt`);

COMMIT;

PRAGMA foreign_keys=ON;
