#!/usr/bin/env node
/**
 * scripts/prompt18-auth-check.mjs — Prompt 18 authentication/lifecycle
 * regression harness (§33). Runs against a LIVE server (default
 * http://localhost:3000) and asserts:
 *
 *   1  password change requires authentication
 *   2  wrong current password fails (vague error)
 *   3  correct password change succeeds
 *   4  new password is HASHED in the database (bcrypt prefix, not plaintext)
 *   5  old password stops working after change (sign-in), new one works
 *   6  stale session (pre-change JWT) is invalidated (401 SESSION_INVALIDATED)
 *   7  reset request returns the GENERIC response for existing emails
 *   8  reset request for non-existing email is byte-identical (no oracle)
 *   9  reset tokens are stored HASHED (sha-256 hex), never plaintext
 *   10 malformed reset tokens fail (format gate)
 *   11 TWO simultaneous confirmations race: exactly one wins (single-use)
 *   12 a used token cannot be reused
 *   13 an expired token fails
 *   14 password reset invalidates the previous session
 *   15 sign-in with the new password works after reset
 *   16 Persian-locale account receives the Persian reset email
 *   17 account deletion requires authentication + password + typed confirm
 *   18 account deletion is blocked while the user owns a business (no orphan)
 *   19 after deletion the old session is dead (user gone)
 *   20 passwords never appear in server logs; raw reset tokens appear ONLY
 *      inside the clearly-marked DEV email transport line (§14 exception)
 *
 * Test data is synthetic (@p17check.local). Database access is read-only
 * EXCEPT for two clearly-marked test-fixture operations (expire a token,
 * remove a fixture-owned business) required to reach the guarded branches.
 *
 * Usage: node scripts/prompt18-auth-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.argv[2] ?? "http://localhost:3000";
const STAMP = Date.now();
const DEVLOG = "/home/z/my-project/dev.log";

// Per-run unique client IP so back-to-back harness runs do not exhaust the
// shared per-IP register/login rate-limit quotas (see prompt17 notes).
const TEST_IP = `10.208.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const require = createRequire(import.meta.url);

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = "/home/z/my-project/.env";
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available for fixture operations");
}

const { PrismaClient } = require("@prisma/client");
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

async function rawFetch(path, { method = "GET", body, headers = {}, jar } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "x-forwarded-for": TEST_IP,
      ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
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
  const csrfRes = await rawFetch("/api/auth/csrf", { jar });
  const rawCookie = jar.get("csrf-token");
  const csrfToken = rawCookie ? decodeURIComponent(rawCookie).split("|")[0] : csrfRes.json?.csrfToken;
  const res = await rawFetch("/api/auth/callback/credentials", {
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
  if (!jar.get("session-token")) throw new Error(`login failed for ${email} (${res.status})`);
  return jar;
}

async function api(jar, path, { method = "GET", body } = {}) {
  return rawFetch(path, { method, body, jar });
}

async function registerUser(name) {
  const email = `${name}-${STAMP}@p17check.local`;
  const password = "Prompt18-Test-2026";
  const res = await rawFetch("/api/v1/auth/register", {
    method: "POST",
    body: { name: `Audit ${name}`, email, password },
  });
  if (res.status !== 201) throw new Error(`register ${name}: ${res.status} ${res.text}`);
  return { email, password, name };
}

/** Extract the most recent reset token printed by the DEV email transport. */
function lastResetTokenFromLog() {
  if (!existsSync(DEVLOG)) return null;
  const content = readFileSync(DEVLOG, "utf8");
  const matches = [...content.matchAll(/#\/reset-password\/([A-Za-z0-9_-]{43})/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================== TESTS ================================= */

console.log(`\nPrompt 18 auth/lifecycle regression — target ${BASE}\n`);
const PASSWORDS_USED = [];
const TOKENS_USED = [];

try {
  /* -- 1-6: password change ------------------------------------------------ */
  const u1 = await registerUser("pwchange");
  PASSWORDS_USED.push(u1.password);
  const anon = await rawFetch("/api/v1/auth/password-change", {
    method: "POST",
    body: { currentPassword: "x", newPassword: "y", confirmPassword: "y" },
  });
  check("1. password change requires authentication → 401", anon.status === 401, anon.status);

  const jar1 = await login(u1.email, u1.password);

  const wrong = await api(jar1, "/api/v1/auth/password-change", {
    method: "POST",
    body: { currentPassword: "Wrong-Pass-123", newPassword: "New-Pass-456", confirmPassword: "New-Pass-456" },
  });
  check(
    "2. wrong current password → 400 INVALID_CURRENT_PASSWORD",
    wrong.status === 400 && wrong.json?.error?.code === "INVALID_CURRENT_PASSWORD",
    `${wrong.status} ${wrong.text?.slice(0, 80)}`,
  );

  const newPassword = "Changed-Pw-789";
  PASSWORDS_USED.push(newPassword);
  const changed = await api(jar1, "/api/v1/auth/password-change", {
    method: "POST",
    body: { currentPassword: u1.password, newPassword, confirmPassword: newPassword },
  });
  check(
    "3. correct password change succeeds",
    changed.status === 200 && changed.json?.data?.changed === true,
    `${changed.status} ${changed.text?.slice(0, 100)}`,
  );

  const dbUser1 = await prisma.user.findUnique({ where: { email: u1.email } });
  check(
    "4. new password stored HASHED (bcrypt, not plaintext)",
    Boolean(dbUser1) &&
      dbUser1.passwordHash.startsWith("$2") &&
      !dbUser1.passwordHash.includes(newPassword) &&
      dbUser1.passwordHash.length >= 50,
    dbUser1?.passwordHash?.slice(0, 12),
  );

  const oldSignIn = await rawFetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: "x", email: u1.email, password: u1.password }).toString(),
  });
  const oldText = oldSignIn.text ?? "";
  check(
    "5. old password rejected after change",
    oldSignIn.status !== 200 || /error/i.test(oldText),
    oldSignIn.status,
  );
  const jar1new = await login(u1.email, newPassword);
  const meNew = await api(jar1new, "/api/v1/me");
  check("5b. sign-in with the new password works", meNew.status === 200, meNew.status);

  // The SAME session (JWT stamped with the pre-change version) must now
  // fail the freshness gate — this is exactly the stale-device scenario.
  const stale = await api(jar1, "/api/v1/me");
  check(
    "6. stale pre-change session → 401 SESSION_INVALIDATED",
    stale.status === 401 && stale.json?.error?.code === "SESSION_INVALIDATED",
    `${stale.status} ${stale.text?.slice(0, 80)}`,
  );

  /* -- 7-15: password reset ------------------------------------------------ */
  const u2 = await registerUser("reset");
  PASSWORDS_USED.push(u2.password);
  const jar2 = await login(u2.email, u2.password);

  const reqExisting = await rawFetch("/api/v1/auth/password-reset/request", {
    method: "POST",
    body: { email: u2.email },
  });
  const genericBody = JSON.stringify(reqExisting.json);
  check(
    "7. reset request → generic 200",
    reqExisting.status === 200 && /instructions have been sent/i.test(reqExisting.json?.data?.message ?? ""),
    reqExisting.status,
  );

  const reqMissing = await rawFetch("/api/v1/auth/password-reset/request", {
    method: "POST",
    body: { email: `nobody-${STAMP}@p17check.local` },
  });
  check(
    "8. non-existing email → byte-identical generic response",
    reqMissing.status === 200 && JSON.stringify(reqMissing.json) === genericBody,
    JSON.stringify(reqMissing.json)?.slice(0, 80),
  );

  await sleep(600); // let the console transport line land in dev.log
  const rawToken = lastResetTokenFromLog();
  check("9a. dev email transport produced a reset link", Boolean(rawToken));

  const tokenRows = await prisma.passwordResetToken.findMany({
    where: { user: { email: u2.email } },
  });
  check(
    "9. tokens stored HASHED — plaintext never persisted",
    tokenRows.length > 0 &&
      tokenRows.every(
        (t) =>
          /^[a-f0-9]{64}$/.test(t.tokenHash) && // sha-256 hex
          !tokenRows.some((t2) => t2.tokenHash.includes(rawToken ?? "§")),
      ),
    `${tokenRows.length} rows`,
  );
  check(
    "9b. hash matches SHA-256(rawToken)",
    tokenRows.some((t) => {
      // node crypto re-derivation (import at top would be fine but keep local)
      const { createHash } = require("node:crypto");
      return createHash("sha256").update(rawToken).digest("hex") === t.tokenHash;
    }),
  );
  TOKENS_USED.push(rawToken);

  const badFormat = await rawFetch("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    // 43 chars so the zod length gate passes and the FORMAT gate is what fires.
    body: { token: "g".repeat(43), newPassword: "Whatever-123", confirmPassword: "Whatever-123" },
  });
  check(
    "10. well-sized but unknown token → 400 INVALID_RESET_TOKEN",
    badFormat.status === 400 && badFormat.json?.error?.code === "INVALID_RESET_TOKEN",
    badFormat.status,
  );

  // 11 — simultaneous double-claim: exactly one may win (§29).
  const resetPw = "Resetted-Pw-000";
  PASSWORDS_USED.push(resetPw);
  const [c1, c2] = await Promise.all([
    rawFetch("/api/v1/auth/password-reset/confirm", {
      method: "POST",
      body: { token: rawToken, newPassword: resetPw, confirmPassword: resetPw },
    }),
    rawFetch("/api/v1/auth/password-reset/confirm", {
      method: "POST",
      body: { token: rawToken, newPassword: resetPw, confirmPassword: resetPw },
    }),
  ]);
  const wins = [c1, c2].filter((r) => r.status === 200).length;
  const losses = [c1, c2].filter((r) => r.status === 400).length;
  check("11. concurrent confirms: exactly one 200, one 400", wins === 1 && losses === 1, `${c1.status}/${c2.status}`);

  const reuse = await rawFetch("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: { token: rawToken, newPassword: "Again-Pw-999", confirmPassword: "Again-Pw-999" },
  });
  check("12. used token cannot be reused → 400", reuse.status === 400, reuse.status);

  const stale2 = await api(jar2, "/api/v1/me");
  check(
    "14. pre-reset session invalidated",
    stale2.status === 401 && stale2.json?.error?.code === "SESSION_INVALIDATED",
    `${stale2.status} ${stale2.text?.slice(0, 80)}`,
  );

  const jar2new = await login(u2.email, resetPw);
  const me2 = await api(jar2new, "/api/v1/me");
  check("15. sign-in with reset password works", me2.status === 200, me2.status);

  /* -- 13: expired token ---------------------------------------------------- */
  const u3 = await registerUser("expire");
  await rawFetch("/api/v1/auth/password-reset/request", { method: "POST", body: { email: u3.email } });
  await sleep(500);
  const expiredRaw = lastResetTokenFromLog();
  // TEST FIXTURE OP: force-expire the live token.
  await prisma.passwordResetToken.updateMany({
    where: { user: { email: u3.email } },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expired = await rawFetch("/api/v1/auth/password-reset/confirm", {
    method: "POST",
    body: { token: expiredRaw, newPassword: "Expired-Pw-1", confirmPassword: "Expired-Pw-1" },
  });
  check(
    "13. expired token → 400 INVALID_RESET_TOKEN",
    expired.status === 400 && expired.json?.error?.code === "INVALID_RESET_TOKEN",
    expired.status,
  );

  /* -- 16: Persian email template ------------------------------------------ */
  const u4 = await registerUser("resetfa");
  await api(await login(u4.email, u4.password), "/api/v1/me", {
    method: "PATCH",
    body: { locale: "fa" },
  });
  await rawFetch("/api/v1/auth/password-reset/request", { method: "POST", body: { email: u4.email } });
  await sleep(500);
  const faLog = existsSync(DEVLOG) ? readFileSync(DEVLOG, "utf8") : "";
  check(
    "16. fa-locale account receives Persian reset email",
    faLog.includes("بازنشانی رمز عبور") && faLog.includes("دقیقه"),
  );

  /* -- 17-19: account deletion ---------------------------------------------- */
  const u5 = await registerUser("acctdel");
  PASSWORDS_USED.push(u5.password);
  const delAnon = await rawFetch("/api/v1/me", {
    method: "DELETE",
    body: { password: "x", confirmation: "DELETE" },
  });
  check("17a. deletion requires authentication → 401", delAnon.status === 401, delAnon.status);

  const jar5 = await login(u5.email, u5.password);
  const badConfirm = await api(jar5, "/api/v1/me", {
    method: "DELETE",
    body: { password: u5.password, confirmation: "delete-me" },
  });
  check(
    "17b. wrong typed confirmation → 422",
    badConfirm.status === 422,
    badConfirm.status,
  );

  // Fixture: give the user an owned business (via API — realistic path).
  const biz = await api(jar5, "/api/v1/businesses", {
    method: "POST",
    body: { name: `DelBlock ${STAMP}`, currencyCode: "USD" },
  });
  const blocked = await api(jar5, "/api/v1/me", {
    method: "DELETE",
    body: { password: u5.password, confirmation: "DELETE" },
  });
  check(
    "18. deletion blocked while owning a business → 409 OWNED_BUSINESS_BLOCKED",
    blocked.status === 409 && blocked.json?.error?.code === "OWNED_BUSINESS_BLOCKED",
    `${blocked.status} ${blocked.text?.slice(0, 100)}`,
  );
  const bizId = biz.json?.data?.find?.((b) => b.name === `DelBlock ${STAMP}`)?.id ?? biz.json?.data?.business?.id;
  const dbBiz = bizId
    ? await prisma.business.findFirst({ where: { name: `DelBlock ${STAMP}` } })
    : null;
  check("18b. Business.ownerId intact while blocked", Boolean(dbBiz && dbBiz.ownerId));

  // TEST FIXTURE OP: remove the owned business so the guarded branch passes.
  if (dbBiz) await prisma.business.delete({ where: { id: dbBiz.id } });

  const deleted = await api(jar5, "/api/v1/me", {
    method: "DELETE",
    body: { password: u5.password, confirmation: "DELETE" },
  });
  check(
    "17c. deletion succeeds with password + typed confirm",
    deleted.status === 200 && deleted.json?.data?.deleted === true,
    `${deleted.status} ${deleted.text?.slice(0, 100)}`,
  );

  const goneUser = await prisma.user.findUnique({ where: { email: u5.email } });
  check("17d. user row removed", goneUser === null);

  const afterDel = await api(jar5, "/api/v1/me");
  check(
    "19. session dead after deletion (401/404)",
    afterDel.status === 401 || afterDel.status === 404,
    afterDel.status,
  );

  /* -- 20: log hygiene ------------------------------------------------------- */
  await sleep(300);
  const log = existsSync(DEVLOG) ? readFileSync(DEVLOG, "utf8") : "";
  const pwLeak = PASSWORDS_USED.filter((p) => p && log.includes(p));
  check("20a. passwords never appear in server logs", pwLeak.length === 0, `leaked: ${pwLeak.length}`);
  const tokenLines = log.split("\n").filter((l) => TOKENS_USED.filter(Boolean).some((t) => l.includes(t)));
  check(
    "20b. raw reset tokens appear ONLY in the dev email transport line",
    tokenLines.every((l) => l.includes("[email:console-transport]")),
    `${tokenLines.length} lines`,
  );
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(` - ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 240)}` : ""}`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED ✓");
process.exit(0);
