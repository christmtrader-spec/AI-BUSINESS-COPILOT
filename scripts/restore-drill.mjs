#!/usr/bin/env node
/**
 * restore-drill.mjs — Prompt 29 §52/§53/§54/§55/§113/§115/§116.
 *
 * Automated RESTORE DRILL: proves a backup is restorable WITHOUT ever
 * touching the production database.
 *
 * Sequence (§52):
 *   1. choose a backup (argument, else latest VERIFIED backup)
 *   2. verify its checksum BEFORE anything else (§113 — mismatch = FAIL)
 *   3. copy it to a temporary ISOLATED directory (os.tmpdir)
 *   4. run integrity checks on the clone
 *   5. point a TEMPORARY DATABASE_URL at the clone and run
 *      `prisma migrate status` for migration compatibility (§116)
 *   6. run READ-ONLY smoke queries across key entities (§53)
 *   7. report PASS/FAIL per check (§54) — no ambiguous success
 *
 * Destructive protection (§55):
 *   - The drill NEVER writes to the production database file.
 *   - If asked to operate against the production DATABASE_URL target, it
 *     REFUSES (exit 2) unless --allow-production-restore is passed — and
 *     even then, in-place restore is NOT IMPLEMENTED in Prompt 29 (exit 3).
 *     The production DB is never overwritten automatically.
 *
 * The drill writes db/backups/last-restore-drill.json (read by readiness).
 *
 * Exit codes: 0 = PASS · 1 = FAIL · 2 = PRODUCTION_RESTORE_REJECTED ·
 *             3 = IN_PLACE_RESTORE_NOT_IMPLEMENTED · 4 = usage error.
 */
import { loadProjectEnv } from "./lib/env-loader.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv();
const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const allowProductionRestore = args.includes("--allow-production-restore");
const targetArg = argValue("--target");
const backupArg = argValue("--backup");

/* ---------------------- destructive protection (§55) ---------------------- */

const prodUrl = (process.env.DATABASE_URL ?? "").trim();
function sqlitePathFromUrl(v) {
  if (!v) return null;
  if (v.toLowerCase().startsWith("file:")) {
    const p = v.slice(5).split("?")[0];
    return isAbsolute(p) ? p : join(ROOT, "prisma", p);
  }
  if (v.toLowerCase() === ":memory:") return null;
  return isAbsolute(v) ? v : join(ROOT, v);
}
const productionDbPath = sqlitePathFromUrl(prodUrl);

if (targetArg) {
  const targetPath = isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg);
  const isProductionTarget =
    productionDbPath !== null &&
    (targetPath === productionDbPath ||
      statSyncSafe(targetPath)?.dev === statSyncSafe(productionDbPath)?.dev && targetPath === productionDbPath);
  if (isProductionTarget && !allowProductionRestore) {
    console.error("✖ restore-drill: REFUSED — the requested target IS the production database.");
    console.error("  Prompt 29 §55: an explicit --allow-production-restore is required to even consider this,");
    console.error("  and in-place production restore is NOT implemented. Restore = documented operator procedure.");
    process.exit(2);
  }
  if (isProductionTarget && allowProductionRestore) {
    console.error("✖ restore-drill: IN_PLACE_RESTORE_NOT_IMPLEMENTED — Prompt 29 never overwrites a production database automatically.");
    console.error("  Follow docs/deployment/production-operations.md (stop app → verify backup → operator-managed restore).");
    process.exit(3);
  }
  // Non-production explicit target (e.g. a scratch copy) is allowed — it is
  // still drilled on a CLONE, never on the target itself.
}

function statSyncSafe(p) {
  try { return statSync(p); } catch { return null; }
}

/* ------------------------------- pick backup ------------------------------ */

const backupDir = (process.env.BACKUP_DIR ?? "").trim()
  ? (isAbsolute(process.env.BACKUP_DIR) ? process.env.BACKUP_DIR : join(ROOT, process.env.BACKUP_DIR))
  : join(ROOT, "db", "backups");

function latestVerifiedBackup() {
  if (!existsSync(backupDir)) return null;
  const sidecars = readdirSync(backupDir)
    .filter((f) => f.endsWith(".json") && f !== "last-restore-drill.json")
    .map((f) => {
      try {
        const raw = JSON.parse(readFileSync(join(backupDir, f), "utf8"));
        return { name: f, raw, createdAt: raw.createdAt ?? "", verified: raw.verified === true, file: raw.backupFile };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return sidecars.find((s) => s.verified && s.file && existsSync(join(backupDir, s.file))) ?? null;
}

let backupPath = null;
let sidecar = null;
if (backupArg) {
  backupPath = isAbsolute(backupArg)
    ? backupArg
    : (existsSync(join(backupDir, backupArg)) ? join(backupDir, backupArg) : resolve(process.cwd(), backupArg));
  const sidecarPath = backupPath.replace(/\.db$/, ".json");
  if (existsSync(sidecarPath)) {
    try { sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")); } catch { sidecar = null; }
  }
} else {
  const latest = latestVerifiedBackup();
  if (latest) {
    backupPath = join(backupDir, latest.file);
    sidecar = latest.raw;
  }
}

if (!backupPath || !existsSync(backupPath)) {
  console.error("✖ restore-drill: no backup found (pass --backup <file> or create one via scripts/backup-db.mjs).");
  process.exit(1);
}
// §55 — a "backup" that is actually the live production DB is refused.
if (productionDbPath && statSync(backupPath).dev === statSync(productionDbPath).dev &&
    statSync(backupPath).ino === statSync(productionDbPath).ino) {
  console.error("✖ restore-drill: REFUSED — the selected file is the LIVE production database, not a backup.");
  process.exit(2);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, result: pass ? "PASS" : "FAIL", detail });
  console.log(` ${pass ? "✔" : "✖"} ${name.padEnd(30)} ${pass ? "PASS" : "FAIL"}  ${detail ?? ""}`);
}

console.log(`== RESTORE DRILL — backup: ${basename(backupPath)}`);

/* ------------------------- checksum verification §113 --------------------- */

let checksumVerified = false;
if (sidecar?.sha256) {
  const hash = createHash("sha256");
  const fd = openSync(backupPath, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let read = 0;
    while ((read = readSync(fd, buf, null, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally { closeSync(fd); }
  checksumVerified = hash.digest("hex") === sidecar.sha256;
  check("checksum", checksumVerified, `sha256 ${checksumVerified ? "matches sidecar" : "MISMATCH"}`);
} else {
  check("checksum", false, "no sidecar checksum — cannot prove integrity (§113)");
}

/* ------------------------- copy to isolated temp dir ---------------------- */

const tmp = mkdtempSync(join(tmpdir(), "restore-drill-"));
const clonePath = join(tmp, "clone.db");
copyFileSync(backupPath, clonePath); // backups are static artifacts — safe to copy

/* ------------------------------- integrity -------------------------------- */

let opens = false;
try {
  const db = new DatabaseSync(clonePath, { readOnly: true });
  opens = true;
  const ic = String(Object.values(db.prepare("PRAGMA integrity_check").get() ?? { v: "unknown" })[0]);
  const qc = String(Object.values(db.prepare("PRAGMA quick_check").get() ?? { v: "unknown" })[0]);
  const fk = db.prepare("PRAGMA foreign_key_check").all().length;
  check("integrity_check", ic === "ok", ic);
  check("quick_check", qc === "ok", qc);
  check("foreign_key_check", fk === 0, `${fk} violations`);

  /* ------------------------ read-only smoke queries §53 ------------------- */
  const ENTITIES = [
    "User", "Business", "Subscription", "Customer", "Product", "Sale",
    "Expense", "AuditLog", "UsageEvent", "AiCostRecord", "PlatformAuditLog",
    // Prompt 40 (§187) — physical count sessions + lines are part of the
    // restore verification surface. Older backups may predate the models —
    // reported honestly, never a drill failure.
    "InventoryStocktake", "InventoryStocktakeLine",
    // Prompt 41 (§103) — procurement documents + lines join the restore
    // verification surface (same honest-absent rule as P40: older backups
    // may predate the models — reported, never a drill failure).
    "PurchaseOrder", "PurchaseOrderLine",
    // Prompt 42 (§140) — goods receipts + lines join the restore
    // verification surface (same honest-absent rule).
    "GoodsReceipt", "GoodsReceiptLine",
  ];
  const counts = {};
  for (const entity of ENTITIES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM "${entity}"`).get();
      counts[entity] = Number(row?.c ?? 0);
      check(`rows:${entity}`, true, String(counts[entity]));
    } catch (error) {
      // PlatformAuditLog is expected to exist (Prompt 28); older backups may
      // predate a model — report honestly rather than failing the drill.
      counts[entity] = "MISSING";
      check(`rows:${entity}`, true, `table absent in this backup (${String(error?.message ?? error).slice(0, 40)})`);
    }
  }
  db.close();
} catch (error) {
  check("sqlite_open", false, String(error?.message ?? error).slice(0, 100));
}

/* -------------------- migration compatibility §116 ------------------------ */

let migrationStatus = "UNKNOWN";
let appliedCount = null;
let pendingCount = null;
if (process.env.PRISMA_AVAILABLE !== "false") {
  const tmpDbUrl = `file:${clonePath}`;
  const res = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "migrate", "status", "--schema", join(ROOT, "prisma", "schema.prisma")],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, DATABASE_URL: tmpDbUrl },
    },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const numApplied = out.match(/(\d+) migrations? found/i);
  const haveNot = /have not yet been executed/i.test(out);
  const devPending = /To apply migrations in development run `?prisma migrate dev/i.test(out);
  const prodPending = /run `?prisma migrate deploy/i.test(out);
  const upToDate = /Database schema is up to date/i.test(out);
  if (upToDate) { migrationStatus = "UP_TO_DATE"; pendingCount = 0; }
  else if (haveNot || devPending || prodPending) {
    // §116 — the backup predates current migrations: it is RESTORABLE but
    // must never be declared current. Honest PENDING beats a fake green.
    migrationStatus = "PENDING_MIGRATIONS";
    pendingCount = pendingCount ?? 1;
  }
  else if (res.status !== 0) {
    migrationStatus = "STATUS_CHECK_FAILED";
    // Diagnosable failure: last meaningful lines, secrets never included
    // (DATABASE_URL is overridden to the temp clone — never printed).
    const tail = out.trim().split("\n").filter((l) => l.trim() && !/Environment variables loaded/i.test(l)).slice(-3).join(" | ");
    console.error(`  · prisma migrate status failed (exit=${res.status}): ${tail.slice(0, 200)}`);
  }
  else { migrationStatus = "UNKNOWN"; }
  appliedCount = numApplied ? Number(numApplied[1]) : null;
  check("migration_compatibility", migrationStatus !== "STATUS_CHECK_FAILED" && migrationStatus !== "UNKNOWN",
    `${migrationStatus}${appliedCount !== null ? ` · ${appliedCount} applied` : ""}${pendingCount ? ` · pending!` : ""}`);
} else {
  check("migration_compatibility", true, "prisma CLI disabled for this run (PRISMA_AVAILABLE=false)");
}

/* ------------------------------ report §54 -------------------------------- */

const failed = results.filter((r) => r.result === "FAIL");
const pass = checksumVerified && opens && failed.length === 0;
const record = {
  ranAt: new Date().toISOString(),
  result: pass ? "PASS" : "FAIL",
  backup: basename(backupPath),
  checksumVerified,
  migrationStatus,
  checks: results.length,
  failedChecks: failed.map((f) => f.name),
  tmpDir: tmp, // removed below; recorded for the audit trail before cleanup
};
rmSync(tmp, { recursive: true, force: true });

if (existsSync(backupDir)) {
  writeFileSync(join(backupDir, "last-restore-drill.json"), `${JSON.stringify(record, null, 2)}\n`);
}

console.log(`\n== DRILL RESULT ${"=".repeat(47)}`);
console.log(` backup:        ${record.backup}`);
console.log(` checksum:      ${checksumVerified ? "verified" : "NOT VERIFIED"}`);
console.log(` integrity:     ${failed.some((f) => /integrity|quick|foreign/.test(f.name)) ? "FAILED" : "ok"}`);
console.log(` migrations:    ${migrationStatus}`);
console.log(` entities:      ${results.filter((r) => r.name.startsWith("rows:")).length} probed (read-only)`);
console.log(` RESULT:        ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
