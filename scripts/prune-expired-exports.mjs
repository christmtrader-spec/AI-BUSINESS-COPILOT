#!/usr/bin/env bun
/**
 * scripts/prune-expired-exports.mjs — Prompt 31 §17/§179.
 *
 * Operational cleanup of EXPIRED export jobs and their artifacts:
 *   - jobs with status EXPIRED (already past TTL)
 *   - jobs with status COMPLETED whose expiresAt has passed
 *   - FAILED / CANCELED jobs whose staged artifact lingers
 *   - orphan files in the exports directory (job row no longer exists)
 *
 * SAFETY LAWS:
 *   - DRY RUN by default; --apply required for real deletion (§17).
 *   - Audit records are NEVER deleted here (§248 — file cleanup ≠ audit
 *     deletion; the tenant AuditLog rows survive).
 *   - Output shows counts + safe metadata only — never file contents.
 *   - The operational file TTL is NOT a legal retention policy (§132/§184).
 *
 * Run:  bun scripts/prune-expired-exports.mjs [--apply]
 * Exit: 0 = ok · 1 = failure.
 */
import { PrismaClient } from "@prisma/client";
import { existsSync, readdirSync, unlinkSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = new URL("..", import.meta.url).pathname + ".env";
  if (existsSync(envPath)) {
    for (const line of readFileSyncSafe(envPath)) {
      const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
function readFileSyncSafe(p) {
  try {
    // node:fs import hoisted below
    return readFileSyncLocal(p);
  } catch {
    return [];
  }
}
import { readFileSync } from "node:fs";
function readFileSyncLocal(p) {
  return readFileSync(p, "utf8").split("\n");
}

const apply = process.argv.includes("--apply");

function storageRoot() {
  const configured = (process.env.DATA_PORTABILITY_ROOT ?? "").trim();
  if (configured) return resolve(configured.startsWith("/") ? configured : join(process.cwd(), configured));
  return join(process.cwd(), "var", "data-portability");
}
function forbiddenRoot(root) {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.some((p) => ["public", ".next", "static", "node_modules"].includes(p));
}

loadEnv();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not configured — refusing to run.");
  process.exit(1);
}
const db = new PrismaClient();

const now = new Date();
let failures = 0;

const expiredCompleted = await db.dataExportJob.findMany({
  where: { status: "COMPLETED", expiresAt: { not: null, lte: now } },
  select: { id: true, storageKey: true },
});
const terminalWithFiles = await db.dataExportJob.findMany({
  where: { status: { in: ["FAILED", "CANCELED", "EXPIRED"] }, storageKey: { not: null } },
  select: { id: true, storageKey: true },
});

console.log(`prune-expired-exports ${apply ? "(APPLY)" : "(dry-run)"}`);
console.log(`  completed-but-expired jobs: ${expiredCompleted.length}`);
console.log(`  terminal jobs with lingering artifacts: ${terminalWithFiles.length}`);

if (apply) {
  for (const job of expiredCompleted) {
    try {
      await db.dataExportJob.update({
        where: { id: job.id },
        data: { status: "EXPIRED" },
      });
    } catch (e) {
      failures += 1;
      console.error(`  failed to expire ${job.id.slice(-8)}: ${e?.code ?? "error"}`);
    }
  }
  for (const job of terminalWithFiles) {
    if (!job.storageKey) continue;
    try {
      const target = join(storageRoot(), "exports", job.storageKey);
      const st = lstatSync(target);
      if (!st.isSymbolicLink()) unlinkSync(target); // §313 — never follow links
      await db.dataExportJob.update({ where: { id: job.id }, data: { storageKey: null } });
    } catch {
      /* file already gone */
    }
  }
}

// Orphan artifacts: files whose job row no longer exists (§273 — cascaded).
const root = storageRoot();
if (forbiddenRoot(root)) {
  console.error("  refusing to scan: storage root is inside a web-served directory");
  failures += 1;
} else {
  let orphans = 0;
  try {
    const dir = join(root, "exports");
    const files = readdirSync(dir).filter((f) => !f.startsWith("."));
    for (const file of files) {
      const jobId = file.split(".")[0];
      const exists = await db.dataExportJob.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!exists) {
        orphans += 1;
        if (apply) {
          try {
            const target = join(dir, file);
            const st = lstatSync(target);
            if (!st.isSymbolicLink()) unlinkSync(target);
          } catch {
            /* gone */
          }
        }
      }
    }
    console.log(`  orphan export artifacts: ${orphans}`);
  } catch {
    console.log("  export artifact directory not readable (or absent) — skipped");
  }
}

console.log(failures === 0 ? "done" : `done with ${failures} failure(s)`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
