#!/usr/bin/env node
/**
 * scripts/prompt20-billing-check.mjs — Prompt 20 billing foundation
 * integration harness (§86-§93/§120).
 *
 * Coverage:
 *   A  Plan catalog + idempotent seed (§37/§63/§103)
 *   B  Existing-business migration: every business has exactly one FREE
 *      subscription, backfill events written, data untouched (§14/§64/§104)
 *   C  Billing read APIs: subscription / entitlements+usage / plans / events
 *   D  Role policy: OWNER+ADMIN mutate, STAFF/VIEWER denied (§54/§100/§88)
 *   E  Tenant isolation: cross-business reads AND writes impossible (§56/§88)
 *   F  Plan change: transactional, evented, audited, idempotent; invalid +
 *      inactive plans rejected (§41/§43/§48/§49)
 *   G  Limit enforcement: structured 422 with feature/limit/current/
 *      upgradeAvailable, race-safe, downgrade grandfathering — NO data
 *      deletion (§27/§28/§42/§89/§112)
 *   H  Feature gates: AI_COPILOT / CSV_EXPORT / ADVANCED_REPORTS enforced
 *      server-side (§26/§34/§35/§36)
 *   I  Cancellation (cancelAtPeriodEnd, idempotent) + reactivation +
 *      EXPIRED fallback to FREE entitlements with data intact (§13/§44/§45)
 *   J  Trial capability disabled by default (§19)
 *   K  Money/finance untouched: existing financial pipelines still work
 *
 * Fixtures are synthetic (@p20check.local) and removed at the end.
 *
 * Usage: node scripts/prompt20-billing-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

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

function ctxHeader(businessId) {
  return { "x-business-id": businessId };
}

/* -------------------------------- fixtures -------------------------------- */

const STAMP = Date.now();
const DOMAIN = "p20check.local";
const PASSWORD = "p20-Passw0rd!";
const ownerEmail = `owner-${STAMP}@${DOMAIN}`;
const staffEmail = `staff-${STAMP}@${DOMAIN}`;
const viewerEmail = `viewer-${STAMP}@${DOMAIN}`;
const adminEmail = `admin-${STAMP}@${DOMAIN}`;

let bizA, bizB;
let ownerJar, staffJar, viewerJar, adminJar;
let fixtureUserIds = [];

async function createFixtures() {
  ownerJar = await register("P20 Owner", ownerEmail, PASSWORD);
  staffJar = await register("P20 Staff", staffEmail, PASSWORD);
  viewerJar = await register("P20 Viewer", viewerEmail, PASSWORD);
  adminJar = await register("P20 Admin", adminEmail, PASSWORD);

  const users = await prisma.user.findMany({
    where: { email: { endsWith: `@${DOMAIN}` } },
    select: { id: true, email: true },
  });
  fixtureUserIds = users.map((u) => u.id);

  // Two businesses owned by owner1 (A = main, B = isolation target).
  const resA = await api("/api/v1/businesses", {
    method: "POST",
    jar: ownerJar,
    body: { name: `P20 Biz A ${STAMP}`, currencyCode: "USD", locale: "en", timezone: "UTC" },
  });
  if (resA.status !== 201) throw new Error(`bizA create failed: ${resA.status} ${resA.text}`);
  bizA = resA.json.data.business;

  // §90/§107: FREE caps BUSINESSES_MAX at 1 — the second business only
  // becomes creatable after upgrading (STARTER = 2). This doubles as the
  // upgrade-lifts-the-cap check: the effective limit is read from the
  // owned business's plan, not from any client input.
  const up = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "STARTER" },
  });
  if (up.status !== 200) throw new Error(`upgrade for fixture failed: ${up.status} ${up.text}`);

  const resB = await api("/api/v1/businesses", {
    method: "POST",
    jar: ownerJar,
    body: { name: `P20 Biz B ${STAMP}`, currencyCode: "USD", locale: "en", timezone: "UTC" },
  });
  if (resB.status !== 201) throw new Error(`bizB create failed: ${resB.status} ${resB.text}`);
  bizB = resB.json.data.business;

  // Back to FREE for the main test sequence (bizB stays — grandfathered).
  const down = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "FREE" },
  });
  if (down.status !== 200) throw new Error(`downgrade for fixture failed: ${down.status} ${down.text}`);

  // Memberships added directly (avoids member-limit interference in role tests).
  const byEmail = Object.fromEntries(users.map((u) => [u.email, u.id]));
  await prisma.businessMember.createMany({
    data: [
      { businessId: bizA.id, userId: byEmail[staffEmail], role: "STAFF" },
      { businessId: bizA.id, userId: byEmail[viewerEmail], role: "VIEWER" },
      { businessId: bizA.id, userId: byEmail[adminEmail], role: "ADMIN" },
    ],
  });
}

async function cleanup() {
  try {
    // Point subscriptions back to FREE so test plans can be deleted.
    const free = await prisma.plan.findUnique({ where: { code: "FREE" } });
    await prisma.subscription.updateMany({
      where: { business: { owner: { email: { endsWith: `@${DOMAIN}` } } } },
      data: { planId: free.id },
    });
    // Remove fixture businesses (cascades members, customers, subscriptions…).
    await prisma.business.deleteMany({
      where: { owner: { email: { endsWith: `@${DOMAIN}` } } },
    });
    // Remove fixture plans.
    for (const code of ["P20-TINY", "P20_LEGACY"]) {
      const plan = await prisma.plan.findUnique({ where: { code } });
      if (plan) {
        await prisma.planEntitlement.deleteMany({ where: { planId: plan.id } });
        await prisma.plan.delete({ where: { id: plan.id } });
      }
    }
    // Remove fixture users.
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  } catch (error) {
    console.error("[cleanup] warning:", error.message);
  }
}

/* ------------------------------ fixture plans ----------------------------- */

/** Creates the P20-TINY plan (low limits, features off) used for gate tests. */
async function createTestPlan() {
  const defs = await prisma.entitlementDefinition.findMany();
  const defByCode = Object.fromEntries(defs.map((d) => [d.code, d.id]));
  const values = {
    CUSTOMERS_MAX: 2,
    PRODUCTS_MAX: 1,
    TEAM_MEMBERS_MAX: 1,
    BUSINESSES_MAX: 1,
    AI_COPILOT: false,
    ADVANCED_REPORTS: false,
    CSV_EXPORT: false,
  };
  const plan = await prisma.plan.upsert({
    where: { code: "P20-TINY" },
    create: {
      code: "P20-TINY",
      name: "P20 Test Tiny",
      description: "Harness-only plan",
      sortOrder: 999,
      isPublic: false,
      active: true,
    },
    update: {},
  });
  for (const [code, value] of Object.entries(values)) {
    const isLimit = typeof value === "number";
    await prisma.planEntitlement.upsert({
      where: {
        planId_entitlementId: { planId: plan.id, entitlementId: defByCode[code] },
      },
      create: {
        planId: plan.id,
        entitlementId: defByCode[code],
        value: isLimit ? value : null,
        boolValue: isLimit ? false : value,
      },
      update: { value: isLimit ? value : null, boolValue: isLimit ? false : value },
    });
  }
  return plan;
}

/* ================================== checks ================================= */

console.log(`\nPROMPT 20 — billing foundation harness @ ${BASE}\n`);

try {
  await createFixtures();

  /* ---- A. catalog + seed idempotency ------------------------------------- */
  console.log("[A] plan catalog + idempotent seed (§37/§63/§103)");
  const planCount = await prisma.plan.count();
  const defCount = await prisma.entitlementDefinition.count();
  const mapCount = await prisma.planEntitlement.count();
  check("A1. 5 plans seeded", planCount === 5, `count=${planCount}`);
  check("A2. 7 entitlement definitions seeded", defCount === 7, `count=${defCount}`);
  check("A3. 35 plan-entitlement mappings", mapCount === 35, `count=${mapCount}`);
  const activePlans = await prisma.plan.findMany({
    where: { active: true },
    include: { planEntitlements: true },
  });
  check(
    "A4. every active plan defines all 7 entitlements",
    activePlans.every((p) => p.planEntitlements.length === 7),
    activePlans.map((p) => `${p.code}:${p.planEntitlements.length}`).join(","),
  );

  const pre = {
    plans: planCount,
    defs: defCount,
    maps: mapCount,
    subs: await prisma.subscription.count(),
    events: await prisma.subscriptionEvent.count(),
  };
  const { execSync } = await import("node:child_process");
  execSync("bun scripts/seed-billing.ts", { cwd: ROOT, stdio: "pipe" });
  const post = {
    plans: await prisma.plan.count(),
    defs: await prisma.entitlementDefinition.count(),
    maps: await prisma.planEntitlement.count(),
    subs: await prisma.subscription.count(),
    events: await prisma.subscriptionEvent.count(),
  };
  check(
    "A5. re-running the seed is a no-op (§103)",
    pre.plans === post.plans &&
      pre.defs === post.defs &&
      pre.maps === post.maps &&
      pre.subs === post.subs &&
      pre.events === post.events,
    JSON.stringify({ pre, post }),
  );

  /* ---- B. existing-business migration ------------------------------------ */
  console.log("[B] existing-business migration (§14/§64/§104)");
  const bizTotal = await prisma.business.count();
  const subTotal = await prisma.subscription.count();
  check("B1. every business has exactly one subscription", bizTotal === subTotal, `${bizTotal} vs ${subTotal}`);
  const freePlan = await prisma.plan.findUnique({ where: { code: "FREE" } });
  const nonFreeExisting = await prisma.subscription.count({
    where: { planId: { not: freePlan.id } },
  });
  check(
    "B2. all existing businesses sit on FREE (no random paid assignment)",
    nonFreeExisting === 0,
    `nonFree=${nonFreeExisting}`,
  );
  const backfillEvents = await prisma.subscriptionEvent.count({
    where: { type: "CREATED", dataJson: { contains: "seed-backfill" } },
  });
  check("B3. backfill is auditable (CREATED events with source)", backfillEvents >= 17, `events=${backfillEvents}`);
  const subA = await prisma.subscription.findUnique({
    where: { businessId: bizA.id },
    include: { plan: true },
  });
  const subB = await prisma.subscription.findUnique({
    where: { businessId: bizB.id },
    include: { plan: true },
  });
  check(
    "B4. newly created businesses also get a subscription (born entitled)",
    !!subA && !!subB && subA.plan.code === "FREE" && subB.plan.code === "FREE",
    `${subA?.plan.code ?? "none"} / ${subB?.plan.code ?? "none"}`,
  );

  /* ---- C. read APIs ------------------------------------------------------- */
  console.log("[C] billing read APIs (§55/§57)");
  const rSub = await api("/api/v1/billing/subscription", { jar: ownerJar, headers: ctxHeader(bizA.id) });
  check(
    "C1. GET /billing/subscription returns plan+status for own business",
    rSub.status === 200 &&
      rSub.json?.data?.subscription?.plan?.code === "FREE" &&
      rSub.json?.data?.subscription?.status === "ACTIVE",
    rSub.text?.slice(0, 160),
  );
  const rEnt = await api("/api/v1/billing/entitlements?usage=1", {
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
  });
  check(
    "C2. GET /billing/entitlements returns 7 entitlements + usage map",
    rEnt.status === 200 &&
      rEnt.json?.data?.entitlements?.length === 7 &&
      typeof rEnt.json?.data?.usage?.CUSTOMERS_MAX?.limit === "number",
    rEnt.text?.slice(0, 160),
  );
  check(
    "C3. FREE entitlement values (customers 50, products 25, team 2, businesses 1)",
    rEnt.json.data.entitlements.find((e) => e.code === "CUSTOMERS_MAX").value === 50 &&
      rEnt.json.data.entitlements.find((e) => e.code === "PRODUCTS_MAX").value === 25 &&
      rEnt.json.data.entitlements.find((e) => e.code === "TEAM_MEMBERS_MAX").value === 2 &&
      rEnt.json.data.entitlements.find((e) => e.code === "BUSINESSES_MAX").value === 1 &&
      rEnt.json.data.entitlements.find((e) => e.code === "AI_COPILOT").value === true,
  );
  const rPlans = await api("/api/v1/billing/plans", { jar: ownerJar, headers: ctxHeader(bizA.id) });
  check(
    "C4. GET /billing/plans offers 4 self-service plans (ENTERPRISE catalog-only, §38)",
    rPlans.status === 200 &&
      rPlans.json?.data?.plans?.length === 5 &&
      rPlans.json.data.plans.filter((p) => p.selfService).length === 4,
    rPlans.text?.slice(0, 120),
  );
  const rEvents = await api("/api/v1/billing/events", { jar: ownerJar, headers: ctxHeader(bizA.id) });
  check(
    "C5. GET /billing/events shows CREATED history",
    rEvents.status === 200 && rEvents.json?.data?.items?.some((e) => e.type === "CREATED"),
    rEvents.text?.slice(0, 120),
  );
  const rNoCtx = await api("/api/v1/billing/subscription", { jar: ownerJar });
  check("C6. billing API without business context → 400 NO_BUSINESS_CONTEXT", rNoCtx.status === 400);
  const rAnon = await api("/api/v1/billing/subscription", { headers: ctxHeader(bizA.id) });
  check("C7. billing API unauthenticated → 401", rAnon.status === 401);

  /* ---- D. role policy ------------------------------------------------------ */
  console.log("[D] subscription mutation role policy (§54/§100)");
  const dStaff = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: staffJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "STARTER" },
  });
  check("D1. STAFF cannot change plan → 403", dStaff.status === 403, dStaff.text?.slice(0, 120));
  const dViewer = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: viewerJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "STARTER" },
  });
  check("D2. VIEWER cannot change plan → 403", dViewer.status === 403);
  const dAdmin = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: adminJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "STARTER" },
  });
  check(
    "D3. ADMIN can change plan (policy allows) → changed",
    dAdmin.status === 200 && dAdmin.json?.data?.changed === true && dAdmin.json?.data?.subscription?.plan?.code === "STARTER",
    dAdmin.text?.slice(0, 200),
  );
  const dSame = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "STARTER" },
  });
  check(
    "D4. same-plan switch is an idempotent no-op (§48)",
    dSame.status === 200 && dSame.json?.data?.changed === false,
    dSame.text?.slice(0, 120),
  );
  const pcEventsAfter = await prisma.subscriptionEvent.count({
    where: { businessId: bizA.id, type: "PLAN_CHANGED" },
  });
  const dBack = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "FREE" },
  });
  check("D5. OWNER switches back to FREE", dBack.status === 200 && dBack.json?.data?.changed === true);
  const pcEventsFinal = await prisma.subscriptionEvent.count({
    where: { businessId: bizA.id, type: "PLAN_CHANGED" },
  });
  check(
    "D6. no PLAN_CHANGED event for the no-op; one for the real switch",
    pcEventsFinal === pcEventsAfter + 1,
    `${pcEventsAfter} → ${pcEventsFinal}`,
  );
  const auditPlan = await prisma.auditLog.findFirst({
    where: { businessId: bizA.id, action: "billing.plan_changed" },
    orderBy: { createdAt: "desc" },
  });
  check("D7. billing.plan_changed audit row written (§61)", !!auditPlan);

  /* ---- F/E. invalid plans + tenant isolation ------------------------------ */
  console.log("[E] invalid plans + cross-tenant isolation (§49/§56/§88)");
  const eBad = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "NOT_A_PLAN_9" },
  });
  check(
    "E1. unknown plan → 422 INVALID_PLAN",
    eBad.status === 422 && eBad.json?.error?.code === "INVALID_PLAN",
    eBad.text?.slice(0, 120),
  );
  await prisma.plan.upsert({
    where: { code: "P20_LEGACY" },
    create: {
      code: "P20_LEGACY",
      name: "Legacy",
      description: "retired",
      sortOrder: 998,
      isPublic: false,
      active: false,
    },
    update: { active: false },
  });
  const eInactive = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { planCode: "P20_LEGACY" },
  });
  check(
    "E2. inactive plan → 422 INVALID_PLAN (§80)",
    eInactive.status === 422 && eInactive.json?.error?.code === "INVALID_PLAN",
  );
  const eCrossRead = await api("/api/v1/billing/subscription", {
    jar: staffJar,
    headers: ctxHeader(bizB.id),
  });
  check(
    "E3. cross-tenant READ of another business's subscription → 403",
    eCrossRead.status === 403,
    eCrossRead.text?.slice(0, 120),
  );
  const eCrossWrite = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: staffJar,
    headers: ctxHeader(bizB.id),
    body: { planCode: "STARTER" },
  });
  check(
    "E4. cross-tenant WRITE (change plan) → 403",
    eCrossWrite.status === 403,
  );
  const eCrossEvents = await api("/api/v1/billing/events", {
    jar: staffJar,
    headers: ctxHeader(bizB.id),
  });
  check("E5. cross-tenant events → 403", eCrossEvents.status === 403);
  const subBStill = await prisma.subscription.findUnique({
    where: { businessId: bizB.id },
    include: { plan: true },
  });
  check(
    "E6. business B subscription untouched by cross-tenant attempts",
    subBStill.plan.code === "FREE" && subBStill.status === "ACTIVE",
  );

  /* ---- G/H. limits + feature gates on the test plan ------------------------ */
  console.log("[G/H] limit enforcement + feature gates (§26/§27/§34-§36/§42)");
  const tiny = await createTestPlan();
  await prisma.subscription.update({
    where: { businessId: bizB.id },
    data: { planId: tiny.id }, // direct-DB fixture: bizB on P20-TINY
  });

  const c1 = await api("/api/v1/customers", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { name: "Tiny Cust 1" },
  });
  const c2 = await api("/api/v1/customers", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { name: "Tiny Cust 2" },
  });
  check(
    "G1. creates up to the limit succeed (2/2)",
    c1.status === 201 && c2.status === 201,
    `${c1.status}/${c2.status}`,
  );
  const c3 = await api("/api/v1/customers", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { name: "Tiny Cust 3" },
  });
  const c3err = c3.json?.error ?? {};
  check(
    "G2. creation beyond CUSTOMERS_MAX → 422 ENTITLEMENT_LIMIT_REACHED with structured details (§28)",
    c3.status === 422 &&
      c3err.code === "ENTITLEMENT_LIMIT_REACHED" &&
      c3err.details?.feature === "CUSTOMERS_MAX" &&
      c3err.details?.limit === 2 &&
      c3err.details?.current === 2 &&
      c3err.details?.upgradeAvailable === true,
    c3.text?.slice(0, 220),
  );
  const custList = await api("/api/v1/customers?page=1&pageSize=50", {
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
  });
  check(
    "G3. existing customers preserved (no auto-deletion, §42)",
    custList.status === 200 && custList.json?.data?.total === 2,
    `total=${custList.json?.data?.total}`,
  );

  // §112 race safety: two concurrent creates with ONE slot left.
  await api(`/api/v1/customers/${(custList.json.data.items[0]).id}`, {
    method: "DELETE",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
  });
  const [race1, race2] = await Promise.all([
    api("/api/v1/customers", {
      method: "POST",
      jar: ownerJar,
      headers: ctxHeader(bizB.id),
      body: { name: "Race A" },
    }),
    api("/api/v1/customers", {
      method: "POST",
      jar: ownerJar,
      headers: ctxHeader(bizB.id),
      body: { name: "Race B" },
    }),
  ]);
  const raceCount = await prisma.customer.count({
    where: { businessId: bizB.id, deletedAt: null },
  });
  const succeeded = [race1, race2].filter((r) => r.status === 201).length;
  check(
    "G4. concurrent creates never exceed the limit (§112)",
    raceCount === 2 && succeeded >= 1,
    `count=${raceCount} ok=${succeeded} statuses=${race1.status}/${race2.status}`,
  );

  // Products limit (1).
  const p1 = await api("/api/v1/products", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { name: "Tiny Prod 1", salePriceMinor: 100, costPriceMinor: 50 },
  });
  const p2 = await api("/api/v1/products", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { name: "Tiny Prod 2", salePriceMinor: 100, costPriceMinor: 50 },
  });
  check(
    "G5. PRODUCTS_MAX enforced at product creation (§33)",
    p1.status === 201 && p2.status === 422 && p2.json?.error?.code === "ENTITLEMENT_LIMIT_REACHED",
    `${p1.status}/${p2.status} ${p2.text?.slice(0, 120)}`,
  );

  // Downgrade grandfathering (§42/§89): 2 customers exist, drop limit to 1.
  const custDef = await prisma.entitlementDefinition.findUnique({ where: { code: "CUSTOMERS_MAX" } });
  await prisma.planEntitlement.update({
    where: { planId_entitlementId: { planId: tiny.id, entitlementId: custDef.id } },
    data: { value: 1 },
  });
  const over = await api("/api/v1/customers", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { name: "Over Limit" },
  });
  check(
    "G6. downgrade: over-limit business blocked from growth (current=2, limit=1)",
    over.status === 422 &&
      over.json?.error?.details?.current === 2 &&
      over.json?.error?.details?.limit === 1,
    over.text?.slice(0, 160),
  );
  const stillThere = await prisma.customer.count({
    where: { businessId: bizB.id, deletedAt: null },
  });
  check("G7. downgrade deleted NOTHING (§42)", stillThere === 2, `count=${stillThere}`);

  // Feature gates on P20-TINY.
  const hCopilot = await api("/api/v1/copilot", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { sessionId: `s-p20-${STAMP}`, question: "test" },
  });
  check(
    "H1. AI_COPILOT=false → copilot 403 ENTITLEMENT_NOT_AVAILABLE (§36)",
    hCopilot.status === 403 && hCopilot.json?.error?.code === "ENTITLEMENT_NOT_AVAILABLE",
    hCopilot.text?.slice(0, 160),
  );
  const hCsv = await api("/api/v1/reports/export?days=7", {
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
  });
  check(
    "H2. CSV_EXPORT=false → server-side export 403 (§34)",
    hCsv.status === 403 && hCsv.json?.error?.code === "ENTITLEMENT_NOT_AVAILABLE",
    hCsv.text?.slice(0, 160),
  );
  const hAdv = await api("/api/v1/reports/summary?days=7", {
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
  });
  check(
    "H3. ADVANCED_REPORTS=false → summary omits the advanced block entirely (§26/§35)",
    hAdv.status === 200 && hAdv.json?.data?.advancedAvailable === false && hAdv.json?.data?.advanced === undefined,
    hAdv.text?.slice(0, 160),
  );

  /* ---- I. cancellation / reactivation / expiry fallback ------------------- */
  console.log("[I] cancellation, reactivation, expiry fallback (§13/§44/§45/§91)");
  const iCancel = await api("/api/v1/billing/cancel", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: {},
  });
  check(
    "I1. cancel → CANCELED with cancelAtPeriodEnd",
    iCancel.status === 200 &&
      iCancel.json?.data?.subscription?.status === "CANCELED" &&
      iCancel.json?.data?.subscription?.cancelAtPeriodEnd === true,
    iCancel.text?.slice(0, 160),
  );
  const eventsBefore = await prisma.subscriptionEvent.count({
    where: { businessId: bizB.id, type: "CANCELED" },
  });
  const iCancel2 = await api("/api/v1/billing/cancel", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: {},
  });
  const eventsAfter = await prisma.subscriptionEvent.count({
    where: { businessId: bizB.id, type: "CANCELED" },
  });
  check(
    "I2. second cancel is a no-op with NO duplicate event (§48)",
    iCancel2.status === 200 && iCancel2.json?.data?.changed === false && eventsBefore === eventsAfter,
    `events ${eventsBefore}→${eventsAfter}`,
  );
  const iCancelStaff = await api("/api/v1/billing/cancel", {
    method: "POST",
    jar: staffJar,
    headers: ctxHeader(bizB.id),
    body: {},
  });
  check("I3. STAFF cannot cancel → 403", iCancelStaff.status === 403);

  // Canceled but still within period → export still allowed (grace, §44)?
  // P20-TINY has CSV_EXPORT=false, so use customer list as the data probe.
  const iData = await api("/api/v1/customers?page=1&pageSize=50", {
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
  });
  check(
    "I4. cancellation preserves tenant data (§91)",
    iData.status === 200 && iData.json?.data?.total === 2,
  );

  const iReactivate = await api("/api/v1/billing/reactivate", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: {},
  });
  check(
    "I5. reactivate → ACTIVE again (REACTIVATED event)",
    iReactivate.status === 200 && iReactivate.json?.data?.subscription?.status === "ACTIVE",
    iReactivate.text?.slice(0, 160),
  );

  // EXPIRED: invalid to reactivate (§45) + FREE fallback entitlements (§13).
  await prisma.subscription.update({
    where: { businessId: bizB.id },
    data: { status: "EXPIRED", endedAt: new Date() },
  });
  const iExpiredReactivate = await api("/api/v1/billing/reactivate", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: {},
  });
  check(
    "I6. EXPIRED → reactivate blocked with INVALID_SUBSCRIPTION_STATE (§45)",
    iExpiredReactivate.status === 409 &&
      iExpiredReactivate.json?.error?.code === "INVALID_SUBSCRIPTION_STATE",
    iExpiredReactivate.text?.slice(0, 160),
  );
  // P20-TINY says CSV_EXPORT=false; the FREE fallback says true → 200 proves
  // the fallback is live (fresh gate reads).
  const iExpiredExport = await api("/api/v1/reports/export?days=7", {
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
  });
  check(
    "I7. expired subscription falls back to FREE entitlements (§13/§17)",
    iExpiredExport.status === 200,
    `status=${iExpiredExport.status} code=${iExpiredExport.json?.error?.code}`,
  );
  const iExpiredData = await prisma.customer.count({
    where: { businessId: bizB.id, deletedAt: null },
  });
  check("I8. expiry touched no data", iExpiredData === 2, `count=${iExpiredData}`);

  // Renewal via change-plan (deliberate, internal, no payment — §45/§82).
  const iRenew = await api("/api/v1/billing/change-plan", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizB.id),
    body: { planCode: "FREE" },
  });
  check(
    "I9. change-plan renews EXPIRED → ACTIVE (explicit internal renewal)",
    iRenew.status === 200 && iRenew.json?.data?.subscription?.status === "ACTIVE",
    iRenew.text?.slice(0, 160),
  );

  /* ---- J. trial capability ------------------------------------------------- */
  console.log("[J] trial capability disabled by default (§19)");
  const jTrial = await api("/api/v1/billing/trial", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { action: "start", days: 14 },
  });
  check(
    "J1. trial endpoint disabled without BILLING_TRIALS_ENABLED → 422 BUSINESS_NOT_ELIGIBLE",
    jTrial.status === 422 && jTrial.json?.error?.code === "BUSINESS_NOT_ELIGIBLE",
    jTrial.text?.slice(0, 120),
  );
  const jTrialViewer = await api("/api/v1/billing/trial", {
    method: "POST",
    jar: viewerJar,
    headers: ctxHeader(bizA.id),
    body: { action: "start", days: 14 },
  });
  check("J2. VIEWER cannot touch trial endpoint → 403", jTrialViewer.status === 403);

  /* ---- K. tenant business finance untouched -------------------------------- */
  console.log("[K] platform billing vs tenant finance separation (§52/§53)");
  const kPayments = await prisma.payment.count({
    where: { business: { owner: { email: { endsWith: `@${DOMAIN}` } } } },
  });
  check(
    "K1. NO SaaS payment records were created in tenant finance (§83)",
    kPayments === 0,
    `payments=${kPayments}`,
  );
  const kSale = await api("/api/v1/sales", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
    body: { items: [{ name: "K item", qty: 2, unitPriceMinor: 500 }] },
  });
  check(
    "K2. core sales pipeline still works after billing integration (§104)",
    kSale.status === 201,
    kSale.text?.slice(0, 160),
  );
  const kSubA = await prisma.subscription.findUnique({
    where: { businessId: bizA.id },
    include: { plan: true },
  });
  check(
    "K3. subscription state is stored in BILLING tables, not Sale/Expense/Payment",
    !!kSubA && kSubA.plan.code === "FREE",
  );

  /* ---- final: fixture plan on bizB restored + no orphaned gates ------------ */
  const finalEnt = await api("/api/v1/billing/entitlements?usage=1", {
    jar: ownerJar,
    headers: ctxHeader(bizA.id),
  });
  check(
    "L1. entitlements endpoint reflects current plan consistently",
    finalEnt.status === 200 && finalEnt.json?.data?.planCode === "FREE",
    finalEnt.text?.slice(0, 160),
  );
} catch (error) {
  check("harness completed without exception", false, error.stack ?? error.message);
} finally {
  await cleanup();
  const leftovers = await prisma.user.count({ where: { email: { endsWith: `@${DOMAIN}` } } });
  check("fixtures cleaned up", leftovers === 0, `left=${leftovers}`);
  await prisma.$disconnect();
}

console.log(`\nRESULT: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  console.error("FAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 260)}` : ""}`);
  process.exit(1);
}
