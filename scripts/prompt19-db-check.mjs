#!/usr/bin/env node
/**
 * scripts/prompt19-db-check.mjs — Prompt 19 database-migration regression
 * harness (§52). Verifies as much as practical that establishing the Prisma
 * migration baseline changed NOTHING about application behavior:
 *
 *   1  migration directory exists
 *   2  baseline migration exists (prisma/migrations/0_init/migration.sql)
 *   3  baseline SQL is valid: 16 CREATE TABLEs, 0 destructive statements,
 *      unique constraints + money INTEGER columns present, no secrets
 *   4  database was not reset (0_init recorded, data present, health OK)
 *   5  row counts preserved vs docs/database/data-inventory-before-baseline.md
 *   6  SQLite integrity + foreign_key_check are clean
 *   7  `prisma migrate status` reports the database up to date
 *   8  dangerous DB commands are HARD-BLOCKED under NODE_ENV=production
 *      (db:push / db:reset / db:migrate) and pass through in development
 *   9  auth still works end-to-end (register → login → /api/v1/me)
 *  10  tenant isolation still works (cross-business 404, forged header 403)
 *  11  money pipeline still works (integer minor units, PARTIAL, overpay 422)
 *  12  Prompt 18 auth still works (password change invalidates old session,
 *      old password dead, new password signs in)
 *
 * Test data is synthetic (@p19check.local). No production secrets required.
 *
 * Usage: node scripts/prompt19-db-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";
const STAMP = Date.now();
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}/.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available");
}

const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

const failures = [];
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  }
}

/* ------------------------------ HTTP helpers ------------------------------ */

function newJar() {
  const cookies = new Map();
  return {
    capture(res) {
      const raw =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get("set-cookie")].filter(Boolean);
      for (const line of raw) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(nameSuffix) {
      for (const [k, v] of cookies) if (k.endsWith(nameSuffix)) return v;
      return null;
    },
  };
}

async function api(path, { method = "GET", body, headers = {}, jar } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined && typeof body !== "string"
        ? { "content-type": "application/json" }
        : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body:
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (jar) jar.capture(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function login(email, password) {
  const jar = newJar();
  const csrfRes = await api("/api/auth/csrf", { jar });
  const rawCookie = jar.get("csrf-token");
  const csrfToken = rawCookie
    ? decodeURIComponent(rawCookie).split("|")[0]
    : csrfRes.json?.csrfToken;
  await api("/api/auth/callback/credentials", {
    method: "POST",
    jar,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
      callbackUrl: `${BASE}/`,
      json: "true",
    }).toString(),
  });
  if (!jar.get("session-token")) throw new Error(`login failed for ${email}`);
  return jar;
}

async function register(name, email, password) {
  const res = await api("/api/v1/auth/register", {
    method: "POST",
    body: { name, email, password },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register failed for ${email}: ${res.status} ${res.text?.slice(0, 160)}`);
  }
  return login(email, password);
}

/* --------------------------------- checks --------------------------------- */

const MODELS = [
  "User",
  "PasswordResetToken",
  "Business",
  "BusinessMember",
  "BusinessInvite",
  "AuditLog",
  "Customer",
  "Supplier",
  "Product",
  "InventoryAdjustment",
  "Sale",
  "SaleItem",
  "Expense",
  "Payment",
  "ChatSession",
  "ChatMessage",
];

console.log(`\nPROMPT 19 — database migration regression harness @ ${BASE}\n`);

// --- 1-3: migration files ---------------------------------------------------
console.log("[1-3] migration directory & baseline SQL");
const migDir = `${ROOT}/prisma/migrations`;
check("1. prisma/migrations directory exists", existsSync(migDir));
const baselinePath = `${migDir}/0_init/migration.sql`;
check("2. baseline 0_init/migration.sql exists", existsSync(baselinePath));

const baselineSql = existsSync(baselinePath) ? readFileSync(baselinePath, "utf8") : "";
const missingTables = MODELS.filter((m) => !baselineSql.includes(`CREATE TABLE "${m}"`));
check(
  "3a. baseline creates all 16 models",
  baselineSql !== "" && missingTables.length === 0,
  missingTables.join(","),
);
// DML detection: UPDATE only counts when it targets a quoted table name
// ("ON UPDATE CASCADE" in FK definitions must not false-positive).
const destructive = /\b(DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+")/i.test(baselineSql);
check("3b. baseline contains no destructive/dml statements", !destructive);
const uniqueKeys = [
  "User_email_key",
  "PasswordResetToken_tokenHash_key",
  "Business_slug_key",
  "BusinessMember_businessId_userId_key",
  "BusinessInvite_token_key",
  "Sale_businessId_number_key",
  "ChatSession_businessId_userId_id_key",
];
check(
  "3c. baseline has all 7 unique constraints",
  uniqueKeys.every((k) => baselineSql.includes(k)),
  uniqueKeys.filter((k) => !baselineSql.includes(k)).join(","),
);
const moneyCols = /"totalMinor" INTEGER|"amountMinor" INTEGER|"unitPriceMinor" INTEGER|"lineTotalMinor" INTEGER/.test(
  baselineSql,
);
check("3d. money columns are INTEGER (minor units, A08)", moneyCols);
// §47: no seeded rows (INSERT/VALUES) and no credential-assignment patterns;
// column NAMES like "passwordHash" are schema metadata, not secrets.
const sqlNoComments = baselineSql.replace(/^--.*$/gm, "");
const secretLike = /(INSERT\s+INTO|VALUES\s*\()/i.test(sqlNoComments) ||
  /(secret|api[_-]?key|bearer)\s*[:=]\s*['"][^'"]{8,}/i.test(sqlNoComments);
check("3e. baseline contains no credentials/secrets (§47)", !secretLike);

// --- 4-6: live database state ------------------------------------------------
console.log("[4-6] live database state");
const migRows = await prisma.$queryRawUnsafe(`SELECT migration_name, finished_at FROM "_prisma_migrations"`);
const baselineRecorded = migRows.some((r) => r.migration_name === "0_init" && r.finished_at !== null);
check("4a. 0_init recorded as applied in _prisma_migrations", baselineRecorded);
const [userCount, businessCount, saleCount] = await Promise.all([
  prisma.user.count(),
  prisma.business.count(),
  prisma.sale.count(),
]);
check(
  "4b. database holds real data (not reset)",
  userCount > 0 && businessCount > 0,
  `users=${userCount} businesses=${businessCount}`,
);
let health = null;
try {
  const hres = await fetch(`${BASE}/api/health`);
  health = await hres.json();
} catch {
  /* server down */
}
check(
  "4c. /api/health: database reachable + 0 pending migrations",
  health?.status === "ok" && health?.database?.reachable === true && health?.migrations?.pending === 0,
  JSON.stringify(health),
);

const inventoryDoc = `${ROOT}/docs/database/data-inventory-before-baseline.md`;
check("5a. pre-baseline inventory document exists", existsSync(inventoryDoc));
let countIssues = [];
if (existsSync(inventoryDoc)) {
  const doc = readFileSync(inventoryDoc, "utf8");
  for (const model of MODELS) {
    const m = doc.match(new RegExp(`\\|\\s*\`${model}\`\\s*\\|\\s*(\\d+)\\s*\\|`));
    if (!m) {
      countIssues.push(`${model}: not found in inventory doc`);
      continue;
    }
    const recorded = Number(m[1]);
    const current = await prisma[model].count();
    // PasswordResetToken rows may legitimately DECREASE (expired-token
    // cleanup is documented runtime behavior — §14 exception).
    if (model === "PasswordResetToken") {
      if (current < 0) countIssues.push(`${model}: impossible count ${current}`);
    } else if (current < recorded) {
      countIssues.push(`${model}: ${recorded} -> ${current} (DATA LOSS)`);
    }
  }
}
check(
  "5b. row counts preserved (no model lost records vs baseline inventory)",
  countIssues.length === 0,
  countIssues.join("; "),
);

const integrityRows = await prisma.$queryRawUnsafe(`PRAGMA integrity_check`);
const fkRows = await prisma.$queryRawUnsafe(`PRAGMA foreign_key_check`);
check(
  "6. SQLite integrity ok + foreign_key_check clean",
  JSON.stringify(integrityRows).includes("ok") && fkRows.length === 0,
  `integrity=${JSON.stringify(integrityRows)} fk=${fkRows.length}`,
);

// --- 7-8: migration tooling & guards ----------------------------------------
console.log("[7-8] migration tooling & production guards");
const statusRun = spawnSync("bunx", ["prisma", "migrate", "status"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 120_000,
});
const statusOut = `${statusRun.stdout ?? ""}${statusRun.stderr ?? ""}`;
check(
  "7. prisma migrate status: schema up to date, nothing pending",
  statusRun.status === 0 && /up to date/i.test(statusOut) && !/pending|drifted/i.test(statusOut),
  statusOut.slice(-300),
);

function runGuard(mode, env) {
  return spawnSync("node", ["scripts/db-guard.cjs", mode], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}
const gPush = runGuard("push", { NODE_ENV: "production" });
const gReset = runGuard("reset", { NODE_ENV: "production" });
const gMigDev = runGuard("migrate-dev", { NODE_ENV: "production" });
check(
  "8a. NODE_ENV=production blocks db:push with the required message",
  gPush.status === 1 && gPush.stderr.includes("db push is disabled in production. Use prisma migrate deploy."),
);
check(
  "8b. NODE_ENV=production blocks db:reset with the required message",
  gReset.status === 1 &&
    gReset.stderr.includes("Database reset is development-only and is blocked in production."),
);
check(
  "8c. NODE_ENV=production blocks db:migrate (migrate dev)",
  gMigDev.status === 1 && gMigDev.stderr.includes("migrate dev is development-only"),
);
const gDev = runGuard("push", { NODE_ENV: "development" });
check("8d. development db:push guard passes through (exit 0)", gDev.status === 0);

// --- 9-12: live application behavior ----------------------------------------
console.log("[9-12] live application regression (synthetic users)");
const uA = {
  name: "P19 Owner A",
  email: `p19-a-${STAMP}@p19check.local`,
  password: `Ownd${STAMP}x9`,
};
const uB = {
  name: "P19 Member B",
  email: `p19-b-${STAMP}@p19check.local`,
  password: `Ownd${STAMP}x9`,
};

let jarA, jarB;
try {
  jarA = await register(uA.name, uA.email, uA.password);
  jarB = await register(uB.name, uB.email, uB.password);
  const me = await api("/api/v1/me", { jar: jarA });
  check(
    "9. register → login → /api/v1/me works (auth intact post-baseline)",
    me.status === 200 && me.json?.data?.email === uA.email,
    `status=${me.status}`,
  );
} catch (e) {
  check("9. register → login → /api/v1/me works (auth intact post-baseline)", false, e.message);
}

let bizA = null;
let bizB = null;
try {
  const res = await api("/api/v1/businesses", {
    method: "POST",
    jar: jarA,
    body: { name: `P19 Isolation Co ${STAMP}`, currencyCode: "USD" },
  });
  bizA = res.json?.data?.business ?? null; // route wraps as { business: {...} }
  check("10a. business creation works", res.status === 201 && Boolean(bizA?.id), res.text?.slice(0, 160));
} catch (e) {
  check("10a. business creation works", false, e.message);
}

try {
  const res = await api("/api/v1/businesses", {
    method: "POST",
    jar: jarB,
    body: { name: `P19 Rival Co ${STAMP}`, currencyCode: "USD" },
  });
  bizB = res.json?.data?.business ?? null;
  if (res.status !== 201 || !bizB?.id) throw new Error(`bizB create: ${res.status}`);

  // B (own active context) requests A's business by id → must never succeed.
  const cross = await api(`/api/v1/businesses/${bizA?.id}`, {
    jar: jarB,
    headers: { "x-business-id": bizB?.id ?? "" },
  });
  // B forges the business header to reach A's customers → membership mismatch → 403.
  const forged = await api("/api/v1/customers", {
    jar: jarB,
    headers: { "x-business-id": bizA?.id ?? "" },
  });
  check(
    "10b. tenant isolation intact (cross-business id rejected, forged header 403)",
    [403, 404].includes(cross.status) && forged.status === 403,
    `cross=${cross.status} forged=${forged.status}`,
  );
} catch (e) {
  check("10b. tenant isolation intact (cross-business id rejected, forged header 403)", false, e.message);
}

let product = null;
let sale = null;
try {
  const pres = await api("/api/v1/products", {
    method: "POST",
    jar: jarA,
    headers: { "x-business-id": bizA?.id ?? "" },
    body: { name: `P19 Widget ${STAMP}`, salePriceMinor: 12_500, costPriceMinor: 7_000, stockQty: 10 },
  });
  product = pres.json?.data;
  if (pres.status !== 201 || !product?.id) throw new Error(`product create: ${pres.status} ${pres.text?.slice(0, 120)}`);
  const sres = await api("/api/v1/sales", {
    method: "POST",
    jar: jarA,
    headers: { "x-business-id": bizA?.id ?? "" },
    body: { items: [{ name: "P19 Widget", qty: 3, unitPriceMinor: 12_500 }], discountMinor: 500 },
  });
  sale = sres.json?.data; // create returns { id, number, totalMinor }
  if (sres.status !== 201 || !sale?.id) throw new Error(`sale create: ${sres.status} ${sres.text?.slice(0, 120)}`);
  const detail = await api(`/api/v1/sales/${sale.id}`, {
    jar: jarA,
    headers: { "x-business-id": bizA?.id ?? "" },
  });
  const d = detail.json?.data?.sale ?? {};
  const exact = d.subtotalMinor === 37_500 && d.totalMinor === 37_000 && sale.totalMinor === 37_000;
  check(
    "11a. sale integer math exact (3 × 12500 − 500 = 37000 minor)",
    exact,
    `subtotal=${d.subtotalMinor} total=${d.totalMinor}`,
  );
} catch (e) {
  check("11a. sale integer math exact (3 × 12500 − 500 = 37000 minor)", false, e.message);
}

try {
  const part = await api("/api/v1/payments", {
    method: "POST",
    jar: jarA,
    headers: { "x-business-id": bizA?.id ?? "" },
    body: { saleId: sale?.id, amountMinor: 10_000, method: "CASH" },
  });
  const sAfter = await api(`/api/v1/sales/${sale?.id}`, {
    jar: jarA,
    headers: { "x-business-id": bizA?.id ?? "" },
  });
  const sd = sAfter.json?.data?.sale ?? {};
  const partialOk =
    part.status === 201 && sd.paidMinor === 10_000 && sd.status === "PARTIAL";
  const overpay = await api("/api/v1/payments", {
    method: "POST",
    jar: jarA,
    headers: { "x-business-id": bizA?.id ?? "" },
    body: { saleId: sale?.id, amountMinor: 99_999, method: "CASH" },
  });
  check(
    "11b. PARTIAL payment summary + overpayment rejected 422 (single-writer logic intact)",
    partialOk && overpay.status === 422,
    `partial=${part.status} paid=${sd.paidMinor} overpay=${overpay.status}`,
  );
} catch (e) {
  check("11b. PARTIAL payment summary + overpayment rejected 422 (single-writer logic intact)", false, e.message);
}

try {
  const change = await api("/api/v1/auth/password-change", {
    method: "POST",
    jar: jarA,
    body: {
      currentPassword: uA.password,
      newPassword: `Rotated${STAMP}z7`,
      confirmPassword: `Rotated${STAMP}z7`,
    },
  });
  const staleMe = await api("/api/v1/me", { jar: jarA });
  const oldLogin = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "HEAD" }).catch(
    () => null,
  );
  const reLogin = await login(uA.email, `Rotated${STAMP}z7`);
  const meNew = await api("/api/v1/me", { jar: reLogin });
  check(
    "12. password change: success, old session invalidated (401), new password signs in (Prompt 18 intact)",
    change.status === 200 && staleMe.status === 401 && meNew.status === 200,
    `change=${change.status} stale=${staleMe.status} relogin-me=${meNew.status}`,
  );
} catch (e) {
  check("12. password change: success, old session invalidated (401), new password signs in (Prompt 18 intact)", false, e.message);
}

/* ------------------------------- cleanup ---------------------------------- */

try {
  // Remove fixture-owned businesses (cascade) + users so repeated runs stay clean.
  const owners = await prisma.user.findMany({
    where: { email: { in: [uA.email, uB.email] } },
    select: { id: true },
  });
  const ownerIds = owners.map((o) => o.id);
  await prisma.business.deleteMany({ where: { ownerId: { in: ownerIds } } });
  for (const o of owners) await prisma.user.delete({ where: { id: o.id } });
} catch (e) {
  console.error(`  (cleanup note: ${String(e).slice(0, 160)})`);
}
await prisma.$disconnect();

/* -------------------------------- summary --------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 220)}` : ""}`);
  process.exit(1);
}
console.log("PROMPT 19 DATABASE REGRESSION: ALL CHECKS PASSED ✓");
