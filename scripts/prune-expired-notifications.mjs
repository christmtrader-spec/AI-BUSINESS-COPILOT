#!/usr/bin/env bun
/**
 * scripts/prune-expired-notifications.mjs — Prompt 32 §58/§64/§179/§303.
 *
 * Operational notification cleanup. DRY-RUN by default; pass --apply to
 * actually delete. Never deletes audit records — it only removes eligible
 * Notification rows (deliveries cascade; security notifications follow the
 * longer NOTIFICATION_SECURITY_RETENTION_DAYS, §127).
 *
 * UTC everywhere (§426/§427); bounded batches (§425).
 *
 * Run:  bun scripts/prune-expired-notifications.mjs [--apply]
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const apply = process.argv.includes("--apply");
const db = new PrismaClient();

for (const line of readDbEnv()) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
function readDbEnv() {
  try {
    return readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n");
  } catch {
    return [];
  }
}

function intFromEnv(name, fallback, min, max) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

const RETENTION_DAYS = intFromEnv("NOTIFICATION_RETENTION_DAYS", 90, 7, 3650);
const SECURITY_RETENTION_DAYS = intFromEnv("NOTIFICATION_SECURITY_RETENTION_DAYS", 365, 30, 3650);
const BATCH = intFromEnv("NOTIFICATION_CLEANUP_BATCH_SIZE", 500, 50, 5000);

const now = new Date();
const operationalCutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
const securityCutoff = new Date(now.getTime() - SECURITY_RETENTION_DAYS * 86_400_000);

const eligibleWhere = {
  OR: [
    {
      category: { not: "SECURITY" },
      createdAt: { lt: operationalCutoff },
      OR: [{ readAt: { not: null } }, { archivedAt: { not: null } }, { expiresAt: { lt: now } }],
    },
    {
      category: "SECURITY",
      createdAt: { lt: securityCutoff },
      OR: [{ readAt: { not: null } }, { archivedAt: { not: null } }],
    },
  ],
};

const [eligibleNonSecurity, eligibleSecurity] = await Promise.all([
  db.notification.count({ where: { AND: [eligibleWhere, { category: { not: "SECURITY" } }] } }),
  db.notification.count({ where: { AND: [eligibleWhere, { category: "SECURITY" }] } }),
]);

console.log(
  `[notifications-prune] mode=${apply ? "apply" : "dry-run"} ` +
    `retention=${RETENTION_DAYS}d securityRetention=${SECURITY_RETENTION_DAYS}d`,
);
console.log(
  `[notifications-prune] eligible: nonSecurity=${eligibleNonSecurity} security=${eligibleSecurity}`,
);

let deleted = 0;
if (apply) {
  for (let round = 0; round < 200; round += 1) {
    const batch = await db.notification.findMany({
      where: eligibleWhere,
      select: { id: true },
      take: BATCH,
      orderBy: { createdAt: "asc" },
    });
    if (batch.length === 0) break;
    const result = await db.notification.deleteMany({
      where: { id: { in: batch.map((r) => r.id) } },
    });
    deleted += result.count;
    if (batch.length < BATCH) break;
  }
  console.log(`[notifications-prune] deleted=${deleted} (deliveries cascade with their notification)`);
} else {
  console.log("[notifications-prune] dry-run — no rows deleted. Re-run with --apply to prune.");
}

await db.$disconnect();
