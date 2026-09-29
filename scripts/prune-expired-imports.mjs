#!/usr/bin/env bun
/**
 * scripts/prune-expired-imports.mjs — Prompt 31 §64/§179.
 *
 * Operational cleanup of expired/terminal IMPORT jobs and their STAGED
 * UPLOADS:
 *   - jobs CANCELED / FAILED / EXPIRED → staged file deleted
 *   - jobs COMPLETED older than the import TTL → staged file deleted
 *   - UPLOADED..READY jobs past expiresAt → EXPIRED (never committable, §167)
 *     and their staged files removed
 *   - orphan files in the imports directory (job row no longer exists)
 *
 * SAFETY LAWS:
 *   - DRY RUN by default; --apply required for real deletion.
 *   - Audit records are NEVER deleted (§248).
 *   - COMMITTING jobs are NEVER touched by cleanup (crash-recovery races,
 *     §315 — the stale-job detector owns them).
 *   - Output shows counts only — never file contents (§249).
 *
 * Run:  bun scripts/prune-expired-imports.mjs [--apply]
 * Exit: 0 = ok · 1 = failure.
 */
import { PrismaClient } from "@prisma/client";
import { existsSync, readdirSync, unlinkSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const apply = process.argv.includes("--apply");

function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = new URL("..", import.meta.url).pathname + ".env";
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

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

const expiredActive = await db.dataImportJob.findMany({
  where: { status: { in: ["UPLOADED", "PARSING", "MAPPING_REQUIRED", "VALIDATING", "READY"] }, expiresAt: { not: null, lte: now } },
  select: { id: true, storageKey: true },
});
const terminalWithFiles = await db.dataImportJob.findMany({
  where: { status: { in: ["CANCELED", "FAILED", "EXPIRED", "COMPLETED"] }, storageKey: { not: null } },
  select: { id: true, storageKey: true, status: true, completedAt: true },
});
const ttlCutoff = new Date(now.getTime() - 72 * 3_600_000); // conservative floor; env TTL documented in docs

console.log(`prune-expired-imports ${apply ? "(APPLY)" : "(dry-run)"}`);
console.log(`  expired-not-yet-committable jobs: ${expiredActive.length}`);
console.log(`  terminal jobs with lingering staged files: ${terminalWithFiles.length}`);

function deleteStaged(storageKey) {
  if (!storageKey) return;
  try {
    const target = join(storageRoot(), "imports", storageKey);
    const st = lstatSync(target);
    if (!st.isSymbolicLink()) unlinkSync(target); // §313
  } catch {
    /* already gone */
  }
}

if (apply) {
  for (const job of expiredActive) {
    try {
      await db.dataImportJob.update({ where: { id: job.id }, data: { status: "EXPIRED", completedAt: now } });
      deleteStaged(job.storageKey);
      if (job.storageKey) await db.dataImportJob.update({ where: { id: job.id }, data: { storageKey: null } });
    } catch (e) {
      failures += 1;
      console.error(`  failed to expire ${job.id.slice(-8)}: ${e?.code ?? "error"}`);
    }
  }
  for (const job of terminalWithFiles) {
    // COMPLETED jobs keep their audit trail; only the staged file is dropped
    // once definitively past the TTL floor.
    if (job.status === "COMPLETED" && job.completedAt && job.completedAt > ttlCutoff) continue;
    deleteStaged(job.storageKey);
    if (job.storageKey) {
      try {
        await db.dataImportJob.update({ where: { id: job.id }, data: { storageKey: null } });
      } catch {
        failures += 1;
      }
    }
  }
}

const root = storageRoot();
if (forbiddenRoot(root)) {
  console.error("  refusing to scan: storage root is inside a web-served directory");
  failures += 1;
} else {
  let orphans = 0;
  try {
    const dir = join(root, "imports");
    const files = readdirSync(dir).filter((f) => !f.startsWith("."));
    for (const file of files) {
      const jobId = file.split(".")[0];
      const exists = await db.dataImportJob.findUnique({ where: { id: jobId }, select: { id: true } });
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
    console.log(`  orphan import artifacts: ${orphans}`);
  } catch {
    console.log("  import artifact directory not readable (or absent) — skipped");
  }
}

console.log(failures === 0 ? "done" : `done with ${failures} failure(s)`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
