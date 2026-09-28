#!/usr/bin/env node
/**
 * backup-db.mjs — Prompt 29 §46/§47/§48/§49/§50/§112/§114.
 *
 * Deterministic, SQLite-SAFE backup automation for the single-node DB.
 *
 * Online-backup law (§47): the database is NEVER byte-copied with
 * fs.copyFile() while the app may be writing. This script uses SQLite's
 * transactionally-consistent `VACUUM INTO` through a separate connection —
 * the same snapshot semantics as the Online Backup API (a consistent image
 * captured under a read transaction). Under heavy write load SQLite may
 * return SQLITE_BUSY: the script retries with bounded backoff and, if it
 * cannot obtain a consistent snapshot, FAILS SAFELY with instructions —
 * it never pretends a byte-copy is transaction-safe.
 *
 * Integrity law (§50/§112/§114): the freshly written backup is validated
 * (integrity_check, quick_check, foreign_key_check) and a SHA-256 checksum
 * is computed BEFORE the backup may be declared valid. A sidecar JSON
 * (§48) records timestamp, size, checksum, migration count, app version,
 * environment, masked source path and integrity results — NEVER secrets.
 *
 * Overwrite law (§46): an existing backup is NEVER overwritten; the target
 * name is timestamped (§49: no spaces, explicit UTC) and existence aborts.
 *
 * Exit codes: 0 = backup created + validated · 1 = failure (no valid backup).
 */
import { loadProjectEnv } from "./lib/env-loader.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv();
const BACKUP_DIR_ENV = (process.env.BACKUP_DIR ?? "").trim();
const BACKUP_DIR = BACKUP_DIR_ENV
  ? (isAbsolute(BACKUP_DIR_ENV) ? BACKUP_DIR_ENV : join(ROOT, BACKUP_DIR_ENV))
  : join(ROOT, "db", "backups");

function fail(code, message) {
  console.error(`✖ backup-db: ${message} (code=${code})`);
  process.exit(1);
}

/* ------------------------- resolve source database ------------------------ */

const rawUrl = (process.env.DATABASE_URL ?? "").trim();
if (!rawUrl) fail("DB_URL_MISSING", "DATABASE_URL is not set — refusing to guess a database path.");

function sqlitePathFromUrl(v) {
  if (v.toLowerCase().startsWith("file:")) {
    const p = v.slice(5).split("?")[0];
    return isAbsolute(p) ? p : join(ROOT, "prisma", p); // Prisma resolves relative URLs against schema.prisma
  }
  if (v.toLowerCase() === ":memory:") return null;
  return isAbsolute(v) ? v : join(ROOT, v);
}

const dbPath = sqlitePathFromUrl(rawUrl);
if (!dbPath) fail("DB_PATH_UNSAFE", "Refusing to back up an in-memory database.");
if (!existsSync(dbPath)) {
  fail("DB_NOT_FOUND", `Database file not found at the resolved path (dir=${dirname(dbPath)}, name withheld).`);
}

/* ------------------------------ app version ------------------------------- */
// src/lib/app-version.ts is the version authority (§65) — never duplicated.
function appVersion() {
  try {
    const src = readFileSync(join(ROOT, "src", "lib", "app-version.ts"), "utf8");
    const m = src.match(/APP_VERSION\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  } catch { /* fallthrough */ }
  return "unknown";
}

/* ----------------------------- online backup ------------------------------ */

mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date()
  .toISOString()
  .replace(/[:]/g, "-")
  .replace(/\.\d+Z$/, "Z");
const baseName = `backup-${stamp}`;
const targetPath = join(BACKUP_DIR, `${baseName}.db`);
if (existsSync(targetPath)) {
  fail("TARGET_EXISTS", `Refusing to overwrite an existing backup: ${baseName}.db (§46).`);
}

let source;
try {
  source = new DatabaseSync(dbPath, { readOnly: true });
} catch (error) {
  fail("SOURCE_OPEN_FAILED", `Cannot open the source database read-only: ${error?.message ?? error}`);
}

const MAX_ATTEMPTS = 5;
let attempt = 0;
let vacuumOk = false;
let lastError = null;
while (attempt < MAX_ATTEMPTS && !vacuumOk) {
  attempt += 1;
  try {
    // Transactionally-consistent snapshot (SQLite Online Backup semantics).
    source.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
    vacuumOk = true;
  } catch (error) {
    lastError = error;
    const msg = String(error?.message ?? error);
    const busy = /locked|busy/i.test(msg);
    if (existsSync(targetPath)) unlinkSync(targetPath); // no partial artifacts
    if (!busy) break;
    const backoffMs = 400 * attempt;
    console.log(`  · database busy (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${backoffMs}ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
  }
}
source.close();

if (!vacuumOk) {
  console.error(
    "✖ backup-db: could not obtain a consistent snapshot — the application may be under continuous write load.\n" +
    "  Fail-safe per Prompt 29 §47: NO backup was declared. Stop the application briefly and retry,\n" +
    "  or run this during a low-traffic window.",
  );
  if (lastError) console.error(`  last error: ${String(lastError?.message ?? lastError).slice(0, 200)}`);
  process.exit(1);
}

/* -------------------------- integrity + checksum -------------------------- */

const sizeBytes = statSync(targetPath).size;

// SHA-256 checksum is computed AFTER file creation and BEFORE validity (§112).
const hash = createHash("sha256");
const fd = openSync(targetPath, "r");
const buf = Buffer.alloc(1024 * 1024);
try {
  let read = 0;
  while ((read = readSync(fd, buf, null, buf.length, null)) > 0) {
    hash.update(buf.subarray(0, read));
  }
} finally {
  closeSync(fd);
}
const sha256 = hash.digest("hex");

// Integrity validation of the BACKUP copy (§50/§114) — read-only open.
let integrity = { integrityCheck: "unknown", quickCheck: "unknown", foreignKeyViolations: -1 };
let migrationCount = null;
let migrationLatest = null;
try {
  const backupDb = new DatabaseSync(targetPath, { readOnly: true });
  const integrityRow = backupDb.prepare("PRAGMA integrity_check").get();
  integrity.integrityCheck = String(Object.values(integrityRow ?? { v: "unknown" })[0]);
  const quickRow = backupDb.prepare("PRAGMA quick_check").get();
  integrity.quickCheck = String(Object.values(quickRow ?? { v: "unknown" })[0]);
  const fkRows = backupDb.prepare("PRAGMA foreign_key_check").all();
  integrity.foreignKeyViolations = fkRows.length;
  try {
    const rows = backupDb.prepare(
      `SELECT COUNT(*) AS applied FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    ).get();
    migrationCount = Number(rows?.applied ?? 0);
    const latest = backupDb.prepare(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    ).get();
    migrationLatest = latest?.migration_name ? String(latest.migration_name) : null;
  } catch { migrationCount = null; }
  backupDb.close();
} catch (error) {
  fail("BACKUP_VERIFY_FAILED", `Backup written but could not be opened for validation: ${error?.message ?? error}`);
}

const valid =
  integrity.integrityCheck === "ok" &&
  integrity.quickCheck === "ok" &&
  integrity.foreignKeyViolations === 0;

if (!valid) {
  // Never declare an invalid backup valid (§114). Keep the artifact for
  // forensics but mark the run FAILED (no sidecar = no verified backup).
  console.error(`✖ backup-db: backup FAILED validation: ${JSON.stringify(integrity)}`);
  process.exit(1);
}

/* ------------------------------- sidecar §48 ------------------------------ */

// Source database path is MASKED (§48): only the FIRST path fragment is
// kept (e.g. "/home" or "/tmp"), never a full path, never the URL with
// credentials. No directory name below the root ever appears in metadata.
const maskedSource = (() => {
  const first = dirname(dbPath).split("/").filter(Boolean)[0] ?? "";
  return `/${first}/…/<redacted>`;
})();

const sidecar = {
  backupFile: `${baseName}.db`,
  createdAt: new Date().toISOString(),
  sizeBytes,
  sha256,
  integrity,
  migrationCount,
  migrationLatest,
  appVersion: appVersion(),
  environment: (process.env.NODE_ENV ?? "development") === "production" ? "production" : "development",
  sourceDatabasePathMasked: maskedSource,
  method: "sqlite-vacuum-into",
  verified: false, // flipped to true by scripts/verify-backup.mjs
};
writeFileSync(join(BACKUP_DIR, `${baseName}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);

console.log(`✔ backup-db: created ${baseName}.db`);
console.log(`  size=${sizeBytes} bytes · sha256=${sha256.slice(0, 16)}… · integrity=ok · migrations=${migrationCount ?? "unknown"}`);
console.log(`  sidecar: ${baseName}.json (verified=false until scripts/verify-backup.mjs runs)`);
process.exit(0);
