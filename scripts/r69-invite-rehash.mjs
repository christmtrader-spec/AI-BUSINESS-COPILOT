/**
 * R69 one-time ops script (Prompt 69 §3.4 F1) — re-hash legacy invite rows.
 *
 * The R69 migration (20261023140000_r69_invite_token_hash) could NOT hash
 * legacy tokens in SQL (Prisma's bundled SQLite exposes no sha256()), so it
 * copies each raw token into tokenHash as a 48-char base64url LEGACY value.
 * This script converts every such row to the real digest the application
 * looks up (SHA-256 of "platform-invite-v1:<token>"), restoring hash-only
 * storage while keeping invitation links already handed out-of-band valid.
 *
 * IDEMPOTENT: only rows whose tokenHash is NOT already a 64-char hex digest
 * are touched. Safe to run repeatedly and after every fresh deployment that
 * inherits pre-R69 rows. Zero rows → no-op.
 *
 * Run: bun --conditions react-server scripts/r69-invite-rehash.mjs
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function hashInviteToken(rawToken) {
  return createHash("sha256").update(`platform-invite-v1:${rawToken.trim()}`).digest("hex");
}

const rows = await db.platformOperatorInvite.findMany({ select: { id: true, tokenHash: true } });
let rehashed = 0;
for (const row of rows) {
  if (isDigest(row.tokenHash)) continue;
  await db.platformOperatorInvite.update({
    where: { id: row.id },
    data: { tokenHash: hashInviteToken(row.tokenHash) },
  });
  rehashed += 1;
}
console.log(`[r69-invite-rehash] rows=${rows.length} rehashed=${rehashed} remainingLegacy=${rows.length - rehashed}`);
await db.$disconnect();
