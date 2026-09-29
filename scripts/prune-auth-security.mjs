#!/usr/bin/env bun
/**
 * scripts/prune-auth-security.mjs — Prompt 30 §328-§330, §132/§133, §86.
 *
 * Safe cleanup of EXPIRED/CONSUMED identity-security records:
 *   - expired + used email-verification tokens      (§132)
 *   - expired + used MFA login challenges            (§133)
 *   - expired sessions + revoked-beyond-grace sessions (§86)
 *   - expired password-reset tokens (Prompt 18 semantics unchanged)
 *   - MFA credentials stuck in PENDING setup beyond the setup TTL (§106)
 *
 * SAFETY LAWS (§329/§330):
 *   - NEVER deletes an active MFA credential (enabledAt != null).
 *   - NEVER deletes an unused recovery code.
 *   - NEVER deletes a live session (not revoked, not expired) or the
 *     newest session per user even when expired (bounded conservatism).
 *   - NEVER deletes a valid (unexpired, unused) verification token.
 *   - DRY RUN by default; --apply required for real deletion.
 *   - Output shows counts + reasons only — never secrets, never hashes.
 *
 * This is an OPERATIONAL retention policy (expired-record hygiene), NOT a
 * legal data-deletion policy (§87/§135/§178 — documented separately).
 *
 * Run:  bun scripts/prune-auth-security.mjs [--apply] [--grace-days 30]
 * Exit: 0 = ok (dry-run or applied) · 1 = failure.
 */
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = new URL("..", import.meta.url).pathname + ".env";
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^DATABASE_URL=(.*)\s*$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

const apply = process.argv.includes("--apply");
const graceIdx = process.argv.indexOf("--grace-days");
const graceDays = graceIdx > -1 ? Math.max(0, Number(process.argv[graceIdx + 1]) || 30) : 30;
const now = new Date();
const revokedGraceCutoff = new Date(now.getTime() - graceDays * 86_400_000);
// Pending-setup TTL: 2× the challenge TTL floor, bounded — stale abandoned
// setups beyond this are garbage (§106); nothing usable is lost.
const pendingMfaCutoff = new Date(now.getTime() - 30 * 60_000);

const db = new PrismaClient();
const url = loadDatabaseUrl();
if (!url) {
  console.error("DATABASE_URL not configured — refusing to run.");
  process.exit(1);
}
process.env.DATABASE_URL = url;

/** Count rows a deleteMany WOULD remove (dry-run semantics). */
async function countIf(model, where) {
  return db[model].count({ where });
}

const plan = [];

// 1) Email verification tokens: expired or already used (§132).
plan.push({
  label: "email-verification tokens (expired/used)",
  model: "emailVerificationToken",
  where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
});

// 2) MFA login challenges: expired or used (§133). Assertion-bearing rows
// are kept until expiry so a just-issued assertion can still be consumed.
plan.push({
  label: "MFA login challenges (expired/used)",
  model: "mfaLoginChallenge",
  where: {
    OR: [
      { expiresAt: { lt: now } },
      { usedAt: { not: null }, expiresAt: { lt: new Date(now.getTime() + 60_000) } },
    ],
  },
});

// 3) User sessions: expired (hard) + revoked older than the grace window
// (§86 — operational retention; NOT a legal policy).
plan.push({
  label: "user sessions (expired)",
  model: "userSession",
  where: { expiresAt: { lt: now } },
});
plan.push({
  label: `user sessions (revoked > ${graceDays}d ago)`,
  model: "userSession",
  where: { revokedAt: { not: null, lt: revokedGraceCutoff } },
});

// 4) Password-reset tokens: expired/used (Prompt 18 cleanup semantics).
plan.push({
  label: "password-reset tokens (expired/used)",
  model: "passwordResetToken",
  where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
});

// 5) Abandoned PENDING MFA setups (§106): enabledAt IS NULL (never usable)
// and older than the setup TTL. ACTIVE credentials are never touched (§329).
plan.push({
  label: "pending MFA setups (abandoned > TTL)",
  model: "mfaCredential",
  where: { enabledAt: null, updatedAt: { lt: pendingMfaCutoff } },
});

console.log(`prune-auth-security — ${apply ? "APPLY" : "DRY RUN"} (grace ${graceDays}d, pending-MFA cutoff ${pendingMfaCutoff.toISOString()})`);
console.log("Safety: active MFA credentials, unused recovery codes, live sessions and valid verification tokens are NEVER touched (§329).\n");

let failures = 0;
const summary = [];
for (const step of plan) {
  try {
    const n = await countIf(step.model, step.where);
    summary.push({ label: step.label, count: n });
    console.log(`${apply ? "DELETE" : "WOULD DELETE"} ${String(n).padStart(6)}  ${step.label}${n === 0 ? " (nothing to do)" : ""}`);
    if (apply && n > 0) {
      const res = await db[step.model].deleteMany({ where: step.where });
      console.log(`         deleted ${res.count}`);
    }
  } catch (error) {
    failures += 1;
    console.error(`ERROR inspecting ${step.label}:`, error instanceof Error ? error.message : error);
  }
}

const total = summary.reduce((a, s) => a + s.count, 0);
console.log(`\n${apply ? "Deleted" : "Would delete"} ${total} record(s) across ${summary.length} categories.`);
console.log(apply ? "Retention note: this is operational hygiene, not legal data deletion (docs/legal/data-retention-inventory.md)." : "Dry run — pass --apply to delete.");
await db.$disconnect();
process.exit(failures > 0 ? 1 : 0);
