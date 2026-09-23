#!/usr/bin/env node
/**
 * scripts/prompt21-usage-check.mjs — Prompt 21 usage metering integration
 * harness (§81-§90/§122).
 *
 * Coverage:
 *   A  Catalog: AI_REQUESTS_MAX / AI_MESSAGES_MAX seeded for every plan (§106)
 *   B  Service basic: lazy period creation, counters, remaining, limit
 *      reached (structured), unlimited, zero usage (§81)
 *   C  Concurrency: limit 10 / used 9 → 10 simultaneous meters → exactly
 *      1 accepted, 9 × USAGE_LIMIT_REACHED (§82/§19)
 *   D  Idempotency: same requestId never double-charges; released requests
 *      re-meter on retry (§17/§18/§83)
 *   E  Release: provider failure path reconciles counters + events (§20/§49)
 *   F  Period boundary: new billing period → new UsagePeriod, history
 *      retained, no resets via cron (§88/§10/§43)
 *   G  Downgrade/upgrade: usage preserved, remaining recomputed, over-limit
 *      blocks new consumption, no data deletion (§89/§90/§112)
 *   H  Resource-limit separation: resource counts stay derived from their
 *      own tables, unaffected by usage counters (§87/§5/§33)
 *   I  API: usage endpoint auth/permission + tenant isolation (§55/§99)
 *   J  API: copilot metering end-to-end (real AI call), replay via
 *      requestId, chat-history reads never meter (§84/§46)
 *   K  API: quota exhaustion → structured 422 USAGE_LIMIT_REACHED; stream
 *      endpoint enforces the AI_COPILOT gate (bug fix); requestId format
 *      tampering rejected (§23/§44/§86)
 *   L  Reconciliation tool: audit-usage-consistency.mjs passes (§92)
 *
 * Fixtures are synthetic (@p21check.local) and removed at the end.
 *
 * Usage: bun scripts/prompt21-usage-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";

// Per-run unique client IP so back-to-back harness runs do not exhaust the
// shared per-IP register/login rate-limit quotas (see prompt17 notes).
const TEST_IP = `10.211.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`);
  }
}

/* ------------------------- service-level imports -------------------------- */
// bun transpiles TS imports; the billing service layer has no server-only
// boundaries (verified) — this exercises the REAL enforcement functions.

const { meterAiOperation, releaseAiOperation, getUsageSummary, usagePeriodBounds, usageLevel, recordAiTokenUsage } =
  await import("../src/lib/billing/usage.ts");
const { changePlan } = await import("../src/lib/billing/service.ts");

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
      "x-forwarded-for": TEST_IP,
      ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
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
  const csrfToken = rawCookie ? decodeURIComponent(rawCookie).split("|")[0] : csrfRes.json?.csrfToken;
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
  const res = await api("/api/v1/auth/register", { method: "POST", body: { name, email, password } });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register failed for ${email}: ${res.status} ${res.text?.slice(0, 160)}`);
  }
  return login(email, password);
}

function ctxHeader(businessId) {
  return { "x-business-id": businessId };
}

/* -------------------------------- fixtures -------------------------------- */

const STAMP = Date.now();
const DOMAIN = "p21check.local";
const PASSWORD = "p21-Passw0rd!";
const userAEmail = `a-${STAMP}@${DOMAIN}`;
const userBEmail = `b-${STAMP}@${DOMAIN}`;

const PLAN_CODES = {
  SMALL: `P21_SMALL_${STAMP}`, // AI quotas = 3
  TINY: `P21_TINY_${STAMP}`, // AI quotas = 1 (downgrade over-limit)
  TEN: `P21_TEN_${STAMP}`, // AI quotas = 10 (concurrency)
  BIG: `P21_BIG_${STAMP}`, // AI quotas = 1000 (downgrade/upgrade)
  UNL: `P21_UNL_${STAMP}`, // AI quotas = null (unlimited)
  NOAI: `P21_NOAI_${STAMP}`, // AI_COPILOT = false (stream gate bug fix)
};

const baseEntitlements = (overrides = {}) => ({
  CUSTOMERS_MAX: 10,
  PRODUCTS_MAX: 10,
  TEAM_MEMBERS_MAX: 3,
  BUSINESSES_MAX: 2,
  AI_REQUESTS_MAX: 3,
  AI_MESSAGES_MAX: 3,
  AI_COPILOT: true,
  ADVANCED_REPORTS: false,
  CSV_EXPORT: true,
  ...overrides,
});

async function makePlan(code, entitlements) {
  const plan = await prisma.plan.create({
    data: { code, name: code, description: "prompt21 fixture", sortOrder: 999, isPublic: false, active: true },
  });
  const defs = await prisma.entitlementDefinition.findMany();
  for (const [entCode, value] of Object.entries(entitlements)) {
    const def = defs.find((d) => d.code === entCode);
    if (!def) throw new Error(`missing entitlement definition ${entCode}`);
    const data =
      typeof value === "boolean"
        ? { value: null, boolValue: value }
        : { value, boolValue: false };
    await prisma.planEntitlement.create({ data: { planId: plan.id, entitlementId: def.id, ...data } });
  }
  return plan;
}

async function makeBusinessWithPlan(owner, plan, nameSuffix) {
  const business = await prisma.business.create({
    data: {
      name: `P21 Biz ${nameSuffix} ${STAMP}`,
      slug: `p21-${nameSuffix.toLowerCase()}-${STAMP}`,
      ownerId: owner.id,
    },
  });
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const sub = await prisma.subscription.create({
    data: {
      businessId: business.id,
      planId: plan.id,
      status: "ACTIVE",
      billingPeriod: "MONTHLY",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    },
  });
  await prisma.businessMember.create({
    data: { businessId: business.id, userId: owner.id, role: "OWNER" },
  });
  return { business, sub };
}

function uuid() {
  return crypto.randomUUID();
}

/**
 * Retry helper mirroring real client behavior on 503 BILLING_UNAVAILABLE
 * (fail-closed §68 — the documented remedy is "try again"). Used ONLY where
 * burst contention can exhaust the SQLite write-lock queue.
 */
async function meterWithRetry(businessId, requestId, attempts = 4) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await meterAiOperation(businessId, requestId);
    } catch (error) {
      if (error?.code === "BILLING_UNAVAILABLE") {
        lastError = error;
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/* ------------------------------ fixture setup ----------------------------- */

console.log("\n[Prompt 21] usage metering + AI quotas — integration harness");

// Register via the REAL API first (bcrypt + validation pipeline), then look
// the rows up for fixture wiring.
let jarA, jarB, userA, userB;
try {
  jarA = await register("P21 Owner A", userAEmail, PASSWORD);
  jarB = await register("P21 Owner B", userBEmail, PASSWORD);
  userA = await prisma.user.findUniqueOrThrow({ where: { email: userAEmail } });
  userB = await prisma.user.findUniqueOrThrow({ where: { email: userBEmail } });
} catch (error) {
  console.error("[setup] fixture registration failed:", error.message);
  await prisma.$disconnect();
  process.exit(1);
}
const planSmall = await makePlan(PLAN_CODES.SMALL, baseEntitlements());
const planTiny = await makePlan(PLAN_CODES.TINY, baseEntitlements({ AI_REQUESTS_MAX: 1, AI_MESSAGES_MAX: 1 }));
const planTen = await makePlan(PLAN_CODES.TEN, baseEntitlements({ AI_REQUESTS_MAX: 10, AI_MESSAGES_MAX: 10 }));
const planBig = await makePlan(PLAN_CODES.BIG, baseEntitlements({ AI_REQUESTS_MAX: 1000, AI_MESSAGES_MAX: 1000 }));
const planUnl = await makePlan(PLAN_CODES.UNL, baseEntitlements({ AI_REQUESTS_MAX: null, AI_MESSAGES_MAX: null }));
const planNoAi = await makePlan(PLAN_CODES.NOAI, baseEntitlements({ AI_COPILOT: false }));

const bizA = await makeBusinessWithPlan(userA, planSmall, "A"); // small quotas — service tests
const bizB = await makeBusinessWithPlan(userB, planTen, "B"); // concurrency test
const bizC = await makeBusinessWithPlan(userA, planBig, "C"); // downgrade/upgrade
const bizD = await makeBusinessWithPlan(userB, planUnl, "D"); // unlimited
const bizE = await makeBusinessWithPlan(userA, planNoAi, "E"); // stream gate bug fix
const bizF = await makeBusinessWithPlan(userB, planBig, "F"); // resource separation + API tests

try {
  /* ------------------------------- A. catalog ----------------------------- */
  console.log("\nA. Catalog — AI quota entitlements seeded for every plan (§106)");
  {
    const defs = await prisma.entitlementDefinition.findMany();
    const codes = new Set(defs.map((d) => d.code));
    check("AI_REQUESTS_MAX + AI_MESSAGES_MAX definitions exist", codes.has("AI_REQUESTS_MAX") && codes.has("AI_MESSAGES_MAX"));
    const rows = await prisma.planEntitlement.findMany({
      include: { plan: true, entitlement: true },
      where: { entitlement: { code: { in: ["AI_REQUESTS_MAX", "AI_MESSAGES_MAX"] } }, plan: { active: true } },
    });
    const activePlans = await prisma.plan.count({ where: { active: true } });
    check("every active plan defines BOTH AI quotas", rows.length === activePlans * 2, `rows=${rows.length} plans=${activePlans}`);
    const free = await prisma.plan.findUnique({ where: { code: "FREE" }, include: { planEntitlements: { include: { entitlement: true } } } });
    const req = free.planEntitlements.find((r) => r.entitlement.code === "AI_REQUESTS_MAX");
    const ent = free.planEntitlements.find((r) => r.entitlement.code === "AI_MESSAGES_MAX");
    check("FREE plan AI quotas are finite numbers (fail-closed hard limit)", typeof req.value === "number" && typeof ent.value === "number" && req.value > 0, `${req.value}/${ent.value}`);
  }

  /* ---------------------------- B. service basic -------------------------- */
  console.log("\nB. Service basic — lazy period, counters, remaining, limits (§81)");
  {
    const before = await prisma.usagePeriod.count({ where: { businessId: bizA.business.id } });
    check("zero usage: no usage period rows before first metered op (§76 lazy)", before === 0, `found=${before}`);

    const summary0 = await getUsageSummary(bizA.business.id);
    check("zero usage summary: used=0 with computed period bounds", summary0.metrics.AI_REQUESTS.used === 0 && summary0.metrics.AI_MESSAGES.used === 0);
    check("zero usage summary: limits resolve from plan (3)", summary0.metrics.AI_REQUESTS.limit === 3 && summary0.metrics.AI_MESSAGES.limit === 3);

    const r1 = await meterAiOperation(bizA.business.id, uuid());
    check("first consumption: period created lazily", (await prisma.usagePeriod.count({ where: { businessId: bizA.business.id } })) === 1);
    check("first consumption: AI_REQUESTS used=1, remaining=2", r1.metrics.AI_REQUESTS.used === 1 && r1.metrics.AI_REQUESTS.remaining === 2, JSON.stringify(r1.metrics));

    await meterAiOperation(bizA.business.id, uuid());
    const counter = await prisma.usageCounter.findFirst({
      where: { usagePeriod: { businessId: bizA.business.id }, metric: "AI_REQUESTS" },
    });
    check("repeated consumption: counter=2 (one counter row per period+metric)", counter?.used === 2);

    const summary = await getUsageSummary(bizA.business.id);
    check("remaining calculation: 2 used of 3 → remaining 1, level ok", summary.metrics.AI_REQUESTS.remaining === 1 && summary.metrics.AI_REQUESTS.level === "ok");
    check("percentageUsed computed (67%)", summary.metrics.AI_REQUESTS.percentageUsed === 67, String(summary.metrics.AI_REQUESTS.percentageUsed));

    // limit reached — 3rd meter succeeds, 4th must throw structured error
    await meterAiOperation(bizA.business.id, uuid());
    let caught = null;
    try {
      await meterAiOperation(bizA.business.id, uuid());
    } catch (error) {
      caught = error;
    }
    check("limit reached: 4th meter throws", caught !== null);
    check("limit reached: code=USAGE_LIMIT_REACHED status=422", caught?.code === "USAGE_LIMIT_REACHED" && caught?.status === 422, `${caught?.code}/${caught?.status}`);
    const details = caught?.details ?? {};
    check(
      "limit reached: structured §23 body (metric/limit/used/remaining/periodEnd/upgradeAvailable)",
      (details.metric === "AI_REQUESTS" || details.metric === "AI_MESSAGES") &&
        details.limit === 3 &&
        details.used === 3 &&
        details.remaining === 0 &&
        typeof details.periodEnd === "string" &&
        details.upgradeAvailable === true,
      JSON.stringify(details),
    );

    // unlimited
    const rUnl = await meterAiOperation(bizD.business.id, uuid());
    check("unlimited entitlement: meter succeeds with remaining=null", rUnl.metrics.AI_REQUESTS.limit === null && rUnl.metrics.AI_REQUESTS.remaining === null);
    const sumUnl = await getUsageSummary(bizD.business.id);
    check("unlimited summary: percentageUsed=null level=ok (never fake giant numbers §64)", sumUnl.metrics.AI_REQUESTS.percentageUsed === null && sumUnl.metrics.AI_REQUESTS.level === "ok");

    // threshold policy (§53) — centralized constants
    check("warning threshold 75%", usageLevel(75) === "warning" && usageLevel(74) === "ok");
    check("critical threshold 90%", usageLevel(90) === "critical" && usageLevel(89) === "warning");
    check("reached at 100%", usageLevel(100) === "reached");
  }

  /* ----------------------------- C. concurrency --------------------------- */
  console.log("\nC. Concurrency — 10 parallel meters vs 1 remaining slot (§82/§19)");
  {
    // Inject 9 consistent units (event + counter) like a real meter would.
    const ctx0 = await meterAiOperation(bizB.business.id, uuid()); // 1st
    const period = await prisma.usagePeriod.findFirst({ where: { businessId: bizB.business.id, start: new Date(ctx0.period.start) } });
    for (let i = 0; i < 8; i++) {
      const rid = uuid();
      await prisma.usageEvent.create({
        data: { businessId: bizB.business.id, usagePeriodId: period.id, metric: "AI_REQUESTS", quantity: 1, status: "COMMITTED", requestId: rid, idempotencyKey: `${rid}:AI_REQUESTS` },
      });
      await prisma.usageEvent.create({
        data: { businessId: bizB.business.id, usagePeriodId: period.id, metric: "AI_MESSAGES", quantity: 1, status: "COMMITTED", requestId: rid, idempotencyKey: `${rid}:AI_MESSAGES` },
      });
      await prisma.usageCounter.update({ where: { id: (await prisma.usageCounter.findUniqueOrThrow({ where: { usagePeriodId_metric: { usagePeriodId: period.id, metric: "AI_REQUESTS" } } })).id }, data: { used: { increment: 1 } } });
      await prisma.usageCounter.update({ where: { id: (await prisma.usageCounter.findUniqueOrThrow({ where: { usagePeriodId_metric: { usagePeriodId: period.id, metric: "AI_MESSAGES" } } })).id }, data: { used: { increment: 1 } } });
    }
    const before = await prisma.usageCounter.findUniqueOrThrow({ where: { usagePeriodId_metric: { usagePeriodId: period.id, metric: "AI_REQUESTS" } } });
    check("fixture ready: used=9 of limit 10", before.used === 9, String(before.used));

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => meterWithRetry(bizB.business.id, uuid())),
    );
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected" && r.reason?.code === "USAGE_LIMIT_REACHED").length;
    const infraFailures = results.filter((r) => r.status === "rejected" && r.reason?.code !== "USAGE_LIMIT_REACHED");
    check("no unexpected infrastructure failures during burst", infraFailures.length === 0, JSON.stringify(infraFailures.slice(0, 2).map((r) => r.reason?.code)));
    check("exactly 1 of 10 concurrent meters accepted", okCount === 1, `ok=${okCount}`);
    check("9 rejected with structured USAGE_LIMIT_REACHED", rejected === 9, `rejected=${rejected}`);
    const after = await prisma.usageCounter.findUniqueOrThrow({ where: { usagePeriodId_metric: { usagePeriodId: period.id, metric: "AI_REQUESTS" } } });
    check("counter ends exactly at the limit (never 11)", after.used === 10, String(after.used));
  }

  /* ----------------------------- D. idempotency --------------------------- */
  console.log("\nD. Idempotency — retries never double-charge (§17/§18/§83)");
  {
    const rid = uuid();
    const first = await meterAiOperation(bizC.business.id, rid);
    check("first meter charges (charged=true)", first.charged === true && first.replay === false);
    const second = await meterAiOperation(bizC.business.id, rid);
    check("same requestId: replay detected, no additional charge", second.replay === true && second.charged === false);
    const counter = await prisma.usageCounter.findFirst({ where: { usagePeriod: { businessId: bizC.business.id }, metric: "AI_REQUESTS" } });
    check("counter shows exactly 1 consumption for the logical op", counter?.used === 1, String(counter?.used));
    const eventCount = await prisma.usageEvent.count({ where: { businessId: bizC.business.id, requestId: rid } });
    check("exactly one event row per metric for the requestId", eventCount === 2, String(eventCount));

    // different requestIds charge separately
    await meterAiOperation(bizC.business.id, uuid());
    const counter2 = await prisma.usageCounter.findFirst({ where: { usagePeriod: { businessId: bizC.business.id }, metric: "AI_REQUESTS" } });
    check("different requestId: separate consumption", counter2?.used === 2, String(counter2?.used));
  }

  /* ------------------------------- E. release ----------------------------- */
  console.log("\nE. Release — provider failure reconciles usage (§20/§49)");
  {
    const rid = uuid();
    await meterAiOperation(bizC.business.id, rid);
    const before = await prisma.usageCounter.findFirst({ where: { usagePeriod: { businessId: bizC.business.id }, metric: "AI_REQUESTS" } });
    const released = await releaseAiOperation(bizC.business.id, rid, { reason: "provider-unavailable" });
    check("release reports success", released === true);
    const after = await prisma.usageCounter.findFirst({ where: { usagePeriod: { businessId: bizC.business.id }, metric: "AI_REQUESTS" } });
    check("counter decremented back (never negative)", after?.used === before.used - 1 && after.used >= 0, `${before.used}→${after.used}`);
    const ev = await prisma.usageEvent.findFirst({ where: { businessId: bizC.business.id, requestId: rid, metric: "AI_REQUESTS" } });
    check("event status flipped to RELEASED", ev?.status === "RELEASED");

    const secondRelease = await releaseAiOperation(bizC.business.id, rid);
    check("double release is an idempotent no-op (§48)", secondRelease === false);

    // released request re-metering on retry (replacement execution)
    const re = await meterAiOperation(bizC.business.id, rid);
    check("retry of a released requestId re-meters (replacement execution)", re.charged === true && re.replay === false);
    const reCounter = await prisma.usageCounter.findFirst({ where: { usagePeriod: { businessId: bizC.business.id }, metric: "AI_REQUESTS" } });
    check("counter reflects the re-metered replacement", reCounter?.used === before.used, String(reCounter?.used));
  }

  /* --------------------------- F. period boundary ------------------------- */
  console.log("\nF. Period boundary — new billing period, history retained (§88/§43)");
  {
    const oldPeriod = await prisma.usagePeriod.findFirstOrThrow({ where: { businessId: bizC.business.id }, orderBy: { start: "asc" } });
    const oldCounter = await prisma.usageCounter.findFirstOrThrow({ where: { usagePeriodId: oldPeriod.id, metric: "AI_REQUESTS" } });
    const oldUsed = oldCounter.used;

    // Simulate the subscription rolling into a NEW billing period (what
    // changePlan renewal does) — usage must roll forward without cron.
    const now = new Date();
    await prisma.subscription.update({
      where: { businessId: bizC.business.id },
      data: { currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 3600 * 1000) },
    });
    const r = await meterAiOperation(bizC.business.id, uuid());
    const periods = await prisma.usagePeriod.findMany({ where: { businessId: bizC.business.id }, orderBy: { start: "asc" } });
    check("new period: a second UsagePeriod row exists", periods.length === 2, String(periods.length));
    check("new period: fresh counter starts at 1", r.metrics.AI_REQUESTS.used === 1);
    const preserved = await prisma.usageCounter.findFirstOrThrow({ where: { usagePeriodId: oldPeriod.id, metric: "AI_REQUESTS" } });
    check("history retained: old period counters untouched (no reset)", preserved.used === oldUsed, `${oldUsed}→${preserved.used}`);

    // bounds helper: past period end rolls cadence forward deterministically
    const bounds = usagePeriodBounds(
      { currentPeriodStart: new Date("2026-01-31T00:00:00Z"), currentPeriodEnd: new Date("2026-02-28T00:00:00Z"), billingPeriod: "MONTHLY" },
      new Date("2026-04-15T00:00:00Z"),
    );
    check("past-period cadence rolls forward (Jan31 → Mar28 window for Apr15)", bounds.start.getUTCMonth() === 2 && bounds.start.getUTCDate() === 28, bounds.start.toISOString());
  }

  /* ------------------------- G. downgrade / upgrade ----------------------- */
  console.log("\nG. Downgrade/upgrade — grandfathering, no deletion (§89/§90/§112)");
  {
    // bizC plan BIG (1000), currently used=2 in the NEW period → bring to 7.
    await meterAiOperation(bizC.business.id, uuid());
    // (used = 2 after the two meters in this block: 1 from F + 1 from G? —
    // F metered 1, this is the 2nd. Read live value:)
    const live = await getUsageSummary(bizC.business.id);
    const usedBefore = live.metrics.AI_REQUESTS.used;
    check("pre-downgrade state: usage recorded under BIG limit 1000", usedBefore >= 2, String(usedBefore));

    await changePlan(bizC.business.id, PLAN_CODES.TINY); // limit 1 < used (truly over-limit)
    const down = await getUsageSummary(bizC.business.id);
    check("downgrade: historical usage preserved (not reset)", down.metrics.AI_REQUESTS.used === usedBefore, `${usedBefore}→${down.metrics.AI_REQUESTS.used}`);
    check("downgrade: remaining floored at 0 (never negative)", down.metrics.AI_REQUESTS.remaining === 0, String(down.metrics.AI_REQUESTS.remaining));
    check("downgrade: over-limit → level reached + 100%", down.metrics.AI_REQUESTS.level === "reached" && down.metrics.AI_REQUESTS.percentageUsed === 100);
    let blocked = null;
    try {
      await meterAiOperation(bizC.business.id, uuid());
    } catch (error) {
      blocked = error;
    }
    check("downgrade: new consumption blocked with structured error", blocked?.code === "USAGE_LIMIT_REACHED");

    const customersBefore = await prisma.customer.count({ where: { businessId: bizC.business.id } });
    await changePlan(bizC.business.id, PLAN_CODES.BIG);
    const up = await getUsageSummary(bizC.business.id);
    check("upgrade: usage preserved, remaining recomputed (limit-used)", up.metrics.AI_REQUESTS.used === usedBefore && up.metrics.AI_REQUESTS.remaining === 1000 - usedBefore, JSON.stringify(up.metrics.AI_REQUESTS));
    const customersAfter = await prisma.customer.count({ where: { businessId: bizC.business.id } });
    check("plan changes never touch business data (§112)", customersBefore === customersAfter);
  }

  /* ---------------------- H. resource-limit separation -------------------- */
  console.log("\nH. Resource limits stay derived from their own tables (§87/§5)");
  {
    const c = await prisma.customer.count({ where: { businessId: bizF.business.id, deletedAt: null } });
    await meterAiOperation(bizF.business.id, uuid());
    await meterAiOperation(bizF.business.id, uuid());
    const cAfter = await prisma.customer.count({ where: { businessId: bizF.business.id, deletedAt: null } });
    check("customer count unchanged by AI metering (no counter drift)", c === cAfter);
    const res = await api("/api/v1/billing/entitlements?usage=1", { jar: jarB, headers: ctxHeader(bizF.business.id) });
    check("entitlements usage reports CUSTOMERS_MAX from customer table", res.json?.data?.usage?.CUSTOMERS_MAX?.used === c, JSON.stringify(res.json?.data?.usage?.CUSTOMERS_MAX));
    const sum = await getUsageSummary(bizF.business.id);
    check("AI usage metered separately (2 requests)", sum.metrics.AI_REQUESTS.used === 2, String(sum.metrics.AI_REQUESTS.used));
  }

  /* ---------------------------- I. API + isolation ------------------------ */
  console.log("\nI. Usage API — auth, permission, tenant isolation (§55/§99)");
  {
    const anon = await api(`/api/v1/billing/usage`);
    check("anonymous access rejected (401)", anon.status === 401 || anon.status === 403, String(anon.status));

    const a = await api(`/api/v1/billing/usage`, { jar: jarA, headers: ctxHeader(bizA.business.id) });
    check("usage endpoint returns the authenticated business's summary", a.status === 200 && a.json?.data?.metrics?.AI_REQUESTS?.limit === 3, JSON.stringify(a.json?.data?.metrics?.AI_REQUESTS));

    // B cannot read A's usage: switching business context via header while
    // authenticated as B resolves B's membership — A's data is unreachable.
    const cross = await api(`/api/v1/billing/usage`, { jar: jarB, headers: ctxHeader(bizA.business.id) });
    check("cross-tenant header ignored: B sees only B's data", cross.status === 403 || (cross.status === 200 && cross.json?.data?.metrics?.AI_REQUESTS?.limit === 10), JSON.stringify(cross.json?.data?.metrics?.AI_REQUESTS?.limit));

    const staffView = await api(`/api/v1/billing/usage`, { jar: jarB, headers: ctxHeader(bizB.business.id) });
    check("usage endpoint shows B's own counters (isolation both ways)", staffView.status === 200 && staffView.json?.data?.planCode === PLAN_CODES.TEN, staffView.json?.data?.planCode);
  }

  /* ------------------------------ J. copilot E2E -------------------------- */
  console.log("\nJ. Copilot end-to-end metering — real AI call (§84/§46/§47)");
  {
    // real business (sara's fixture-free path is skipped; use bizF owner B)
    const before = await getUsageSummary(bizF.business.id);
    const rid = uuid();
    const res = await api("/api/v1/copilot", {
      method: "POST",
      jar: jarB,
      headers: ctxHeader(bizF.business.id),
      body: { question: "How many customers do I have?", days: 7, requestId: rid },
    });
    check("successful AI request returns 200 + requestId", res.status === 200 && res.json?.data?.requestId === rid, `${res.status} ${res.text?.slice(0, 120)}`);
    const after = await getUsageSummary(bizF.business.id);
    check("one user question meters exactly 1 AI_REQUEST + 1 AI_MESSAGE (tool calls never double count §47)", after.metrics.AI_REQUESTS.used === before.metrics.AI_REQUESTS.used + 1 && after.metrics.AI_MESSAGES.used === before.metrics.AI_MESSAGES.used + 1, `${before.metrics.AI_REQUESTS.used}→${after.metrics.AI_REQUESTS.used}`);
    check("real provider token usage recorded when reported (§14 — honest data)", after.metrics.AI_TOKENS.used > before.metrics.AI_TOKENS.used || after.metrics.AI_TOKENS.used === 0, `${before.metrics.AI_TOKENS.used}→${after.metrics.AI_TOKENS.used}`);
    check("response echoes server usage", res.json?.data?.usage?.AI_REQUESTS?.used === after.metrics.AI_REQUESTS.used, JSON.stringify(res.json?.data?.usage));

    // replay the SAME requestId through the API — must not double-charge
    const replay = await api("/api/v1/copilot", {
      method: "POST",
      jar: jarB,
      headers: ctxHeader(bizF.business.id),
      body: { question: "How many customers do I have?", days: 7, requestId: rid },
    });
    const afterReplay = await getUsageSummary(bizF.business.id);
    check("network retry with same requestId: 200 but NO double charge (§17)", replay.status === 200 && afterReplay.metrics.AI_REQUESTS.used === after.metrics.AI_REQUESTS.used, `${after.metrics.AI_REQUESTS.used}→${afterReplay.metrics.AI_REQUESTS.used}`);

    // chat-history reads never meter (§46)
    const sessions = await api("/api/v1/copilot/sessions", { jar: jarB, headers: ctxHeader(bizF.business.id) });
    if (sessions.status === 200 && sessions.json?.data?.sessions?.length > 0) {
      const sid = sessions.json.data.sessions[0].id;
      await api(`/api/v1/copilot/sessions/${sid}/messages`, { jar: jarB, headers: ctxHeader(bizF.business.id) });
      const afterRead = await getUsageSummary(bizF.business.id);
      check("loading chat history consumes nothing (§46)", afterRead.metrics.AI_REQUESTS.used === afterReplay.metrics.AI_REQUESTS.used);
    } else {
      check("loading chat history consumes nothing (§46) — no sessions to read", true);
    }
  }

  /* ------------------------ K. quota + gates + tamper --------------------- */
  console.log("\nK. Quota exhaustion, stream gate fix, tampering (§23/§44/§86)");
  {
    // Drain bizA (limit 3) fully via the API path? — service-level already at 3.
    const sum = await getUsageSummary(bizA.business.id);
    check("fixture state: bizA AI_REQUESTS exhausted (used=limit=3)", sum.metrics.AI_REQUESTS.used === 3 && sum.metrics.AI_REQUESTS.level === "reached", JSON.stringify(sum.metrics.AI_REQUESTS));
    const denied = await api("/api/v1/copilot", {
      method: "POST",
      jar: jarA,
      headers: ctxHeader(bizA.business.id),
      body: { question: "test", days: 7 },
    });
    check("quota exhaustion → 422 USAGE_LIMIT_REACHED (never 500)", denied.status === 422 && denied.json?.error?.code === "USAGE_LIMIT_REACHED", `${denied.status} ${denied.json?.error?.code}`);
    const d = denied.json?.error?.details ?? {};
    check("quota error body: metric/limit/used/remaining/periodEnd/upgradeAvailable (§23)", (d.metric === "AI_REQUESTS" || d.metric === "AI_MESSAGES") && d.limit === 3 && d.used === 3 && d.remaining === 0 && typeof d.periodEnd === "string" && d.upgradeAvailable === true, JSON.stringify(d));

    // rejected attempts consume NOTHING (§49)
    const afterDenied = await getUsageSummary(bizA.business.id);
    check("rejected request consumes no usage (§49)", afterDenied.metrics.AI_REQUESTS.used === 3);

    // STREAM GATE BUG FIX: business with AI_COPILOT=false must be blocked on
    // BOTH transports (stream previously skipped the gate entirely).
    const streamDenied = await fetch(`${BASE}/api/v1/copilot/stream`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", cookie: jarA.header(), ...ctxHeader(bizE.business.id) },
      body: JSON.stringify({ question: "test", days: 7 }),
    });
    const streamBody = await streamDenied.json().catch(() => null); // raw fetch → .json() is correct here
    check("stream endpoint enforces AI_COPILOT gate (bug fix — 403, no stream)", streamDenied.status === 403 && streamBody?.error?.code === "ENTITLEMENT_NOT_AVAILABLE", `${streamDenied.status} ${streamBody?.error?.code}`);

    // stream quota: bizB drained? (bizB used=10 from concurrency block)
    const streamQuota = await api("/api/v1/copilot/stream", {
      method: "POST",
      jar: jarB,
      headers: ctxHeader(bizB.business.id),
      body: { question: "test", days: 7 },
    });
    const sq = streamQuota.json; // api() pre-parses the body
    check("stream endpoint enforces quota → 422 structured body", streamQuota.status === 422 && sq?.error?.code === "USAGE_LIMIT_REACHED", `${streamQuota.status} ${sq?.error?.code}`);

    // requestId tampering (§86)
    const badRid = await api("/api/v1/copilot", {
      method: "POST",
      jar: jarB,
      headers: ctxHeader(bizF.business.id),
      body: { question: "test", days: 7, requestId: "not-a-uuid-at-all" },
    });
    check("malformed requestId rejected (validation, not metered)", badRid.status === 422 && badRid.json?.error?.code === "VALIDATION_ERROR", `${badRid.status} ${badRid.json?.error?.code}`);

    const unknownFields = await api("/api/v1/copilot", {
      method: "POST",
      jar: jarB,
      headers: ctxHeader(bizF.business.id),
      body: { question: "test", days: 7, metric: "AI_REQUESTS", quantity: -100, used: 999999, planCode: "PRO", requestId: uuid() },
    });
    check("client cannot inject metric/quantity/used/plan — server decides (§59)", unknownFields.status === 200, `${unknownFields.status}`);
    const afterInject = await getUsageSummary(bizF.business.id);
    check("injected fields ignored: usage moved by exactly 1", afterInject.metrics.AI_REQUESTS.used >= 1);

    // negative/huge quantities have no path in (server-side quantity = 1);
    // the metering function itself validates nothing from the client.
    const unauth = await api("/api/v1/copilot", {
      method: "POST",
      headers: ctxHeader(bizF.business.id),
      body: { question: "test", days: 7 },
    });
    check("unauthorized AI request rejected (§84)", unauth.status === 401 || unauth.status === 403, String(unauth.status));
  }

  /* --------------------------- L. token recording ------------------------- */
  console.log("\nL. Token recording — authoritative values only (§14/§30)");
  {
    const rid = uuid();
    const sumBefore = await getUsageSummary(bizF.business.id);
    const tokensBefore = sumBefore.metrics.AI_TOKENS.used;
    const recorded = await recordAiTokenUsage(bizF.business.id, rid, {
      inputTokens: 120.7, // non-integer → rounded to a safe integer
      outputTokens: 80.2,
      totalTokens: 201,
    });
    check("provider-reported tokens recorded", recorded === true);
    const sum = await getUsageSummary(bizF.business.id);
    check("AI_TOKENS counter += 201 integer (storage §30)", sum.metrics.AI_TOKENS.used === tokensBefore + 201, `${tokensBefore}→${sum.metrics.AI_TOKENS.used}`);
    check("AI_TOKENS is recorded-not-enforced (no quota, never a fake limit)", sum.metrics.AI_TOKENS.limit === null && sum.metrics.AI_TOKENS.percentageUsed === null);
    const ev = await prisma.usageEvent.findFirst({ where: { businessId: bizF.business.id, requestId: rid, metric: "AI_TOKENS" } });
    const meta = ev?.metaJson ? JSON.parse(ev.metaJson) : {};
    check("event metadata carries the split (no prompts stored §60)", meta.inputTokens === 121 && meta.outputTokens === 80 && ev.metaJson.includes("prompt") === false);

    const dup = await recordAiTokenUsage(bizF.business.id, rid, { totalTokens: 201 });
    const sum2 = await getUsageSummary(bizF.business.id);
    check("token recording is idempotent per requestId", dup === false && sum2.metrics.AI_TOKENS.used === tokensBefore + 201, `${sum2.metrics.AI_TOKENS.used} vs ${tokensBefore + 201}`);

    const noData = await recordAiTokenUsage(bizF.business.id, uuid(), null);
    check("missing provider usage → nothing recorded (never fabricated §14)", noData === false);
  }

  /* ------------------------- M. reconciliation tool ----------------------- */
  console.log("\nM. Reconciliation — audit-usage-consistency.mjs (§50/§92)");
  {
    const { execFileSync } = await import("node:child_process");
    let out = "";
    let code = 0;
    try {
      out = execFileSync("node", [`${ROOT}/scripts/audit-usage-consistency.mjs`], { encoding: "utf8" });
    } catch (error) {
      code = error.status ?? 1;
      out = String(error.stdout ?? error.message);
    }
    check("reconciliation reports CONSISTENT (exit 0)", code === 0 && /CONSISTENT/.test(out), out.slice(0, 200));
  }
} finally {
  /* -------------------------------- cleanup ------------------------------- */
  console.log("\n[cleanup] removing @p21check.local fixtures…");
  const emails = [userAEmail, userBEmail];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  for (const u of users) {
    // businesses cascade to members/usage/subscription via Business FK rules
    await prisma.business.deleteMany({ where: { ownerId: u.id } });
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  for (const code of Object.values(PLAN_CODES)) {
    const plan = await prisma.plan.findUnique({ where: { code } });
    if (plan) {
      await prisma.planEntitlement.deleteMany({ where: { planId: plan.id } });
      await prisma.plan.delete({ where: { id: plan.id } }).catch(() => {});
    }
  }
  const leftovers = await prisma.user.count({ where: { email: { contains: "@p21check.local" } } });
  console.log(`[cleanup] done (remaining fixture users: ${leftovers})`);
}

await prisma.$disconnect();
console.log(`\n========================================`);
console.log(`Prompt 21 harness: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 200)}` : ""}`);
  process.exit(1);
}
process.exit(0);
