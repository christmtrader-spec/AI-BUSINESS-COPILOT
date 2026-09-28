#!/usr/bin/env node
/**
 * prune-backups.mjs — Prompt 29 §56/§57/§111.
 *
 * Optional LOCAL backup retention cleanup. Retention is OPERATIONAL backup
 * policy (how many backup artifacts to keep) — it is NOT legal data-retention
 * policy and must never be presented as such (§57).
 *
 * Safety laws (§56/§111):
 *  - DRY RUN by default: deletions happen ONLY with explicit --apply.
 *  - NEVER delete based only on filename when checksum metadata (sidecar)
 *    is missing — such backups are reported and SKIPPED.
 *  - The most recent verified backup is always kept.
 *
 * Retention model: keep the newest N distinct DAY snapshots and the newest
 * N distinct WEEK snapshots plus always the latest verified backup.
 * BACKUP_RETENTION_DAILY (default 7) · BACKUP_RETENTION_WEEKLY (default 4).
 *
 * Exit codes: 0 = ok (dry-run report or applied) · 1 = usage/IO error.
 */
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.slice(2).includes("--apply");

const backupDir = (process.env.BACKUP_DIR ?? "").trim()
  ? (isAbsolute(process.env.BACKUP_DIR) ? process.env.BACKUP_DIR : join(ROOT, process.env.BACKUP_DIR))
  : join(ROOT, "db", "backups");

if (!existsSync(backupDir)) {
  console.log(`prune-backups: ${backupDir} does not exist — nothing to prune.`);
  process.exit(0);
}

function retentionEnv(name, def) {
  const n = Number((process.env[name] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
}
const keepDaily = retentionEnv("BACKUP_RETENTION_DAILY", 7);
const keepWeekly = retentionEnv("BACKUP_RETENTION_WEEKLY", 4);

const entries = readdirSync(backupDir)
  .filter((f) => f.endsWith(".db") && f.startsWith("backup-"))
  .map((f) => {
    const sidecarName = f.replace(/\.db$/, ".json");
    let sidecar = null;
    try {
      sidecar = JSON.parse(readFileSync(join(backupDir, sidecarName), "utf8"));
    } catch { sidecar = null; }
    return {
      file: f,
      path: join(backupDir, f),
      createdAt: sidecar?.createdAt ?? null,
      verified: sidecar?.verified === true,
      hasSidecar: sidecar !== null,
    };
  })
  .sort((a, b) => (a.file < b.file ? 1 : -1)); // newest first (timestamped names)

if (entries.length === 0) {
  console.log("prune-backups: no backup artifacts found — nothing to prune.");
  process.exit(0);
}

/* -------------------------------- selection ------------------------------- */

const keep = new Set();
// Always keep the newest entry that has a sidecar (prefer verified).
const newestKeepable = entries.find((e) => e.hasSidecar) ?? entries[0];
keep.add(newestKeepable.file);
// Always keep ALL verified backups' newest per day/week buckets below too.
const withDates = entries
  .filter((e) => e.createdAt !== null)
  .map((e) => ({ ...e, date: new Date(e.createdAt) }))
  .filter((e) => !Number.isNaN(e.date.getTime()));

const seenDays = new Map();
const seenWeeks = new Map();
for (const e of withDates) {
  const dayKey = e.date.toISOString().slice(0, 10);
  const weekKey = `${e.date.getUTCFullYear()}-W${String(
    Math.ceil(((e.date - new Date(Date.UTC(e.date.getUTCFullYear(), 0, 1))) / 86_400_000 + 1) / 7),
  ).padStart(2, "0")}`;
  if (!seenDays.has(dayKey)) seenDays.set(dayKey, e);
  if (!seenWeeks.has(weekKey)) seenWeeks.set(weekKey, e);
}
[...seenDays.values()].slice(0, keepDaily).forEach((e) => keep.add(e.file));
[...seenWeeks.values()].slice(0, keepWeekly).forEach((e) => keep.add(e.file));

const deletable = entries.filter((e) => !keep.has(e.file) && e.hasSidecar);
const undeletable = entries.filter((e) => !keep.has(e.file) && !e.hasSidecar);

/* --------------------------------- report --------------------------------- */

console.log(`prune-backups — ${apply ? "APPLY" : "DRY RUN"} (use --apply to delete)`);
console.log(`policy: keep ${keepDaily} daily + ${keepWeekly} weekly + newest sidecar'd backup (OPERATIONAL policy, not legal retention)`);
console.log("");
for (const e of entries) {
  const status = keep.has(e.file)
    ? "KEEP"
    : e.hasSidecar
      ? (apply ? "DELETE" : "WOULD DELETE")
      : "SKIP (no checksum metadata — never deleted by filename, §56)";
  console.log(` ${status.padEnd(12)} ${e.file}${e.verified ? " [verified]" : ""}`);
}

if (apply) {
  for (const e of deletable) {
    unlinkSync(e.path);
    const sidecar = e.path.replace(/\.db$/, ".json");
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  console.log(`\n✔ deleted ${deletable.length} backup artifact(s).`);
} else {
  console.log(`\n(dry run) would delete ${deletable.length} artifact(s) · skipped ${undeletable.length} without metadata.`);
}
process.exit(0);
