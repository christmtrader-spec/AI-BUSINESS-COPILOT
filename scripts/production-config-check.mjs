#!/usr/bin/env node
/**
 * production-config-check.mjs — Prompt 29 §5.
 *
 * Validates the production configuration contract WITHOUT exposing secret
 * values. Exit codes: 0 = acceptable, 1 = configuration invalid/blocking.
 * Optional items (legal contacts, backups, SMTP) are ADVISORY — they do not
 * fail the check; they are reported honestly as NOT_CONFIGURED.
 *
 * Usage: NODE_ENV=production node scripts/production-config-check.mjs
 * (Development runs pass with advisory-only findings.)
 *
 * This script mirrors src/lib/config/production.ts (the in-app authority).
 * Keep both in sync — the app module is used by startup + /api/ready +
 * Platform System; this script is the CI/operator preflight face.
 */
import { loadProjectEnv } from "./lib/env-loader.mjs";
import { existsSync, accessSync, constants, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv();
const NODE_ENV = (process.env.NODE_ENV ?? "development").trim();
const IS_PROD = NODE_ENV === "production";

const URL_RE = /^https?:\/\/[^\s]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

let blocking = 0;
let advisory = 0;

function section(title) {
  console.log(`\n== ${title} ${"=".repeat(Math.max(0, 66 - title.length))}`);
}

function report(label, status, detail, { blocking: isBlocking = false } = {}) {
  const icon =
    status === "CONFIGURED" ? "✔" :
    status === "DISABLED" ? "⏸" :
    status === "BLOCKED" ? "⛔" :
    status === "INVALID" ? "✖" : "○";
  console.log(` ${icon} ${label.padEnd(34)} ${status.padEnd(16)} ${detail ?? ""}`);
  if (isBlocking) blocking += 1;
  else if (status === "INVALID" || status === "NOT_CONFIGURED" || status === "BLOCKED") advisory += 1;
}

function env(k) {
  return (process.env[k] ?? "").trim();
}

function validAbsoluteUrl(v) {
  if (!URL_RE.test(v)) return false;
  try { new URL(v); return true; } catch { return false; }
}

function validSqliteUrl(v) {
  const lower = v.toLowerCase();
  if (lower === ":memory:" || lower === "file::memory:") return false;
  if (lower.startsWith("file:")) {
    const clean = v.slice(5).split("?")[0];
    return clean.length > 0;
  }
  if (lower.startsWith("postgresql") || lower.startsWith("mysql")) return false;
  return v.length > 0;
}

/** Resolve the SQLite DB file path from DATABASE_URL (masked reporting). */
function sqlitePathFromUrl(v) {
  if (v.toLowerCase().startsWith("file:")) {
    const p = v.slice(5).split("?")[0];
    if (isAbsolute(p)) return p;
    return join(ROOT, "prisma", p); // Prisma resolves relative to schema.prisma
  }
  if (isAbsolute(v)) return v;
  return join(ROOT, v);
}

console.log(`production-config-check — env=${NODE_ENV}`);

/* ------------------------- 1. mandatory core (§3) ------------------------- */
section("Mandatory core configuration");
const dbUrl = env("DATABASE_URL");
report("DATABASE_URL", dbUrl ? (validSqliteUrl(dbUrl) ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED",
  validSqliteUrl(dbUrl) ? "sqlite url accepted" : "expected sqlite file: URL (not :memory:)",
  { blocking: IS_PROD && (!dbUrl || !validSqliteUrl(dbUrl)) });

const secret = env("NEXTAUTH_SECRET");
report("NEXTAUTH_SECRET", secret ? (secret.length >= 32 ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED",
  secret ? `length=${secret.length} (min 32)` : "required in production",
  { blocking: IS_PROD && secret.length < 32 });

const nextauthUrl = env("NEXTAUTH_URL");
report("NEXTAUTH_URL", nextauthUrl ? (validAbsoluteUrl(nextauthUrl) ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED",
  nextauthUrl ? "absolute URL" : "required in production",
  { blocking: IS_PROD && !validAbsoluteUrl(nextauthUrl) });

const appBaseUrl = env("APP_BASE_URL");
report("APP_BASE_URL", appBaseUrl ? (validAbsoluteUrl(appBaseUrl) ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED",
  appBaseUrl ? "absolute URL (reset links)" : "falls back to NEXTAUTH_URL",
  { blocking: appBaseUrl ? !validAbsoluteUrl(appBaseUrl) : false });

/* --------------------------- 2. database path ----------------------------- */
section("Database file");
if (dbUrl && validSqliteUrl(dbUrl)) {
  const dbPath = sqlitePathFromUrl(dbUrl);
  const exists = existsSync(dbPath);
  let writable = false;
  if (exists) {
    try { accessSync(dbPath, constants.W_OK); writable = true; } catch { writable = false; }
  }
  report("DB file", exists ? (writable ? "CONFIGURED" : "INVALID") : "NOT_FOUND",
    `path=${dirname(dbPath)}/<redacted> ${exists ? (writable ? "writable" : "NOT writable") : "(missing — created on first migrate)"}`);
} else {
  report("DB file", "NOT_CONFIGURED", "skipped (DATABASE_URL invalid)", { blocking: false });
}

/* ----------------------- 3. email transport (§18) ------------------------- */
section("Email transport (SMTP)");
const eHost = env("EMAIL_SERVER_HOST"), ePort = env("EMAIL_SERVER_PORT"),
      eUser = env("EMAIL_SERVER_USER"), ePass = process.env.EMAIL_SERVER_PASSWORD ?? "",
      eFrom = env("EMAIL_FROM"), eSecure = env("EMAIL_SECURE");
if (!eHost && !ePort && !eFrom && !eUser && !ePass) {
  report("EMAIL_TRANSPORT", "NOT_CONFIGURED", "password reset returns uniform 503 in production");
} else {
  const problems = [];
  if (!eHost) problems.push("MISSING_HOST");
  const portN = Number(ePort);
  if (!ePort) problems.push("MISSING_PORT");
  else if (!Number.isInteger(portN) || portN < 1 || portN > 65535) problems.push("INVALID_PORT");
  if (!eFrom) problems.push("MISSING_FROM");
  else if (!EMAIL_RE.test(eFrom)) problems.push("INVALID_FROM");
  if (ePass && !eUser) problems.push("PASSWORD_WITHOUT_USER");
  if (eUser && !ePass) problems.push("USER_WITHOUT_PASSWORD");
  if (!eSecure) problems.push(IS_PROD ? "SECURE_FLAG_REQUIRED_IN_PROD" : null);
  else if (!["true", "false", "1", "0"].includes(eSecure.toLowerCase())) problems.push("INVALID_SECURE_FLAG");
  else if (IS_PROD && ["false", "0"].includes(eSecure.toLowerCase())) problems.push("INSECURE_MODE_BLOCKED_IN_PROD");
  const real = problems.filter(Boolean);
  report("EMAIL_TRANSPORT", real.length === 0 ? "CONFIGURED" : "INVALID",
    real.length === 0 ? `host=${eHost} port=${ePort} auth=${eUser ? "yes" : "no"}` : real.join(","),
    // Invalid email config blocks production (security posture, §10).
    { blocking: IS_PROD && real.length > 0 });
}
report("EMAIL_FROM", eFrom ? (EMAIL_RE.test(eFrom) ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED", eFrom || "", {});

/* --------------------- 4. payments state (§102/§177) ---------------------- */
section("Payments (report-only — never activated here)");
const paymentsEnabled = env("PAYMENTS_ENABLED") === "true";
report("PAYMENTS_ENABLED", paymentsEnabled ? "CONFIGURED" : "DISABLED",
  paymentsEnabled ? "global switch ON" : "intentionally disabled (default)");
const payEnv = env("PAYMENT_ENV");
report("PAYMENT_ENV", payEnv ? "CONFIGURED" : "NOT_CONFIGURED", payEnv || "unset");
if (paymentsEnabled && payEnv === "production" && IS_PROD) {
  const prov = env("PAYMENT_PROVIDER");
  const merch = env("ZARINPAL_MERCHANT_ID");
  const payBase = env("PAYMENT_BASE_URL");
  report("PRODUCTION PAYMENT ENABLEMENT", prov && merch && validAbsoluteUrl(payBase) ? "CONFIGURED" : "BLOCKED",
    "requires provider + merchant + HTTPS base URL (operator action, not this script)");
}

/* ------------------------ 5. AI cost state (§103) ------------------------- */
section("AI cost governance");
const aiEnv = env("AI_COST_ENVIRONMENT");
report("AI_COST_ENVIRONMENT", aiEnv ? (["TEST", "PRODUCTION"].includes(aiEnv.toUpperCase()) ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED",
  aiEnv ? aiEnv.toUpperCase() : "defaults: TEST in dev / PRODUCTION in prod");
const guard = env("AI_COST_GUARD_ENABLED") === "true";
report("AI_COST_GUARD_ENABLED", guard ? "CONFIGURED" : "DISABLED", guard ? "on" : "off (default)");
const opToken = env("AI_COST_OPERATOR_TOKEN");
report("AI_COST_OPERATOR_TOKEN", opToken ? "CONFIGURED" : "NOT_CONFIGURED", opToken ? "set (value never printed)" : "unset");
console.log("  · verified production AI rates live in the DB (AiCostRate) — checked via Platform System, not here (no fake rates)");

/* ------------------- 6. public legal readiness (§99) ---------------------- */
section("Public trust / legal (advisory until operator configures)");
const pubBase = env("PUBLIC_BASE_URL");
report("PUBLIC_BASE_URL", pubBase ? (validAbsoluteUrl(pubBase) ? (pubBase.startsWith("https://") ? "CONFIGURED" : "INVALID") : "INVALID") : "NOT_CONFIGURED",
  pubBase ? (pubBase.startsWith("https://") ? "HTTPS origin" : "HTTP is not production-complete (§99)") : "required before public SEO/canonical production mode",
  // §99 — HTTP public base URL in production IS blocking for public posture.
  { blocking: IS_PROD && pubBase && !pubBase.startsWith("https://") });
for (const [k, label] of [
  ["PUBLIC_COMPANY_LEGAL_NAME", "company legal name"],
  ["PUBLIC_SUPPORT_EMAIL", "support email"],
  ["PRIVACY_CONTACT_EMAIL", "privacy email"],
  ["LEGAL_CONTACT_EMAIL", "legal email"],
  ["SECURITY_CONTACT_EMAIL", "security email"],
]) {
  const v = env(k);
  report(k, v ? (label.endsWith("email") ? (EMAIL_RE.test(v) ? "CONFIGURED" : "INVALID") : (v.length >= 2 ? "CONFIGURED" : "INVALID")) : "NOT_CONFIGURED", "", {});
}

/* ------------------- 7. backup destination (§46/§105) --------------------- */
section("Backups (advisory — automation lives in scripts/backup-db.mjs)");
const backupDir = env("BACKUP_DIR") || join(ROOT, "db", "backups");
let backupOk = false, backupCount = 0;
try {
  statSync(backupDir);
  backupCount = readdirSync(backupDir).filter((f) => f.endsWith(".db") && f.startsWith("backup-")).length;
  accessSync(backupDir, constants.W_OK);
  backupOk = true;
} catch { backupOk = false; }
report("BACKUP_DIR", backupOk ? (backupCount > 0 ? "CONFIGURED" : "NOT_CONFIGURED") : "NOT_CONFIGURED",
  backupOk ? `${backupCount} backup file(s), writable` : `${backupDir} missing/unwritable (run scripts/backup-db.mjs)`);
if (env("BACKUP_MAX_AGE_HOURS")) {
  const n = Number(env("BACKUP_MAX_AGE_HOURS"));
  report("BACKUP_MAX_AGE_HOURS", Number.isFinite(n) && n > 0 ? "CONFIGURED" : "INVALID", env("BACKUP_MAX_AGE_HOURS"));
} else {
  report("BACKUP_MAX_AGE_HOURS", "NOT_CONFIGURED", "default 26h (operational policy, not legal retention)");
}

/* --------------- 8. identity security (Prompt 30 §185/§186/§401) ---------- */
section("Identity security (Prompt 30 posture — §185/§186)");
const mfaOn = (env("MFA_ENABLED") || "").trim().toLowerCase() === "true";
if (!mfaOn) {
  report("MFA_ENABLED", "DISABLED", "MFA capability off (default — §184; users unaffected, §403)");
  const keyAbsent = !env("MFA_ENCRYPTION_KEY");
  report("MFA_ENCRYPTION_KEY", keyAbsent ? "DISABLED" : "CONFIGURED",
    keyAbsent ? "not required while MFA is disabled (§401)" : "present (unused while MFA disabled)");
} else {
  report("MFA_ENABLED", "CONFIGURED", "MFA capability on — enrolled users require the second factor at login");
  const key = env("MFA_ENCRYPTION_KEY") || "";
  // §34/§190 — 32-byte material; validated WITHOUT printing the value.
  let keyOk = false;
  if (key.length >= 43 && !/^(.)\1+$/.test(key) && !/changeme|example|placeholder|your-?key|sample|dummy/i.test(key)) {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    try {
      const decoded = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64");
      keyOk = decoded.length === 32;
      if (!keyOk && /^[0-9a-fA-F]{64}$/.test(key)) keyOk = Buffer.from(key, "hex").length === 32;
    } catch { keyOk = false; }
  }
  report("MFA_ENCRYPTION_KEY", keyOk ? "CONFIGURED" : (key ? "INVALID" : "NOT_CONFIGURED"),
    keyOk ? "32-byte AES-256 key material accepted" : "REQUIRED when MFA_ENABLED=true (§190 fail closed)", { blocking: IS_PROD && !keyOk });
}

const evMode = (env("AUTH_EMAIL_VERIFICATION_MODE") || "").trim().toUpperCase();
const evValid = ["OFF", "OPTIONAL", "REQUIRED"].includes(evMode);
if (!evValid) {
  report("AUTH_EMAIL_VERIFICATION_MODE", evMode ? "INVALID" : "DISABLED",
    evMode ? "must be OFF|OPTIONAL|REQUIRED" : "OFF (default — existing users never locked out, §8/§449)",
    { blocking: IS_PROD && Boolean(evMode) });
} else if (evMode === "OFF") {
  report("AUTH_EMAIL_VERIFICATION_MODE", "DISABLED", "no verification enforcement");
} else {
  // §185/§401 — REQUIRED without SMTP is BLOCKED (startup blocking in prod).
  const smtpParts = ["EMAIL_SERVER_HOST", "EMAIL_SERVER_PORT", "EMAIL_FROM"].map(env).filter(Boolean).length;
  const smtpOk = smtpParts === 3;
  report("AUTH_EMAIL_VERIFICATION_MODE", evMode === "REQUIRED" && !smtpOk ? "BLOCKED" : "CONFIGURED",
    evMode === "REQUIRED"
      ? smtpOk ? "REQUIRED with SMTP transport" : "REQUIRED without SMTP = BLOCKED (§11/§401) — configure EMAIL_* or choose OPTIONAL"
      : "OPTIONAL — verification available, accounts usable",
    { blocking: IS_PROD && evMode === "REQUIRED" && !smtpOk });
}
report("SESSION_LAST_SEEN_UPDATE_SECONDS", env("SESSION_LAST_SEEN_UPDATE_SECONDS") ? "CONFIGURED" : "NOT_CONFIGURED", "default 300 (write throttle, §85)");
report("MFA_CHALLENGE_TTL_SECONDS", env("MFA_CHALLENGE_TTL_SECONDS") ? "CONFIGURED" : "NOT_CONFIGURED", "default 300 (§47)");
report("MFA_STEP_UP_MAX_AGE_SECONDS", env("MFA_STEP_UP_MAX_AGE_SECONDS") ? "CONFIGURED" : "NOT_CONFIGURED", "default 600 (§115)");

/* ------------------------------ summary ----------------------------------- */
console.log(`\n== RESULT ${"=".repeat(58)}`);
if (blocking > 0) {
  console.log(`✖ BLOCKING: ${blocking} problem(s) must be fixed before production startup.`);
  process.exit(1);
}
console.log(`✔ ACCEPTABLE: 0 blocking problems. ${advisory} advisory finding(s) — honest NOT_CONFIGURED states are acceptable until deliberately configured.`);
process.exit(0);
