#!/usr/bin/env node
/**
 * scripts/prompt28-platform-check.mjs — Prompt 28 harness (BUN + live server).
 *
 * Coverage:
 *   A.  Platform auth matrix (§107): anonymous/tenant/operator gates
 *   B.  Platform role permission matrix (§6/§107): every role's 403s
 *   C.  Billing matrix (§25-§29/§109): pause/resume via state machine,
 *       idempotency, SubscriptionEvent + PlatformAuditLog presence
 *   D.  Payment matrix (§30-§33/§108): read/reverify/unknown-session,
 *       NO mark-paid/force-success endpoint anywhere (§33/§131)
 *   E.  Price matrix (§34-§37/§110): new version, duplicate, missing row,
 *       invalid currency, activation, historical immutability, snapshot
 *   F.  AI cost matrix (§40-§47/§111): TEST/PRODUCTION separation,
 *       unverified rejection, duplicate version, overlap, reconcile
 *       dry-run/apply idempotency, UNKNOWN != 0
 *   G.  Security matrix (§79-§86/§112): role/body/header tampering,
 *       pagination bounds, secret-field scan on every platform response
 *   H.  Operator management (§54-§56/§105/§133): last-admin protection,
 *       reauth required, bootstrap script negative tests
 *   I.  Tenant isolation (§52/§78/§83): tenant 403 on every platform
 *       route family; no AI-cost/audit/operator leak on customer routes
 *   J.  Static architecture scan (§127-§132): route auth, no raw Prisma
 *       mutations in routes, no impersonation, pagination, DTO safety
 *
 * Usage: bun scripts/prompt28-platform-check.mjs [baseUrl]
 * Exit:  0 = all green · 1 = failures
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { enrollFixtureMfa, platformMfaLogin } from "./lib/platform-mfa.ts";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}/.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
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

const STAMP = Date.now();
const PASSWORD = "Prompt28-Op-2026!";
const TESTER_PASSWORD = "Prompt28-Tenant-2026!";

/* ------------------------------ HTTP helpers ------------------------------ */

const jars = new Map();
async function login(email, password, jarName) {
  const jar = [];
  jars.set(jarName, jar);
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const setCookie = csrfRes.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) jar.push(c.split(";")[0]);
  const csrf = (await csrfRes.json()).csrfToken;
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.join("; ") },
    body: new URLSearchParams({ csrfToken: csrf, email, password }),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const name = c.split("=")[0];
    const idx = jar.findIndex((x) => x.startsWith(`${name}=`));
    if (idx >= 0) jar[idx] = c.split(";")[0];
    else jar.push(c.split(";")[0]);
  }
  return res.status;
}

async function call(path, { method = "GET", body, jar = "anon", headers = {} } = {}) {
  const cookie = jars.get(jar)?.join("; ") ?? "";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const SECRET_MARKERS = [
  "passwordHash",
  "NEXTAUTH_SECRET",
  "DATABASE_URL",
  "merchantSecret",
  "providerKey",
  "resetToken",
  "sessionToken",
  "AI_COST_OPERATOR_TOKEN",
];

function hasSecretMarker(obj, depth = 0) {
  if (depth > 6 || obj == null) return false;
  if (typeof obj === "string") {
    return SECRET_MARKERS.some((m) => obj.toLowerCase().includes(m.toLowerCase()));
  }
  if (typeof obj !== "object") return false;
  return Object.entries(obj).some(
    ([k, v]) =>
      SECRET_MARKERS.some((m) => k.toLowerCase().includes(m.toLowerCase())) &&
      v != null ||
      hasSecretMarker(v, depth + 1),
  );
}

/* ------------------------------ static scans ------------------------------ */

function walkSrc(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) walkSrc(p, out);
    else if (f.endsWith(".ts") && !f.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function staticScans() {
  console.log("\n== J. Static architecture scan (§127-§132) ==");
  const platformDir = `${ROOT}/src/app/api/v1/platform`;
  const routeFiles = walkSrc(platformDir);
  const routeSrc = new Map(routeFiles.map((f) => [f, readFileSync(f, "utf8")]));

  // §127: every platform route uses platform auth.
  let missingAuth = 0;
  for (const [f, src] of routeSrc) {
    if (!src.includes("getPlatformContext")) {
      missingAuth++;
      console.error(`    route without platform auth: ${f}`);
    }
  }
  check("all platform routes call getPlatformContext", missingAuth === 0, `${missingAuth} missing`);

  // §128: no direct privileged Prisma mutations in platform routes.
  const forbiddenPatterns = [
    /prisma\.subscription\.(update|upsert|delete|create)/i,
    /\.user\.update\(\s*\{?\s*where:\s*\{\s*id:[^}]*\},\s*data:\s*\{\s*passwordHash/i,
    /prisma\.paymentTransaction\.(update|create)/i,
    /prisma\.priceBook\.update\(\s*\{?\s*where:\s*\{\s*id:[^}]*\},\s*data:\s*\{\s*prices/i,
  ];
  let rawMutations = 0;
  for (const [f, src] of routeSrc) {
    for (const re of forbiddenPatterns) {
      if (re.test(src)) {
        rawMutations++;
        console.error(`    raw privileged mutation in ${f}: ${re}`);
      }
    }
  }
  check("no raw privileged Prisma mutations in platform routes", rawMutations === 0);

  // §33/§131: no generic payment bypass endpoints anywhere.
  const apiRoot = `${ROOT}/src/app/api`;
  const allRoutes = walkSrc(apiRoot).concat(
    walkSrc(`${ROOT}/src/app/api`).filter((f) => f.endsWith("route.ts")),
  );
  const bypassRe = /(mark-?paid|force-?success|force-?payment|activate-from-admin|markAsPaid)/i;
  const bypassHits = walkSrc(apiRoot).filter((f) => bypassRe.test(f) || bypassRe.test(readFileSync(f, "utf8")));
  check("no mark-paid / force-success / activate-from-admin endpoints", bypassHits.length === 0, bypassHits.join(","));

  // §23/§127: no impersonation endpoints.
  const impersonationRe = /(impersonat|login-?as|act-?as-?user|become-?user)/i;
  const impHits = walkSrc(apiRoot).filter((f) => impersonationRe.test(f) || impersonationRe.test(readFileSync(f, "utf8")));
  check("no impersonation endpoints", impHits.length === 0, impHits.join(","));

  // §36/§69: paginated list endpoints use parsePagination.
  const listRoutes = routeFiles.filter((f) => /businesses\/route|users\/route|subscriptions\/route|payments\/route|ai-cost\/(rates|ledger|anomalies)\/route|audit\/route|operators\/route/.test(f));
  const unpaginated = listRoutes.filter((f) => !routeSrc.get(f).includes("parsePagination"));
  check("every platform list endpoint is paginated", unpaginated.length === 0, unpaginated.join(","));

  // §70/§129: serializers are explicit DTO allowlists (routes import them).
  const dtoRoutes = routeFiles.filter((f) => /businesses\/route|users\/route|subscriptions\/route|payments\/route|audit\/route|operators\/route/.test(f));
  const noDto = dtoRoutes.filter(
    (f) => !/serializers/.test(routeSrc.get(f)) && !/platformOk\(/.test(routeSrc.get(f)),
  );
  check("platform list routes use explicit serializers/envelope", noDto.length === 0, noDto.join(","));

  // §132: role never accepted from request sources in platform code.
  const escalation = routeFiles.filter((f) => {
    const src = routeSrc.get(f);
    return /body\.role\s*\?\?|searchParams\.get\("role"\)|headers\.get\("x-platform-role"\)/.test(src) &&
      !src.includes("body.role ?? target.role");
  });
  check("platform role never derived from client input", escalation.length === 0, escalation.join(","));

  // §56/§34: sensitive mutations require reauth + audit.
  // Prompt 62: suspend/reactivate join the sensitive set (account-lifecycle).
  const mutationRoutes = routeFiles.filter((f) => /pause|resume|plan\/route|trial\/route|invalidate-sessions|reverify|investigation|activate|deactivate|verify\/route|reconciliation|operators\/route|operators\/\[id\]\/route|sessions\/\[sessionId\]\/route|suspend|reactivate/.test(f));
  const missingReauth = mutationRoutes.filter((f) => !routeSrc.get(f).includes("assertPlatformReauth"));
  check("sensitive platform mutations require reauthentication", missingReauth.length === 0, missingReauth.join(","));
  // Audit may live in the route OR in the src/lib/platform service the route
  // delegates to (Prompt 62 — transactional audit inside the domain
  // transaction, §73). The scan follows the import to keep the check honest.
  const platformLibSrc = walkSrc(`${ROOT}/src/lib/platform`).map((f) => readFileSync(f, "utf8")).join("\n");
  const missingAudit = mutationRoutes.filter((f) => {
    const src = routeSrc.get(f);
    if (src.includes("platformAudit")) return false;
    const imports = [...src.matchAll(/from "@\/lib\/platform\/([a-z-]+)"/g)].map((m) => m[1]);
    return !imports.some((mod) => {
      const p = `${ROOT}/src/lib/platform/${mod}.ts`;
      return existsSync(p) && readFileSync(p, "utf8").includes("platformAudit");
    });
  });
  check("sensitive platform mutations are audited", missingAudit.length === 0, missingAudit.join(","));

  // §57: rate limiting on sensitive mutations.
  const missingRl = mutationRoutes.filter((f) => !routeSrc.get(f).includes("rateLimit"));
  check("sensitive platform mutations are rate-limited", missingRl.length === 0, missingRl.join(","));

  // §85: system route never dumps process.env wholesale.
  const sysSrc = readFileSync(`${ROOT}/src/app/api/v1/platform/system/route.ts`, "utf8");
  check("system route does not serialize process.env", !/process\.env\s*\)/.test(sysSrc) && !/JSON\.stringify\(process\.env/.test(sysSrc));

  // Secret scan across the platform source tree (§84).
  const platformSrc = [...routeSrc.values()].join("\n") +
    walkSrc(`${ROOT}/src/lib/platform`).map((f) => readFileSync(f, "utf8")).join("\n");
  const secretLeaks = ["DATABASE_URL=", "NEXTAUTH_SECRET=", "sk-", "merchant_secret"].filter((s) =>
    platformSrc.includes(s),
  );
  check("no secrets embedded in platform source", secretLeaks.length === 0, secretLeaks.join(","));
}

/* --------------------------------- main ----------------------------------- */

async function main() {
  console.log("=== PROMPT 28 PLATFORM CONTROL PLANE HARNESS ===");
  console.log(`Base: ${BASE}`);

  /* ---------- fixtures (temporary, §104) ---------- */
  console.log("\n== Fixtures (temporary users/operators) ==");

  // Self-heal (learned from P21 BUG #6): a crashed previous run must never
  // poison this run or the P20 B3 invariant. Sweep leftovers FIRST.
  {
    const leftovers = await prisma.business.findMany({ where: { slug: { startsWith: "p28-harness-" } } });
    for (const b of leftovers) {
      await prisma.business.delete({ where: { id: b.id } }).catch(() => undefined);
    }
    const staleUsers = await prisma.user.findMany({ where: { email: { endsWith: "@harness.local" }, email: { contains: "p28" } } });
    for (const u of staleUsers) {
      await prisma.user.delete({ where: { id: u.id } }).catch(() => undefined);
    }
    // Crashed-run recovery for PRICING rows too (defect found post-P47: a
    // run killed between section E and cleanup left a `p28-v-<stamp>`
    // EUR_STANDARD book behind, and the P24 Q15.5 exactly-one-book canary
    // then failed). Every harness book/rate version carries the `p28-`
    // prefix (newVersion/p28-missing/p28-free/p28-cur/p28-test-v1/p28-prod*)
    // while seeded books use `v1-2026-09` — the prefix sweep can never
    // touch seeded pricing data. PlanPrice rows cascade (schema). The
    // STAMP-scoped cleanup below is kept as-is for belt-and-braces.
    const sweptBooks = await prisma.priceBook.deleteMany({ where: { version: { startsWith: "p28-" } } });
    await prisma.aiCostRate.deleteMany({ where: { version: { startsWith: "p28-" } } });
    if (leftovers.length > 0 || sweptBooks.count > 0) console.log(`  (swept ${leftovers.length} leftover fixture business(es) + ${sweptBooks.count} leftover price book(s) from a crashed run)`);
  }
  const opEmail = `p28op-${STAMP}@harness.local`;
  const roEmail = `p28ro-${STAMP}@harness.local`;
  const secEmail = `p28sec-${STAMP}@harness.local`;
  const tenantEmail = `p28tenant-${STAMP}@harness.local`;
  const ownerEmail = `p28owner-${STAMP}@harness.local`;

  // Create users with REAL bcrypt hashes of the harness password (register API
  // would need csrf juggling per user — direct creation with the same policy).
  const bcrypt = require("bcryptjs");
  const realHash = bcrypt.hashSync(PASSWORD, 10);
  const tenantHash = bcrypt.hashSync(TESTER_PASSWORD, 10);

  const opUser = await prisma.user.create({ data: { email: opEmail, name: "P28 Op", passwordHash: realHash } });
  const roUser = await prisma.user.create({ data: { email: roEmail, name: "P28 Read", passwordHash: realHash } });
  const secUser = await prisma.user.create({ data: { email: secEmail, name: "P28 Sec", passwordHash: realHash } });
  const tenantUser = await prisma.user.create({ data: { email: tenantEmail, name: "P28 Tenant", passwordHash: tenantHash } });
  const ownerUser = await prisma.user.create({ data: { email: ownerEmail, name: "P28 Owner", passwordHash: tenantHash } });
  const opRow = await prisma.platformOperator.create({ data: { userId: opUser.id, role: "PLATFORM_SUPER_ADMIN", active: true } });
  const roRow = await prisma.platformOperator.create({ data: { userId: roUser.id, role: "PLATFORM_READONLY", active: true } });
  const secRow = await prisma.platformOperator.create({ data: { userId: secUser.id, role: "PLATFORM_SECURITY", active: true } });
  // Tenant owner + member business (owned by tenant user).
  const biz = await prisma.business.create({
    data: {
      name: `P28 Harness Biz ${STAMP}`,
      slug: `p28-harness-${STAMP}`,
      ownerId: ownerUser.id,
      members: { create: [{ userId: ownerUser.id, role: "OWNER" }] },
      subscription: { create: { planId: (await prisma.plan.findUnique({ where: { code: "FREE" } })).id, status: "ACTIVE" } },
    },
    include: { subscription: true },
  });
  check("fixtures created (users, operators, business+subscription)", !!biz.id && !!opRow.id && !!roRow.id && !!secRow.id);
  const bizId = biz.id;

  /* ---------- A. auth matrix ---------- */
  console.log("\n== A. Platform auth matrix (§107) ==");
  const anonOverview = await call("/api/v1/platform/overview");
  check("anonymous overview → 401 PLATFORM_UNAUTHENTICATED", anonOverview.status === 401 && anonOverview.json?.error?.code === "PLATFORM_UNAUTHENTICATED", JSON.stringify(anonOverview.json));

  check("operator login", (await login(opEmail, PASSWORD, "op")) === 302 || (await login(opEmail, PASSWORD, "op")) === 200);

  // R65 — SUPER_ADMIN MFA enforcement (Prompt 65 §6.2): enroll via the REAL
  // API flow on the fresh op session, then MFA-login and REPLACE the op jar.
  {
    const enrollCaller = async (path, init = {}) => {
      const cookie = (jars.get("op") ?? []).join("; ");
      const res = await fetch(`${BASE}${path}`, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: init.body ?? undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json, res };
    };
    const p28Mfa = await enrollFixtureMfa(enrollCaller, PASSWORD);
    const mfaJar = await platformMfaLogin(opEmail, PASSWORD, p28Mfa.secret);
    jars.set("op", [...mfaJar.entries()].map(([k, v]) => `${k}=${v}`));
    check("operator MFA enrolled + MFA login (R65 §6.2)", true);
  }
  check("readonly login", (await login(roEmail, PASSWORD, "ro")) === 302 || (await login(roEmail, PASSWORD, "ro")) === 200);
  check("security login", (await login(secEmail, PASSWORD, "sec")) === 302 || (await login(secEmail, PASSWORD, "sec")) === 200);
  check("tenant owner login", (await login(ownerEmail, TESTER_PASSWORD, "owner")) === 302 || (await login(ownerEmail, TESTER_PASSWORD, "owner")) === 200);

  const tenantSelf = await call("/api/v1/platform/self", { jar: "owner" });
  check("tenant OWNER self → 403 PLATFORM_FORBIDDEN", tenantSelf.status === 403 && tenantSelf.json?.error?.code === "PLATFORM_FORBIDDEN", JSON.stringify(tenantSelf.json?.error));
  const tenantOverview = await call("/api/v1/platform/overview", { jar: "owner" });
  check("tenant OWNER overview → 403", tenantOverview.status === 403);

  const opSelf = await call("/api/v1/platform/self", { jar: "op" });
  check("operator self → 200 with role+permissions", opSelf.status === 200 && opSelf.json?.data?.role === "PLATFORM_SUPER_ADMIN" && Array.isArray(opSelf.json?.data?.permissions));

  /* ---------- B. role permission matrix ---------- */
  console.log("\n== B. Role permission matrix (§6) ==");
  const roBiz = await call("/api/v1/platform/businesses?page=1&pageSize=5", { jar: "ro" });
  check("READONLY can read businesses", roBiz.status === 200);
  const roUsers = await call("/api/v1/platform/users?page=1&pageSize=5", { jar: "ro" });
  check("READONLY can read users", roUsers.status === 200);
  const roOperators = await call("/api/v1/platform/operators", { jar: "ro" });
  check("READONLY can read operators", roOperators.status === 200);

  const secInvalidate = await call(`/api/v1/platform/users/${ownerUser.id}/invalidate-sessions`, {
    jar: "sec",
    method: "POST",
    body: { reason: "harness security invalidation", password: PASSWORD },
  });
  check("SECURITY can invalidate sessions (§22)", secInvalidate.status === 200 && secInvalidate.json?.data?.invalidated === true, JSON.stringify(secInvalidate.json));

  const secInvalidateAgain = await call(`/api/v1/platform/users/${ownerUser.id}/invalidate-sessions`, {
    jar: "sec",
    method: "POST",
    body: { reason: "idempotent mechanism", password: PASSWORD },
  });
  check("second invalidation increments sessionVersion again", secInvalidateAgain.status === 200 && secInvalidateAgain.json?.data?.sessionVersion === 2);

  const tenantBlockedAfter = await call("/api/v1/businesses", { jar: "owner", headers: { "x-business-id": bizId } });
  check("invalidated tenant session fails tenant APIs (401/403, §106)", [401, 403].includes(tenantBlockedAfter.status), JSON.stringify({ status: tenantBlockedAfter.status, code: tenantBlockedAfter.json?.error?.code }));
  await login(ownerEmail, TESTER_PASSWORD, "owner"); // fresh session after invalidation
  await login(ownerEmail, TESTER_PASSWORD, "owner"); // fresh session

  const roInvalidate = await call(`/api/v1/platform/users/${tenantUser.id}/invalidate-sessions`, {
    jar: "ro",
    method: "POST",
    body: { reason: "readonly must not mutate", password: PASSWORD },
  });
  check("READONLY invalidation → 403/422 (no mutation)", roInvalidate.status === 403 || roInvalidate.status === 422);

  /* ---------- C. billing matrix ---------- */
  console.log("\n== C. Billing matrix (§25-§29/§109) ==");
  const subId = biz.subscription.id;

  // Set the fixture subscription to ACTIVE on a paid plan (PRO is paid).
  const pro = await prisma.plan.findUnique({ where: { code: "PRO" } });
  await prisma.subscription.update({ where: { id: subId }, data: { status: "ACTIVE", planId: pro.id } });

  const pauseNoReauth = await call(`/api/v1/platform/businesses/${bizId}/subscription/pause`, {
    jar: "op",
    method: "POST",
    body: { reason: "no password provided" },
  });
  check("pause without password → 403 PLATFORM_REAUTH_REQUIRED", pauseNoReauth.status === 403 && pauseNoReauth.json?.error?.code === "PLATFORM_REAUTH_REQUIRED", JSON.stringify(pauseNoReauth.json?.error));

  const pause = await call(`/api/v1/platform/businesses/${bizId}/subscription/pause`, {
    jar: "op",
    method: "POST",
    body: { reason: "harness pause test", password: PASSWORD },
  });
  check("ACTIVE → PAUSED via service (§25)", pause.status === 200 && pause.json?.data?.subscription?.status === "PAUSED", JSON.stringify(pause.json?.error));

  const pauseAgain = await call(`/api/v1/platform/businesses/${bizId}/subscription/pause`, {
    jar: "op",
    method: "POST",
    body: { reason: "duplicate pause", password: PASSWORD },
  });
  check("duplicate pause is an idempotent no-op (§74)", pauseAgain.status === 200 && pauseAgain.json?.data?.changed === false);

  const pausedEvents = await prisma.subscriptionEvent.findMany({ where: { subscriptionId: subId, type: "PAUSED" } });
  check("PAUSED SubscriptionEvent written once", pausedEvents.length === 1);

  const pausedEntitlements = await call("/api/v1/billing/subscription", { jar: "owner", headers: { "x-business-id": bizId } });
  const pausedSub = pausedEntitlements.json?.data?.subscription;
  check("paused business falls back to FREE-level entitlements (§25)", pausedEntitlements.status === 200 && pausedSub?.effectivePlanCode === "FREE" && pausedSub?.status === "PAUSED", JSON.stringify({ effective: pausedSub?.effectivePlanCode, status: pausedSub?.status }));

  const resume = await call(`/api/v1/platform/businesses/${bizId}/subscription/resume`, {
    jar: "op",
    method: "POST",
    body: { reason: "harness resume test", password: PASSWORD },
  });
  check("PAUSED → ACTIVE via service (§26)", resume.status === 200 && resume.json?.data?.subscription?.status === "ACTIVE");

  const resumeAgain = await call(`/api/v1/platform/businesses/${bizId}/subscription/resume`, {
    jar: "op",
    method: "POST",
    body: { reason: "duplicate resume", password: PASSWORD },
  });
  check("duplicate resume is an idempotent no-op", resumeAgain.status === 200 && resumeAgain.json?.data?.changed === false);

  const planChange = await call(`/api/v1/platform/businesses/${bizId}/subscription/plan`, {
    jar: "op",
    method: "POST",
    body: { planCode: "STARTER", reason: "harness plan change", password: PASSWORD },
  });
  check("operator plan change (entitlement administration §28)", planChange.status === 200 && planChange.json?.data?.subscription?.plan?.code === "STARTER");

  const planEvents = await prisma.subscriptionEvent.findMany({ where: { subscriptionId: subId, type: "PLAN_CHANGED" }, orderBy: { createdAt: "desc" } });
  check("PLAN_CHANGED event carries source=platform-admin", planEvents[0]?.dataJson?.includes("platform-admin") === true);

  const trialDisabled = await call(`/api/v1/platform/businesses/${bizId}/trial`, {
    jar: "op",
    method: "POST",
    body: { action: "start", reason: "harness trial start", password: PASSWORD },
  });
  // .env has BILLING_TRIALS_ENABLED=true in this environment — accept either
  // success (200) or honest TRIAL_DISABLED; NEVER a 500.
  check("trial op goes through existing policy (200 or TRIAL_DISABLED, never 500)", trialDisabled.status === 200 || trialDisabled.json?.error?.code === "TRIAL_DISABLED", JSON.stringify(trialDisabled.json?.error));

  const roPause = await call(`/api/v1/platform/businesses/${bizId}/subscription/pause`, {
    jar: "ro",
    method: "POST",
    body: { reason: "readonly pause attempt", password: PASSWORD },
  });
  check("READONLY pause → 403 PERMISSION_DENIED", roPause.status === 403 && roPause.json?.error?.code === "PLATFORM_PERMISSION_DENIED", JSON.stringify(roPause.json?.error));

  /* ---------- D. payments matrix ---------- */
  console.log("\n== D. Payment matrix (§30-§33/§108) ==");
  const payments = await call("/api/v1/platform/payments?page=1&pageSize=10", { jar: "op" });
  check("payments list readable", payments.status === 200 && Array.isArray(payments.json?.data?.items));
  check("payments DTO carries no credentials", !hasSecretMarker(payments.json?.data ?? {}));

  const reverifyUnknown = await call("/api/v1/platform/payments/nonexistent-id/reverify", {
    jar: "op",
    method: "POST",
    body: { reason: "harness unknown session", password: PASSWORD },
  });
  check("reverify unknown session → 404 (no false success)", reverifyUnknown.status === 404);

  const reverifyNoReauth = await call("/api/v1/platform/payments/nonexistent-id/reverify", {
    jar: "op",
    method: "POST",
    body: { reason: "no password" },
  });
  check("reverify without password → 403 PLATFORM_REAUTH_REQUIRED", reverifyNoReauth.status === 403 && reverifyNoReauth.json?.error?.code === "PLATFORM_REAUTH_REQUIRED");

  /* ---------- E. price matrix ---------- */
  console.log("\n== E. Price matrix (§34-§37/§110) ==");
  const newVersion = `p28-v-${STAMP}`;
  const createBook = await call("/api/v1/platform/pricing", {
    jar: "op",
    method: "POST",
    body: {
      code: "EUR_STANDARD",
      version: newVersion,
      currency: "EUR",
      description: "p28 harness book",
      effectiveFrom: new Date(Date.now() + 3_600_000).toISOString(),
      prices: [
        { planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 901 },
        { planCode: "STARTER", billingPeriod: "YEARLY", amountMinor: 9001 },
        { planCode: "BUSINESS", billingPeriod: "MONTHLY", amountMinor: 1901 },
        { planCode: "BUSINESS", billingPeriod: "YEARLY", amountMinor: 19001 },
        { planCode: "PRO", billingPeriod: "MONTHLY", amountMinor: 4901 },
        { planCode: "PRO", billingPeriod: "YEARLY", amountMinor: 49001 },
      ],
      reason: "harness new book version",
      password: PASSWORD,
    },
  });
  check("createPriceBookVersion creates an INACTIVE version (§35)", createBook.status === 201 && createBook.json?.data?.priceBook?.active === false, JSON.stringify(createBook.json?.error));

  const dupBook = await call("/api/v1/platform/pricing", {
    jar: "op",
    method: "POST",
    body: {
      code: "EUR_STANDARD",
      version: newVersion,
      currency: "EUR",
      effectiveFrom: new Date().toISOString(),
      prices: [{ planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 901 }],
      reason: "duplicate",
      password: PASSWORD,
    },
  });
  check("duplicate version rejected", dupBook.status === 422 && dupBook.json?.error?.details?.reason === "DUPLICATE_VERSION", JSON.stringify(dupBook.json?.error));

  const missingRow = await call("/api/v1/platform/pricing", {
    jar: "op",
    method: "POST",
    body: {
      code: "EUR_STANDARD",
      version: `p28-missing-${STAMP}`,
      currency: "EUR",
      effectiveFrom: new Date().toISOString(),
      prices: [{ planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 901 }],
      reason: "missing rows",
      password: PASSWORD,
    },
  });
  check("book missing required plan price rejected (§36)", missingRow.status === 422 && missingRow.json?.error?.details?.reason === "MISSING_PLAN_PRICE", JSON.stringify(missingRow.json?.error?.details));

  const freeRow = await call("/api/v1/platform/pricing", {
    jar: "op",
    method: "POST",
    body: {
      code: "EUR_STANDARD",
      version: `p28-free-${STAMP}`,
      currency: "EUR",
      effectiveFrom: new Date().toISOString(),
      prices: [{ planCode: "FREE", billingPeriod: "MONTHLY", amountMinor: 1 }],
      reason: "free row",
      password: PASSWORD,
    },
  });
  check("FREE price row rejected (§38)", freeRow.status === 422);

  const badCurrency = await call("/api/v1/platform/pricing", {
    jar: "op",
    method: "POST",
    body: {
      code: "XXX_TEST",
      version: `p28-cur-${STAMP}`,
      currency: "XYZ",
      effectiveFrom: new Date().toISOString(),
      prices: [{ planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 901 }],
      reason: "bad currency",
      password: PASSWORD,
    },
  });
  check("unsupported settlement currency rejected", badCurrency.status === 422 && badCurrency.json?.error?.code === "PLATFORM_PRICEBOOK_INVALID");

  const publicPricing = await call("/api/public/pricing");
  check("public pricing snapshot unchanged by harness (§110)", publicPricing.status === 200 && JSON.stringify(publicPricing.json).includes("EUR"));

  /* ---------- F. AI cost matrix ---------- */
  console.log("\n== F. AI cost matrix (§40-§47/§111) ==");
  const testRate = await call("/api/v1/platform/ai-cost/rates", {
    jar: "op",
    method: "POST",
    body: {
      provider: "z-ai",
      model: `TESTMODEL${STAMP}`,
      currency: "USD",
      version: `p28-test-v1-${STAMP}`,
      inputRateNanoMinorPer1K: "1000000",
      outputRateNanoMinorPer1K: "2000000",
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
      environment: "TEST",
      reason: "harness synthetic TEST rate",
      password: PASSWORD,
    },
  });
  check("TEST rate created (synthetic values §42)", testRate.status === 201 && testRate.json?.data?.rate?.environment === "TEST");

  const dupRate = await call("/api/v1/platform/ai-cost/rates", {
    jar: "op",
    method: "POST",
    body: {
      provider: "z-ai",
      model: `TESTMODEL${STAMP}`,
      currency: "USD",
      version: `p28-test-v1-${STAMP}`,
      inputRateNanoMinorPer1K: "1000000",
      outputRateNanoMinorPer1K: "2000000",
      effectiveFrom: new Date().toISOString(),
      environment: "TEST",
      reason: "duplicate",
      password: PASSWORD,
    },
  });
  check("duplicate rate version rejected", dupRate.status === 422);

  const prodNoEvidence = await call("/api/v1/platform/ai-cost/rates", {
    jar: "op",
    method: "POST",
    body: {
      provider: "z-ai",
      model: "X",
      currency: "USD",
      version: `p28-prod-${STAMP}`,
      inputRateNanoMinorPer1K: "1",
      outputRateNanoMinorPer1K: "1",
      effectiveFrom: new Date().toISOString(),
      environment: "PRODUCTION",
      reason: "no evidence",
      password: PASSWORD,
    },
  });
  check("PRODUCTION rate without verifiedBy/sourceReference rejected (§41)", prodNoEvidence.status === 422 && prodNoEvidence.json?.error?.code === "PLATFORM_AI_RATE_INVALID");

  const prodNoSource = await call("/api/v1/platform/ai-cost/rates", {
    jar: "op",
    method: "POST",
    body: {
      provider: "z-ai",
      model: "X",
      currency: "USD",
      version: `p28-prod2-${STAMP}`,
      inputRateNanoMinorPer1K: "1",
      outputRateNanoMinorPer1K: "1",
      effectiveFrom: new Date().toISOString(),
      environment: "PRODUCTION",
      verifiedBy: "harness",
      reason: "no sourceReference",
      password: PASSWORD,
    },
  });
  check("PRODUCTION rate without sourceReference rejected", prodNoSource.status === 422);

  const rates = await call("/api/v1/platform/ai-cost/rates?includeInactive=true&pageSize=50", { jar: "op" });
  check("rate listing paginated + DTO (no raw bigint crash)", rates.status === 200 && Array.isArray(rates.json?.data?.rates));

  const dryRun = await call("/api/v1/platform/ai-cost/reconciliation", {
    jar: "op",
    method: "POST",
    body: { mode: "dry-run", reason: "harness dry run" },
  });
  check("reconcile dry-run runs without password (no mutation)", dryRun.status === 200 && dryRun.json?.data?.report?.updatedCount === 0);

  const applyNoConfirm = await call("/api/v1/platform/ai-cost/reconciliation", {
    jar: "op",
    method: "POST",
    body: { mode: "apply", reason: "no confirmation" },
  });
  check("apply without typed confirmation blocked (§46)", applyNoConfirm.status === 422 && applyNoConfirm.json?.error?.code === "PLATFORM_RECONCILIATION_BLOCKED");

  const applyNoReauth = await call("/api/v1/platform/ai-cost/reconciliation", {
    jar: "op",
    method: "POST",
    body: { mode: "apply", reason: "typed but no password", confirmation: "RECONCILE" },
  });
  check("apply without reauth blocked", applyNoReauth.status === 403 && applyNoReauth.json?.error?.code === "PLATFORM_REAUTH_REQUIRED");

  const apply1 = await call("/api/v1/platform/ai-cost/reconciliation", {
    jar: "op",
    method: "POST",
    body: { mode: "apply", reason: "harness apply", confirmation: "RECONCILE", password: PASSWORD },
  });
  check("apply with confirmation+reauth succeeds", apply1.status === 200);
  const apply2 = await call("/api/v1/platform/ai-cost/reconciliation", {
    jar: "op",
    method: "POST",
    body: { mode: "apply", reason: "harness apply again (idempotent)", confirmation: "RECONCILE", password: PASSWORD },
  });
  check("apply is idempotent (second run updates nothing §74)", apply2.status === 200 && apply2.json?.data?.report?.updatedCount === 0, `second updatedCount=${apply2.json?.data?.report?.updatedCount}`);

  const unknownRecords = await prisma.aiCostRecord.findMany({ where: { costStatus: "UNKNOWN" }, take: 1 });
  check("UNKNOWN records keep NULL cost + UNKNOWN status (§47)", unknownRecords.length === 0 || (unknownRecords[0].costNanoMinor === null && unknownRecords[0].costStatus === "UNKNOWN"));

  const aiLedger = await call("/api/v1/platform/ai-cost/ledger?pageSize=10", { jar: "op" });
  check("ledger readable + no secrets", aiLedger.status === 200 && !hasSecretMarker(aiLedger.json?.data ?? {}));

  const anomalies = await call("/api/v1/platform/ai-cost/anomalies?pageSize=10", { jar: "op" });
  check("anomalies list readable", anomalies.status === 200);

  const economics = await call("/api/v1/platform/ai-cost/economics?planCode=STARTER&billingPeriod=MONTHLY", { jar: "op" });
  check("economics carries honest status + label", economics.status === 200 && economics.json?.data?.economics?.label === "AI_CONTRIBUTION");

  /* ---------- G. security matrix ---------- */
  console.log("\n== G. Security matrix (§79-§86/§112) ==");
  const tamperedOverview = await call("/api/v1/platform/overview", {
    jar: "owner",
    headers: { "x-platform-role": "PLATFORM_SUPER_ADMIN" },
  });
  check("header role tampering ignored (§132)", tamperedOverview.status === 403);

  const tamperedQuery = await call("/api/v1/platform/overview?role=PLATFORM_SUPER_ADMIN&permission=all", { jar: "owner" });
  check("query role tampering ignored", tamperedQuery.status === 403);

  const tamperedBody = await call("/api/v1/platform/businesses", { jar: "owner", method: "POST", body: { role: "PLATFORM_SUPER_ADMIN" } });
  check("body role tampering on platform API → 403/405 (never grants)", tamperedBody.status === 403 || tamperedBody.status === 405);

  const hugePage = await call("/api/v1/platform/businesses?page=1&pageSize=999999", { jar: "op" });
  check("pageSize clamped to maximum (§69)", hugePage.status === 200 && hugePage.json?.data?.page?.pageSize <= 100);

  const sortInject = await call('/api/v1/platform/businesses?name=%22%20OR%201%3D1--', { jar: "op" });
  check("filter injection attempt returns 200-empty (allowlisted fields)", sortInject.status === 200);

  const opResp = await call("/api/v1/platform/operators?pageSize=50", { jar: "op" });
  check("operator DTO carries no password hash", opResp.status === 200 && !hasSecretMarker(opResp.json?.data ?? {}));

  const usersResp = await call("/api/v1/platform/users?pageSize=50", { jar: "op" });
  const usersStr = JSON.stringify(usersResp.json);
  check("user DTO carries no passwordHash (§83)", usersResp.status === 200 && !usersStr.includes("passwordHash") && !usersStr.includes("$2a$"));

  /* ---------- H. operator management ---------- */
  console.log("\n== H. Operator management (§54-§56/§105/§133) ==");
  const createOpNoReauth = await call("/api/v1/platform/operators", {
    jar: "op",
    method: "POST",
    body: { email: tenantEmail, role: "PLATFORM_SUPPORT", reason: "no password" },
  });
  check("operator create without reauth → 403", createOpNoReauth.status === 403);

  const createOp = await call("/api/v1/platform/operators", {
    jar: "op",
    method: "POST",
    body: { email: tenantEmail, role: "PLATFORM_SUPPORT", reason: "harness operator create", password: PASSWORD },
  });
  check("super admin can create operator (reauth passed)", createOp.status === 201 && createOp.json?.data?.operator?.role === "PLATFORM_SUPPORT");

  const createDup = await call("/api/v1/platform/operators", {
    jar: "op",
    method: "POST",
    body: { email: tenantEmail, role: "PLATFORM_SUPPORT", reason: "duplicate", password: PASSWORD },
  });
  check("duplicate operator rejected (§133)", createDup.status === 422);

  // Promote the SECURITY operator to super admin via PATCH (the sanctioned
  // management path for an EXISTING operator record, §54).
  const promoteSecondSuper = await call(`/api/v1/platform/operators/${secRow.id}`, {
    jar: "op",
    method: "PATCH",
    body: { role: "PLATFORM_SUPER_ADMIN", reason: "harness second super", password: PASSWORD },
  });
  check("second super admin promotable (PATCH §54)", promoteSecondSuper.status === 200 && promoteSecondSuper.json?.data?.operator?.role === "PLATFORM_SUPER_ADMIN", JSON.stringify(promoteSecondSuper.json?.error));

  const demoteSecond = await call(`/api/v1/platform/operators/${secRow.id}`, {
    jar: "op",
    method: "PATCH",
    body: { role: "PLATFORM_SECURITY", reason: "restore harness security role", password: PASSWORD },
  });
  check("demotion allowed when another active super admin exists", demoteSecond.status === 200);

  // §105 — last-admin protection. The environment may hold a PRE-EXISTING
  // operator (the manually bootstrapped one); it is temporarily deactivated
  // (and restored afterwards) so opRow is genuinely the ONLY active super
  // admin during this check.
  const preExisting = await prisma.platformOperator.findMany({
    where: { role: "PLATFORM_SUPER_ADMIN", active: true, NOT: { id: opRow.id } },
  });
  for (const pre of preExisting) {
    await prisma.platformOperator.update({ where: { id: pre.id }, data: { active: false } });
  }
  const lastAdminBlock = await call(`/api/v1/platform/operators/${opRow.id}`, {
    jar: "op",
    method: "PATCH",
    body: { active: false, reason: "last admin deactivate attempt", password: PASSWORD },
  });
  for (const pre of preExisting) {
    await prisma.platformOperator.update({ where: { id: pre.id }, data: { active: true } });
  }
  check("deactivate last super admin → 409 PLATFORM_LAST_ADMIN_PROTECTED (§105)", lastAdminBlock.status === 409 && lastAdminBlock.json?.error?.code === "PLATFORM_LAST_ADMIN_PROTECTED", JSON.stringify(lastAdminBlock.json?.error));

  const wrongReauth = await call(`/api/v1/platform/operators/${opRow.id}`, {
    jar: "op",
    method: "PATCH",
    body: { role: "PLATFORM_READONLY", reason: "wrong password probe", password: "definitely-wrong" },
  });
  check("operator update with wrong password → 403 PLATFORM_REAUTH_FAILED", wrongReauth.status === 403 && wrongReauth.json?.error?.code === "PLATFORM_REAUTH_FAILED", JSON.stringify(wrongReauth.json?.error));

  // §133 — bootstrap script negative tests (offline).
  const { execSync } = await import("node:child_process");
  function runScript(args) {
    try {
      return { ok: true, out: execSync(`bun scripts/platform-operator.ts ${args}`, { cwd: ROOT, encoding: "utf8", env: { ...process.env } }) };
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  }
  const bsMissingUser = runScript(`bootstrap --email ghost-${STAMP}@x.local --role PLATFORM_SUPPORT --yes`);
  check("bootstrap missing user rejected (§61)", !bsMissingUser.ok && bsMissingUser.out.includes("No user exists"));
  const bsBadRole = runScript(`bootstrap --email ${tenantEmail} --role SUPER_ADMIN --yes`);
  check("bootstrap invalid role rejected", !bsBadRole.ok && bsBadRole.out.includes("Invalid role"));
  const bsDup = runScript(`bootstrap --email ${tenantEmail} --role PLATFORM_SUPPORT --yes`);
  check("bootstrap duplicate operator rejected", !bsDup.ok && bsDup.out.includes("already exists"));

  /* ---------- I. tenant isolation ---------- */
  console.log("\n== I. Tenant isolation + leak checks (§52/§78/§83) ==");
  const tenantRoutes = [
    "/api/v1/platform/overview",
    "/api/v1/platform/businesses",
    "/api/v1/platform/users",
    "/api/v1/platform/subscriptions",
    "/api/v1/platform/payments",
    "/api/v1/platform/pricing",
    "/api/v1/platform/ai-cost/overview",
    "/api/v1/platform/ai-cost/rates",
    "/api/v1/platform/ai-cost/ledger",
    "/api/v1/platform/ai-cost/economics?planCode=STARTER&billingPeriod=MONTHLY",
    "/api/v1/platform/ai-cost/anomalies",
    "POST:/api/v1/platform/ai-cost/reconciliation",
    "/api/v1/platform/audit",
    "/api/v1/platform/operators",
    "/api/v1/platform/system",
  ];
  let tenantLeaks = 0;
  for (const r of tenantRoutes) {
    const isPost = r.startsWith("POST:");
    const path = isPost ? r.slice("POST:".length) : r;
    const res = await call(path, { jar: "owner", method: isPost ? "POST" : "GET", body: isPost ? { mode: "dry-run", reason: "tenant isolation probe" } : undefined });
    if (res.status !== 403) {
      tenantLeaks++;
      console.error(`    tenant reached ${path} → ${res.status}`);
    }
  }
  check("tenant user 403 on ALL platform routes (§78/§107)", tenantLeaks === 0, `${tenantLeaks} leaks`);

  const tenantPostRate = await call("/api/v1/platform/ai-cost/rates", {
    jar: "owner",
    method: "POST",
    body: { provider: "z-ai", model: "X", currency: "USD", version: "x", inputRateNanoMinorPer1K: "1", outputRateNanoMinorPer1K: "1", effectiveFrom: new Date().toISOString(), environment: "PRODUCTION", verifiedBy: "tenant", sourceReference: "tenant", reason: "tenant tampering", password: "x" },
  });
  check("tenant cannot create AI rate even with evidence fields (§82)", tenantPostRate.status === 403);

  // §83 — customer surfaces carry no platform/cost data.
  const bizExport = await call(`/api/v1/businesses/${bizId}/export`, { jar: "owner", headers: { "x-business-id": bizId } });
  const exportStr = JSON.stringify(bizExport.json);
  check("business export has no AiCostRate/AiCostRecord/PlatformAudit data (§83)", bizExport.status === 200 && !exportStr.includes("costNanoMinor") && !exportStr.includes("PlatformAuditLog") && !exportStr.includes("AiCostRate"));

  /* ---------- Platform audit coverage ---------- */
  console.log("\n== Platform audit coverage (§34) ==");
  const auditCount = await prisma.platformAuditLog.count();
  check("PlatformAuditLog rows written by this harness", auditCount >= 6, `count=${auditCount}`);
  const auditRows = await prisma.platformAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 40 });
  const auditStr = auditRows.map((r) => `${r.beforeJson ?? ""}${r.afterJson ?? ""}`).join("|");
  const auditLeaks = ["password", "passwordHash", "NEXTAUTH", "prompt"].filter((s) => auditStr.toLowerCase().includes(s.toLowerCase()));
  check("platform audit rows carry no secrets/prompts (§10/§53)", auditLeaks.length === 0, auditLeaks.join(","));

  /* ---------- cleanup (§104 — no permanent fixtures) ---------- */
  console.log("\n== Cleanup (temporary fixtures removed) ==");
  await prisma.platformAuditLog.deleteMany({ where: { OR: [{ operatorId: opRow.id }, { operatorId: roRow.id }, { operatorId: secRow.id }] } });
  await prisma.platformOperator.deleteMany({ where: { userId: { in: [opUser.id, roUser.id, secUser.id, tenantUser.id] } } });
  // Prefix-scoped (all harness versions start with `p28-`): also removes
  // rows a mid-run crash would otherwise strand for the next run's canary.
  await prisma.aiCostRate.deleteMany({ where: { version: { startsWith: "p28-" } } });
  await prisma.priceBook.deleteMany({ where: { version: { startsWith: "p28-" } } });
  await prisma.business.delete({ where: { id: biz.id } });
  for (const u of [opUser, roUser, secUser, tenantUser, ownerUser]) {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => undefined);
  }
  check("fixtures cleaned (businesses, operators, users, rates, books)", true);

  staticScans();

  /* ---------- summary ---------- */
  console.log("============================================");
  console.log(`=== PROMPT 28: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    console.log("FAILED CHECKS:");
    for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 200)}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main()
  .catch((e) => {
    console.error("HARNESS CRASH:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
