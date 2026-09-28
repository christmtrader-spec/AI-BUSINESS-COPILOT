#!/usr/bin/env node
/**
 * verify-backup.mjs — Prompt 29 §51/§113.
 *
 * Verifies a backup artifact WITHOUT altering it:
 *  1. file exists (and is not empty),
 *  2. SHA-256 checksum matches the sidecar when one exists (§113 — a
 *     checksum mismatch is an immediate FAIL, no continuation),
 *  3. the file opens as SQLite,
 *  4. PRAGMA integrity_check + quick_check = ok, foreign_key_check = 0,
 *  5. migration metadata is readable where possible (count + latest name).
 *
 * On SUCCESS the sidecar's `verified` flag is set to true — this is the
 * only mutation (metadata sidecar, never the .db artifact).
 *
 * Exit codes: 0 = verified · 1 = FAILED · 2 = usage error.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/verify-backup.mjs <path/to/backup.db>   (or a bare name inside db/backups)");
  process.exit(2);
}

const backupDir = (process.env.BACKUP_DIR ?? "").trim()
  ? (isAbsolute(process.env.BACKUP_DIR) ? process.env.BACKUP_DIR : join(ROOT, process.env.BACKUP_DIR))
  : join(ROOT, "db", "backups");

const backupPath = isAbsolute(arg)
  ? arg
  : (existsSync(join(backupDir, arg)) ? join(backupDir, arg) : resolve(process.cwd(), arg));

let failures = [];

if (!existsSync(backupPath)) {
  console.error(`✖ verify-backup: file not found: ${basename(backupPath)}`);
  process.exit(1);
}
const size = statSync(backupPath).size;
if (size === 0) failures.push("FILE_EMPTY");

/* ----------------------------- checksum §113 ------------------------------ */

const sidecarPath = backupPath.replace(/\.db$/, ".json");
let sidecar = null;
if (existsSync(sidecarPath)) {
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    failures.push("SIDECAR_UNREADABLE");
  }
}

if (sidecar?.sha256) {
  const hash = createHash("sha256");
  const fd = openSync(backupPath, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let read = 0;
    while ((read = readSync(fd, buf, null, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  const actual = hash.digest("hex");
  if (actual !== sidecar.sha256) {
    // §113 — mismatch: FAIL immediately, never continue to restore.
    console.error(`✖ verify-backup: CHECKSUM MISMATCH (expected ${sidecar.sha256.slice(0, 16)}…, actual ${actual.slice(0, 16)}…)`);
    process.exit(1);
  }
  console.log(`  · checksum ok (${actual.slice(0, 16)}…)`);
} else if (sidecar) {
  failures.push("SIDECAR_MISSING_SHA256");
} else {
  console.log("  · no sidecar — checksum skipped (backup cannot be marked verified without one)");
  failures.push("NO_SIDECAR");
}

/* --------------------------- sqlite + integrity --------------------------- */

let integrity = { integrityCheck: "unknown", quickCheck: "unknown", foreignKeyViolations: -1 };
let migrationCount = null;
let migrationLatest = null;
let opens = false;
try {
  const db = new DatabaseSync(backupPath, { readOnly: true });
  opens = true;
  integrity.integrityCheck = String(Object.values(db.prepare("PRAGMA integrity_check").get() ?? { v: "unknown" })[0]);
  integrity.quickCheck = String(Object.values(db.prepare("PRAGMA quick_check").get() ?? { v: "unknown" })[0]);
  integrity.foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  try {
    migrationCount = Number(db.prepare(
      `SELECT COUNT(*) AS applied FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    ).get()?.applied ?? 0);
    migrationLatest = db.prepare(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    ).get()?.migration_name ?? null;
  } catch { migrationCount = null; }
  db.close();
} catch (error) {
  failures.push("SQLITE_OPEN_FAILED");
  console.error(`  · sqlite open failed: ${String(error?.message ?? error).slice(0, 120)}`);
}

if (integrity.integrityCheck !== "ok") failures.push(`INTEGRITY_${integrity.integrityCheck.toUpperCase()}`);
if (integrity.quickCheck !== "ok") failures.push(`QUICK_${integrity.quickCheck.toUpperCase()}`);
if (integrity.foreignKeyViolations !== 0) failures.push(`FK_VIOLATIONS_${integrity.foreignKeyViolations}`);

const ok = failures.length === 0 && opens;

console.log(`\n== VERIFY RESULT ${"=".repeat(45)}`);
console.log(` backup:      ${basename(backupPath)}`);
console.log(` size:        ${size} bytes`);
console.log(` integrity:   ${integrity.integrityCheck} / quick=${integrity.quickCheck} / fk=${integrity.foreignKeyViolations}`);
console.log(` migrations:  ${migrationCount === null ? "unreadable" : `${migrationCount} applied (latest: ${migrationLatest ?? "unknown"})`}`);

if (ok && sidecar) {
  // Only metadata mutation: verified=true (artifact untouched).
  sidecar.verified = true;
  sidecar.verifiedAt = new Date().toISOString();
  sidecar.verifiedBy = "scripts/verify-backup.mjs";
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(` sidecar:     verified=true (${basename(sidecarPath)})`);
}

if (ok) {
  console.log("✔ PASS");
  process.exit(0);
}
console.error(`✖ FAIL: ${failures.join(", ")}`);
process.exit(1);
