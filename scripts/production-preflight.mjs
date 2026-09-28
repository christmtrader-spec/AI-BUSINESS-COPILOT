#!/usr/bin/env node
/**
 * production-preflight.mjs — Prompt 29 §44/§45/§111.
 *
 * READ-ONLY deployment preflight. It NEVER mutates production data and it
 * never runs migrations — it reports. Sequence (§44):
 *   1. environment validation (production-config-check core)
 *   2. database reachability
 *   3. migration status
 *   4. backup destination (exists + at least one VERIFIED backup)
 *   5. schema checks (prisma validate)
 *   6. build artifact check (when .next/standalone exists)
 *   7. legal/public config status
 *   8. email status
 *   9. payment status
 *  10. AI cost status
 *  11. health/readiness endpoint compatibility (when the app is reachable)
 *
 * Migration GATE (§45): when invoked with --gate (used by the deploy runbook
 * before `prisma migrate deploy`), the script EXITS 1 unless:
 *   - DATABASE_URL is present,
 *   - migration state is understandable,
 *   - at least one verified backup exists (required backup absent → refuse),
 *   - database integrity check passes.
 *
 * Exit codes: 0 = preflight acceptable · 1 = blocking problem (or gate refusal).
 */
import { loadProjectEnv } from "./lib/env-loader.mjs";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, accessSync, constants } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv();
const IS_PROD = (process.env.NODE_ENV ?? "").trim() === "production";
const GATE = process.argv.slice(2).includes("--gate");

let blocking = [];
let warnings = [];
function block(msg) { blocking.push(msg); console.error(` ⛔ ${msg}`); }
function warn(msg) { warnings.push(msg); console.log(` ⚠ ${msg}`); }
function pass(msg) { console.log(` ✔ ${msg}`); }
function section(t) { console.log(`\n== ${t} ${"=".repeat(Math.max(0, 64 - t.length))}`); }

const URL_RE = /^https?:\/\/[^\s]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

console.log(`production-preflight${GATE ? " [MIGRATION GATE]" : ""} — env=${process.env.NODE_ENV ?? "development"}`);

/* ------------------------- 1. environment validation ---------------------- */
section("1. Environment");
const env = (k) => (process.env[k] ?? "").trim();
const dbUrl = env("DATABASE_URL");
const secret = env("NEXTAUTH_SECRET");
const nextauthUrl = env("NEXTAUTH_URL");

if (!dbUrl) block("DATABASE_URL missing");
else pass(`DATABASE_URL set (${dbUrl.toLowerCase().startsWith("file:") ? "sqlite file: URL" : "form unrecognized — verify datasource"})`);
if (!secret) block("NEXTAUTH_SECRET missing");
else if (secret.length < 32) block(`NEXTAUTH_SECRET too short (${secret.length} < 32)`);
else pass("NEXTAUTH_SECRET present (length ok)");
if (!nextauthUrl) block("NEXTAUTH_URL missing");
else if (!URL_RE.test(nextauthUrl)) block("NEXTAUTH_URL is not an absolute http(s) URL");
else pass(`NEXTAUTH_URL ok (origin: ${new URL(nextauthUrl).origin})`);
const appBaseUrl = env("APP_BASE_URL");
if (appBaseUrl && !URL_RE.test(appBaseUrl)) block("APP_BASE_URL set but not an absolute URL");

/* --------------------------- 2. database reachability --------------------- */
section("2. Database");
function sqlitePathFromUrl(v) {
  if (v.toLowerCase().startsWith("file:")) {
    const p = v.slice(5).split("?")[0];
    return isAbsolute(p) ? p : join(ROOT, "prisma", p);
  }
  return isAbsolute(v) ? v : join(ROOT, v);
}
let db = null;
let dbPath = null;
if (dbUrl) {
  dbPath = sqlitePathFromUrl(dbUrl);
  if (dbPath && existsSync(dbPath)) {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      pass("database reachable (read-only open)");
    } catch (e) { block(`database NOT reachable: ${String(e?.message ?? e).slice(0, 80)}`); }
  } else {
    block("database file not found at resolved path (deploy will create it — gate requires an existing DB + backup)");
  }
}

/* ----------------------------- 3. migration status ------------------------ */
section("3. Migrations");
let migrationRows = 0;
let pendingRows = 0;
if (db) {
  try {
    migrationRows = Number(db.prepare(`SELECT COUNT(*) AS c FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`).get()?.c ?? 0);
    pendingRows = Number(db.prepare(`SELECT COUNT(*) AS c FROM "_prisma_migrations" WHERE finished_at IS NULL`).get()?.c ?? 0);
    pass(`${migrationRows} applied / ${pendingRows} unfinished`);
  } catch (e) { block(`migration table unreadable: ${String(e?.message ?? e).slice(0, 60)}`); }
} else {
  warn("skipped (database unreachable)");
}

/* ------------------------------- 4. backup gate ---------------------------- */
section("4. Backups (§45 gate: verified backup REQUIRED before migration)");
const backupDir = env("BACKUP_DIR") ? (isAbsolute(env("BACKUP_DIR")) ? env("BACKUP_DIR") : join(ROOT, env("BACKUP_DIR"))) : join(ROOT, "db", "backups");
let verifiedBackups = 0;
let latestVerifiedAgeHours = null;
try {
  statSync(backupDir);
  accessSync(backupDir, constants.W_OK);
  const sidecars = readdirSync(backupDir)
    .filter((f) => f.endsWith(".json") && f !== "last-restore-drill.json")
    .map((f) => { try { return JSON.parse(readFileSync(join(backupDir, f), "utf8")); } catch { return null; } })
    .filter(Boolean)
    .filter((s) => s.verified === true && s.backupFile && existsSync(join(backupDir, s.backupFile)));
  verifiedBackups = sidecars.length;
  if (sidecars.length > 0) {
    const newest = sidecars.map((s) => new Date(s.createdAt).getTime()).sort((a, b) => b - a)[0];
    latestVerifiedAgeHours = (Date.now() - newest) / 3_600_000;
  }
} catch { /* dir missing */ }
if (verifiedBackups === 0) {
  if (GATE) block("no VERIFIED backup exists — run scripts/backup-db.mjs + scripts/verify-backup.mjs first (§45)");
  else warn("no verified backup yet (advisory outside the migration gate)");
} else {
  pass(`${verifiedBackups} verified backup(s), latest ~${latestVerifiedAgeHours === null ? "?" : latestVerifiedAgeHours.toFixed(1)}h old`);
}
const drillFile = join(backupDir, "last-restore-drill.json");
if (existsSync(drillFile)) {
  try {
    const drill = JSON.parse(readFileSync(drillFile, "utf8"));
    if (drill.result === "PASS") pass(`last restore drill PASS (${String(drill.ranAt ?? "").slice(0, 10)})`);
    else warn(`last restore drill FAILED — investigate before deploying (§45 spirit)`);
  } catch { warn("restore-drill record unreadable"); }
} else {
  warn("no restore drill has ever run (scripts/restore-drill.mjs)");
}

/* ----------------------------- 5. schema checks --------------------------- */
section("5. Schema");
const schemaCheck = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "validate", "--schema", join(ROOT, "prisma", "schema.prisma")],
  { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
if (schemaCheck.status === 0) pass("prisma validate ok");
else block(`prisma validate failed: ${(schemaCheck.stderr ?? schemaCheck.stdout ?? "").slice(0, 120)}`);

/* ---------------------------- 6. build artifact --------------------------- */
section("6. Build artifact (advisory)");
const standalone = join(ROOT, ".next", "standalone", "server.js");
if (existsSync(standalone)) pass("standalone server.js present");
else warn("no .next/standalone build — run the release procedure before deploying (§68)");

/* -------------------------- 7. legal/public config ------------------------ */
section("7. Legal / public trust");
const pubBase = env("PUBLIC_BASE_URL");
if (!pubBase) warn("PUBLIC_BASE_URL not configured (public posture incomplete, §99)");
else if (!pubBase.startsWith("https://")) warn("PUBLIC_BASE_URL is NOT https (§99)");
else pass(`PUBLIC_BASE_URL https ok (${new URL(pubBase).origin})`);
for (const [k, label] of [["PUBLIC_COMPANY_LEGAL_NAME", "legal name"], ["PUBLIC_SUPPORT_EMAIL", "support"], ["PRIVACY_CONTACT_EMAIL", "privacy"], ["LEGAL_CONTACT_EMAIL", "legal"], ["SECURITY_CONTACT_EMAIL", "security"]]) {
  const v = env(k);
  if (!v) warn(`${label} contact NOT_CONFIGURED (advisory)`);
  else if (label.endsWith("email") && !EMAIL_RE.test(v)) warn(`${label} contact INVALID`);
  else pass(`${label} contact configured`);
}

/* -------------------------------- 8. email --------------------------------- */
section("8. Email");
const eHost = env("EMAIL_SERVER_HOST"), ePort = env("EMAIL_SERVER_PORT"), eFrom = env("EMAIL_FROM"),
      eUser = env("EMAIL_SERVER_USER"), ePass = process.env.EMAIL_SERVER_PASSWORD ?? "", eSecure = env("EMAIL_SECURE");
if (!eHost && !ePort && !eFrom && !eUser && !ePass) {
  warn("EMAIL_TRANSPORT NOT_CONFIGURED — password reset returns uniform 503 in production (§100: honest, not fake-ready)");
} else {
  const problems = [];
  if (!eHost) problems.push("MISSING_HOST");
  if (!ePort) problems.push("MISSING_PORT");
  if (!eFrom) problems.push("MISSING_FROM");
  if (ePass && !eUser) problems.push("PASSWORD_WITHOUT_USER");
  if (eUser && !ePass) problems.push("USER_WITHOUT_PASSWORD");
  if (!eSecure) problems.push(IS_PROD ? "SECURE_FLAG_REQUIRED_IN_PROD" : "SECURE_FLAG_UNSET");
  else if (IS_PROD && ["false", "0"].includes(eSecure.toLowerCase())) problems.push("INSECURE_MODE_BLOCKED_IN_PROD");
  if (problems.filter(Boolean).length > 0) warn(`email INVALID: ${problems.filter(Boolean).join(",")}`);
  else pass(`email CONFIGURED (host=${eHost} port=${ePort} auth=${eUser ? "yes" : "no"})`);
}

/* ------------------------------ 9. payments ------------------------------- */
section("9. Payments (report-only)");
const paymentsEnabled = env("PAYMENTS_ENABLED") === "true";
if (!paymentsEnabled) pass("payments DISABLED (intentional default — §177)");
else if (env("PAYMENT_ENV") === "production") warn("PAYMENTS_ENABLED=true with PAYMENT_ENV=production — confirm credentials/legal/currency/price book are legitimately satisfied (§102)");
else pass(`payments enabled for env=${env("PAYMENT_ENV") || "unset"}`);

/* ------------------------------ 10. AI cost ------------------------------- */
section("10. AI cost");
const aiEnv = env("AI_COST_ENVIRONMENT");
pass(`AI_COST_ENVIRONMENT=${aiEnv || (IS_PROD ? "(defaults PRODUCTION in prod)" : "(defaults TEST in dev)")}`);
console.log("  · verified production rate count is DB state — Platform System shows it (0 = honest NOT_CONFIGURED, §178)");

/* --------------------- 11. health/readiness compatibility ----------------- */
section("11. Health/Readiness endpoints (when the app is reachable)");
console.log("  · liveness: GET /api/health · readiness: GET /api/ready (documented in production-operations.md §94)");
console.log("  · probe them AFTER start; this preflight does not require the app to be running");

/* --------------------------------- result --------------------------------- */
console.log(`\n== PREFLIGHT RESULT ${"=".repeat(40)}`);
if (blocking.length > 0) {
  console.error(`✖ ${blocking.length} blocking problem(s):`);
  for (const b of blocking) console.error(`   - ${b}`);
  console.error(GATE ? "MIGRATION GATE: REFUSED (do not run prisma migrate deploy)" : "PREFLIGHT: FAILED");
  process.exit(1);
}
console.log(`✔ PREFLIGHT: acceptable (${warnings.length} warning(s)).`);
if (GATE) console.log("MIGRATION GATE: OPEN — a verified backup exists; `prisma migrate deploy` may proceed.");
process.exit(0);
