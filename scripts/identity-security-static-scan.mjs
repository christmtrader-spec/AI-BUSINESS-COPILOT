#!/usr/bin/env node
/**
 * scripts/identity-security-static-scan.mjs — Prompt 30 §410-§416, §490.
 *
 * Structural security invariants over the SOURCE TREE (comments stripped):
 *   §410  no plaintext MFA secret / recovery code / verification token /
 *         login challenge / session token persisted
 *   §411  full NextAuth session requires MFA completion (assertion path)
 *   §412  no security secret in localStorage/sessionStorage/URL/analytics
 *   §413  no verification token logged (console/logger calls)
 *   §414  no recovery code logged
 *   §415  no raw TOTP secret logged or returned after setup
 *   §416  no raw JWT persistence
 *   §466-§469 no GET returning recovery codes / MFA secret / passwordHash /
 *         raw session token
 *
 * Usage: node scripts/identity-security-static-scan.mjs   (bun compatible)
 * Exit:  0 = CLEAN · 1 = violations
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/z/my-project";
const SRC = join(ROOT, "src");
const failures = [];
let passed = 0;

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) files.push(full);
  }
  return files;
}

/** Strip comments (line + block) so docs-in-code never trigger scans. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

const files = walk(SRC);
const srcOf = (f) => stripComments(readFileSync(f, "utf8"));

/* ------------------- §410: plaintext secret persistence ------------------- */
const persistenceForbidden = [
  { pattern: /mfaCredential\.(create|update|upsert)\s*\(\s*\{[\s\S]{0,400}?secret:\s*[^"']/, label: "MfaCredential written with a PLAINTEXT `secret` field (must be encryptedSecret)" },
  { pattern: /mfaRecoveryCode\.(create|createMany|update)\s*\(\s*\{[\s\S]{0,300}?code:\s*["'`]/, label: "MfaRecoveryCode written with a raw `code` literal (hash-only §59)" },
  { pattern: /emailVerificationToken\.(create|createMany)\s*\(\s*\{[\s\S]{0,300}?token:\s*["'`]/, label: "EmailVerificationToken written with a raw `token` field (hash-only §5)" },
  { pattern: /mfaLoginChallenge\.(create|createMany)\s*\(\s*\{[\s\S]{0,300}?challenge:\s*["'`]/, label: "MfaLoginChallenge written with a raw `challenge` (hash-only §47)" },
  { pattern: /userSession\.(create|createMany|update)\s*\(\s*\{[\s\S]{0,300}?sessionToken:\s*[^"']/, label: "UserSession written with raw `sessionToken` (hash-only §72)" },
  { pattern: /userSession\.(create|createMany|update)\s*\(\s*\{[\s\S]{0,300}?jwt:/, label: "UserSession written with a raw JWT (§416)" },
];
let persistenceHits = [];
for (const f of files) {
  const src = srcOf(f);
  for (const { pattern, label } of persistenceForbidden) {
    if (pattern.test(src)) persistenceHits.push(`${f.replace(SRC, "src")}: ${label}`);
  }
}
check("§410: no plaintext security-secret persistence patterns", persistenceHits.length === 0, persistenceHits.join(" | "));

/* ------------- §411: full session cannot bypass MFA completion ------------- */
{
  const authSrc = srcOf(join(SRC, "lib/auth.ts"));
  const hasMfaRequiredThrow = /throw new Error\(SIGNIN_ERROR_MFA_REQUIRED\)/.test(authSrc);
  const hasAssertionClaim = /assertionUsedAt:\s*null/.test(authSrc);
  const assertsBeforeSession = authSrc.indexOf("assertionUsedAt") !== -1 && authSrc.indexOf("completeLogin") !== -1
    ? authSrc.indexOf("assertionUsedAt") < authSrc.lastIndexOf("completeLogin(")
    : false;
  check("§411: authorize throws MFA_REQUIRED before any session for MFA accounts", hasMfaRequiredThrow);
  check("§411: assertion is single-use-claimed during authorize (§53)", hasAssertionClaim);
  check("§411: assertion claim precedes session issuance in authorize", assertsBeforeSession);
  const confirmSrc = srcOf(join(SRC, "app/api/v1/me/security/mfa/setup/confirm/route.ts"));
  check("§411/§38: MFA enable gated on verified TOTP + enabledAt updateMany", /enabledAt:\s*null\s*\}/.test(confirmSrc) && /enabledAt:\s*new Date\(\)/.test(confirmSrc));
}

/* ---------- §412: no security secret in browser storage/URL/analytics ------ */
const storageForbidden = [
  /localStorage\.setItem\(\s*["'`][^"'`]*(mfa|secret|recovery|otp|token|challenge|assertion)/i,
  /sessionStorage\.setItem\(\s*["'`][^"'`]*(mfa|secret|recovery|otp|token|challenge|assertion)/i,
  /localStorage\.setItem\(\s*["'`]abc:recovery/i,
];
let storageHits = [];
for (const f of files.filter((f) => f.endsWith(".tsx") || f.includes("modules/") || f.includes("components/"))) {
  const src = srcOf(f);
  for (const pattern of storageForbidden) {
    if (pattern.test(src)) storageHits.push(f.replace(SRC, "src"));
  }
}
check("§412: no MFA/secret/recovery data in browser storage", storageHits.length === 0, storageHits.join(" | "));
{
  const securityView = srcOf(join(SRC, "modules/settings/security-view.tsx"));
  check("§412/§354: recovery codes never persisted client-side (memory-only handoff)", !securityView.includes("localStorage") || !/localStorage[\s\S]{0,80}recovery/i.test(securityView));
}

/* ------------------------- §413/§414: token logging ------------------------ */
const logForbidden = [
  { pattern: /(console\.(log|info|warn|error)|log(Info|Warn|Error|Debug))\s*\([^)]{0,300}(rawToken|verificationUrl|resetUrl|rawVerificationToken)/, label: "raw verification/reset token passed to a log call" },
  { pattern: /(console\.(log|info|warn|error)|log(Info|Warn|Error|Debug))\s*\([^)]{0,300}(recoveryCodes|recoveryCode\b|rawCode)/, label: "recovery code passed to a log call" },
  { pattern: /(console\.(log|info|warn|error)|log(Info|Warn|Error|Debug))\s*\([^)]{0,300}(otpauthUri|manualKey|qrDataUri)/, label: "provisioning URI / manual key / QR passed to a log call" },
  { pattern: /(console\.(log|info|warn|error)|log(Info|Warn|Error|Debug))\s*\([^)]{0,300}(mfaAssertion|assertion\b|totpSecret|secretBase32)/, label: "MFA assertion / secret passed to a log call" },
];
let logHits = [];
for (const f of files) {
  const src = srcOf(f);
  for (const { pattern, label } of logForbidden) {
    if (pattern.test(src)) logHits.push(`${f.replace(SRC, "src")}: ${label}`);
  }
}
check("§413/§414/§105/§415: no secret material reaches any log call", logHits.length === 0, logHits.join(" | "));

/* -------- §466-§469: no GET endpoints returning security secrets ---------- */
let getHits = [];
for (const f of files.filter((f) => f.includes("/api/"))) {
  const src = srcOf(f);
  // A GET export that selects/returns forbidden material.
  if (/export const GET/.test(src)) {
    for (const bad of ["recoveryCodes", "encryptedSecret", "codeHash", "tokenHash", "sessionTokenHash", "passwordHash", "otpauthUri", "manualKey"]) {
      const getBlock = src.slice(src.indexOf("export const GET"));
      const otherMethod = getBlock.search(/export const (POST|PATCH|DELETE|PUT)/);
      const scope = otherMethod > -1 ? getBlock.slice(0, otherMethod) : getBlock;
      if (scope.includes(bad)) getHits.push(`${f.replace(SRC, "src")} GET references ${bad}`);
    }
  }
}
check("§466-§469: no GET route returns recovery codes / secrets / hashes", getHits.length === 0, getHits.join(" | "));

/* -------------------- §420: service barrel architecture -------------------- */
for (const dir of ["email-verification", "mfa", "sessions", "security-events"]) {
  try { statSync(join(SRC, "lib/auth", dir)); check(`§420: src/lib/auth/${dir}/ service module exists`, true); }
  catch { check(`§420: src/lib/auth/${dir}/ service module exists`, false); }
}
try { statSync(join(SRC, "lib/auth/step-up.ts")); check("§420: src/lib/auth/step-up.ts exists", true); }
catch { check("§420: src/lib/auth/step-up.ts exists", false); }

/* ----------------- §419: client never imports server secrets --------------- */
let clientHits = [];
for (const f of files.filter((f) => f.endsWith(".tsx") || f.includes("modules/"))) {
  const src = srcOf(f);
  if (/from\s+["'`].*security\/secret-box["'`]/.test(src) || /from\s+["'`].*mfa\/service["'`]/.test(src)) {
    clientHits.push(f.replace(SRC, "src"));
  }
}
check("§419: no client module imports secret-box or the MFA service", clientHits.length === 0, clientHits.join(" | "));

/* ------------- Prompt 30-F §27: encryptedSecret plaintext bypass ----------- */
// A write of `encryptedSecret: "<literal>"` (string/template literal) means
// the TOTP secret would be persisted WITHOUT the secret-box envelope.
{
  let bypass = [];
  for (const f of files) {
    const src = srcOf(f);
    if (/encryptedSecret:\s*["'`]/.test(src)) bypass.push(f.replace(SRC, "src"));
  }
  check("§27: encryptedSecret is never written from a plaintext literal", bypass.length === 0, bypass.join(" | "));
}
{
  // Recovery-code / verification-token / challenge models must never be
  // written with a RAW plaintext code/token/challenge field (the hash-only
  // rule). Covers `code: "..."`, `token: "..."`, `challenge: "..."`.
  let rawWrites = [];
  const rawPatterns = [
    [/mfaRecoveryCode\.[a-zA-Z]+\s*\([^)]{0,300}\bcode:\s*["'`]/, "MfaRecoveryCode raw code write"],
    [/emailVerificationToken\.[a-zA-Z]+\s*\([^)]{0,300}\btoken:\s*["'`]/, "EmailVerificationToken raw token write"],
    [/mfaLoginChallenge\.[a-zA-Z]+\s*\([^)]{0,300}\bchallenge:\s*["'`]/, "MfaLoginChallenge raw challenge write"],
  ];
  for (const f of files) {
    const src = srcOf(f);
    for (const [re, label] of rawPatterns) {
      if (re.test(src)) rawWrites.push(`${f.replace(SRC, "src")}: ${label}`);
    }
  }
  check("§27: recovery/verification/challenge models are hash-only (no raw writes)", rawWrites.length === 0, rawWrites.join(" | "));
}

/* -------- Prompt 30-F §28: security-view client-state prohibition ---------- */
{
  const view = srcOf(join(SRC, "modules/settings/security-view.tsx"));
  const violations = [];
  if (/localStorage/.test(view)) violations.push("localStorage");
  if (/sessionStorage/.test(view)) violations.push("sessionStorage");
  if (/console\.(log|error)/.test(view)) violations.push("console.log/error");
  if (/window\.location/.test(view)) violations.push("window.location");
  check("§28: Security Center uses no browser storage/console/location authority", violations.length === 0, violations.join(", "));
  check("§28: Security Center derives MFA availability from the server (no hard-coded true)", !/mfaAvailable\s*=\s*true/.test(view));
}

/* -------- Prompt 30-F §61/§62: every security route ENFORCES its limiter --- */
{
  const routeDirs = [
    join(SRC, "app/api/v1/me/security"),
    join(SRC, "app/api/v1/auth/mfa"),
    join(SRC, "app/api/v1/auth/email-verification"),
  ];
  const limiterMisses = [];
  const collectRoutes = (dir) => {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collectRoutes(full);
        else if (entry === "route.ts") limiterScanFiles.push(full);
      }
    } catch { /* dir absent */ }
  };
  var limiterScanFiles = [];
  for (const d of routeDirs) collectRoutes(d);
  for (const f of limiterScanFiles) {
    const src = srcOf(f);
    const hasLimiter = /rateLimit\(/.test(src);
    // The result must be INSPECTED (`!x.allowed` / `.allowed`) — a bare
    // rateLimit(...) call without inspection is a silent pass (§11).
    const enforces = /if\s*\(![A-Za-z_$][\w$.]*\.allowed\)/.test(src) || /![\w$.]+\.allowed\s*(\|\||\))/.test(src);
    if (!hasLimiter || !enforces) {
      limiterMisses.push(`${f.replace(SRC, "src")}: ${hasLimiter ? "call NOT inspected" : "no rateLimit call"}`);
    }
  }
  check("§61/§62: every Prompt 30 security route inspects its limiter result", limiterMisses.length === 0, limiterMisses.join(" | "));
}

/* ------------------------------- summary ----------------------------------- */
console.log(`\n== identity-security-static-scan: ${passed} passed, ${failures.length} failed ==`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
process.exit(0);
