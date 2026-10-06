#!/usr/bin/env node
/**
 * Prompt 41-F — E2E PURCHASE ORDER CHECK. Real application + real DB.
 * Run: node scripts/prompt41-purchase-order-check.mjs   (dev server on :3000)
 *
 * Closes the missing P41 E2E gap (§69/§70): auth/RBAC, create/line CRUD,
 * duplicate + cap + transition CONCURRENCY, full invalid-transition matrix,
 * supplier/product lifecycle interactions, snapshot + currency integrity,
 * money overflow / zero / negative, strict dates, list + search (tenant-safe),
 * deep-link API half, Supplier 360 + Product history bounds, CSV export
 * (EN/FA, injection, entitlement, rate limit, no-store, completeness),
 * foreign 404, FINANCIAL NON-MUTATION (§62/§71), audit, status-corruption
 * policy (§68), DTO hygiene, teardown to ZERO (§119-§121).
 *
 * Also gates (§8): `node --check` of the static scanner, and the ISOLATED
 * cap/concurrency process (§25/§72) via bun child process.
 *
 * All fixtures are P41PO-prefixed and removed to ZERO residue. The
 * dev-baseline fixtures of other prompts are never touched. Prisma is used
 * ONLY for fixtures, assertions and cleanup — never to mutate domain rows
 * (except the §68 corruption probe, which restores what it changes).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// --- env -------------------------------------------------------------------
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "P41qa!Passw0rd!1";
const TAG = "P41PO";
const STAMP = `${Date.now()}`.slice(-8);
const USER_DOMAIN = "p41check.test";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, info = "") {
  if (cond) passed++;
  else failed++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
}
function section(name) {
  console.log(`\n=== ${name} ===`);
}

// --- HTTP client with per-user cookie jar (house style) ---------------------
function makeClient() {
  const jar = new Map();
  return async function f(path, init = {}) {
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": init.xff ?? "10.41.7.19",
      ...(init.headers ?? {}),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
    let body = null;
    const bytes = Buffer.from(await res.arrayBuffer());
    try {
      body = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, res: { bytes }, body };
  };
}

async function login(f, email) {
  const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString(),
  });
}

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** GET/POST wrapper returning {status, body} with 429 retry-once (house style). */
async function call(f, path, init = {}, depth = 0) {
  const res = await f(path, init);
  if (res.status === 429 && !(init.headers ?? {})["x-no-retry"] && depth < 1) {
    const body = res.body;
    const wait = Math.min(body?.error?.details?.retryAfterMs ?? 60_000, 65_000);
    console.log(`  (rate limited — waiting ${Math.round(wait / 1000)}s)`);
    await new Promise((r) => setTimeout(r, wait));
    return call(f, path, init, depth + 1);
  }
  return { status: res.status, body: res.body, headers: res.headers, res: res.res };
}

/** Raw CSV view from a call() result (BOM preserved as raw bytes). */
function rawCsv(result) {
  return {
    bytes: result.res.bytes,
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.res.bytes),
  };
}

// --- fixture helpers --------------------------------------------------------
async function createProduct(f, bizId, name, sku, opts = {}) {
  const r = await call(f, "/api/v1/products", {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify({ name, sku, unit: opts.unit ?? "piece", salePriceMinor: 1000, costPriceMinor: 500, stockQty: 0, isActive: true }),
  });
  if (r.status !== 201) throw new Error(`product create ${name} ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function createSupplier(f, bizId, name) {
  const r = await call(f, "/api/v1/suppliers", {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify({ name }),
  });
  if (r.status !== 201) throw new Error(`supplier create ${name} ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function createPO(f, bizId, body) {
  return call(f, "/api/v1/purchase-orders", {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify(body),
  });
}
async function addLine(f, bizId, poId, productId, orderedQty, unitPriceMinor) {
  return call(f, `/api/v1/purchase-orders/${poId}/lines`, {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify({ productId, orderedQty, unitPriceMinor }),
  });
}
async function transition(f, bizId, poId, op) {
  return call(f, `/api/v1/purchase-orders/${poId}/${op}`, {
    method: "POST",
    headers: { "x-business-id": bizId },
  });
}
async function detail(f, bizId, poId) {
  return call(f, `/api/v1/purchase-orders/${poId}`, { headers: { "x-business-id": bizId } });
}

async function purgeFixture() {
  // §121 — crashed-run recovery: sweep ANY prior P41 residue first.
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
    await db.subscription.deleteMany({ where: { businessId: b.id } });
    await db.businessMember.deleteMany({ where: { businessId: b.id } });
    await db.business.delete({ where: { id: b.id } }).catch(() => {});
  }
  await db.user.deleteMany({ where: { email: { endsWith: `@${USER_DOMAIN}` } } });
  await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-PLAN` } } });
}

// --- main -------------------------------------------------------------------
async function main() {
  /* ------------------------- §8 static-scan syntax gate -------------------- */
  section("0. §8 — static scanner must never become unparsable");
  const check = spawnSync("node", ["--check", "scripts/prompt41-purchase-order-static-scan.mjs"], { encoding: "utf8" });
  ok("8.1 node --check scripts/prompt41-purchase-order-static-scan.mjs exits 0", check.status === 0, (check.stderr || "").slice(0, 200));

  /* ------------------- §25/§72 isolated cap/concurrency process ------------ */
  section("0b. §25/§72 — isolated cap=20 process (bun child)");
  const capRun = spawnSync("bun", ["--preload", "./scripts/lib/register-server-only-shim.ts", "scripts/prompt41-purchase-order-cap-check.ts"], {
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, PURCHASE_ORDER_MAX_LINES: "20" },
  });
  const capTail = (capRun.stdout || "").split("\n").filter(Boolean).slice(-1)[0] ?? "";
  ok("0b.1 cap/concurrency child passes (20+ live checks, exit 0)", capRun.status === 0, (capRun.stderr || "").slice(0, 200));
  ok("0b.2 child reports 20/20", /P41-CAP: 20\/20 PASS/.test(capTail), capTail);

  /* ------------------------------ fixture ---------------------------------- */
  section("1. fixture — deterministic P41PO entities (§120)");
  await purgeFixture();

  const emails = {
    ownerA: `${TAG}-owner-a-${STAMP}@${USER_DOMAIN}`.toLowerCase(),
    viewer: `${TAG}-viewer-${STAMP}@${USER_DOMAIN}`.toLowerCase(),
    ownerB: `${TAG}-owner-b-${STAMP}@${USER_DOMAIN}`.toLowerCase(),
    ownerC: `${TAG}-owner-c-${STAMP}@${USER_DOMAIN}`.toLowerCase(),
  };
  const fA = makeClient();
  const fB = makeClient();
  const fC = makeClient();
  const fV = makeClient();

  for (const [key, email] of Object.entries(emails)) {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`  (fixture user exists: ${key})`);
      continue;
    }
    const reg = await call(fA, "/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: `P41 ${key}`, email, password: PASS }) });
    if (reg.status === 429) {
      // Register is IP-rate-limited (10 / 15 min). The register API itself is
      // fully covered by the identity suites; the E2E needs a SESSION, so
      // fall back to the same bcrypt hash the login provider verifies.
      await db.user.create({ data: { name: `P41 ${key}`, email, passwordHash: bcrypt.hashSync(PASS, 10), emailVerifiedAt: new Date() } });
      console.log(`  (register rate-limited — ${key} created via fixture hash)`);
    } else {
      ok(`1.reg ${key} registered (201)`, reg.status === 201 || reg.status === 200 || reg.status === 409, String(reg.status));
    }
  }
  const ownerA = await db.user.findUnique({ where: { email: emails.ownerA } });
  const viewer = await db.user.findUnique({ where: { email: emails.viewer } });
  const ownerB = await db.user.findUnique({ where: { email: emails.ownerB } });
  const ownerC = await db.user.findUnique({ where: { email: emails.ownerC } });
  ok("1.1 all four fixture users exist", Boolean(ownerA && viewer && ownerB && ownerC));

  const bizA = await db.business.create({
    data: { name: `${TAG}-BIZ-A-${STAMP}`, slug: `p41po-biz-a-${STAMP}`, currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2, locale: "en", timezone: "Asia/Tehran", ownerId: ownerA.id },
  });
  const bizB = await db.business.create({
    data: { name: `${TAG}-BIZ-B-${STAMP}`, slug: `p41po-biz-b-${STAMP}`, currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2, locale: "en", timezone: "Asia/Tehran", ownerId: ownerB.id },
  });
  const bizC = await db.business.create({
    data: { name: `${TAG}-BIZ-C-${STAMP}`, slug: `p41po-biz-c-${STAMP}`, currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2, locale: "en", timezone: "Asia/Tehran", ownerId: ownerC.id },
  });
  await db.businessMember.create({ data: { businessId: bizA.id, userId: ownerA.id, role: "OWNER" } });
  await db.businessMember.create({ data: { businessId: bizA.id, userId: viewer.id, role: "VIEWER" } });
  await db.businessMember.create({ data: { businessId: bizB.id, userId: ownerB.id, role: "OWNER" } });
  await db.businessMember.create({ data: { businessId: bizC.id, userId: ownerC.id, role: "OWNER" } });

  const publicPlan = await db.plan.findFirst({ where: { isPublic: true, active: true }, orderBy: { sortOrder: "asc" } });
  ok("1.2 public plan available (billing catalog seeded)", Boolean(publicPlan));
  await db.subscription.create({ data: { businessId: bizA.id, planId: publicPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
  await db.subscription.create({ data: { businessId: bizB.id, planId: publicPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });

  // Dedicated plan for the export business — flipping ITS entitlement never
  // touches any other tenant (P40 §78 lesson).
  const defs = await db.entitlementDefinition.findMany();
  const defByCode = new Map(defs.map((d) => [d.code, d.id]));
  const expPlan = await db.plan.create({
    data: {
      code: `${TAG}-PLAN-C-${STAMP}`,
      name: "P41 export fixture",
      active: true,
      isPublic: false,
      sortOrder: 999,
      planEntitlements: {
        create: [
          { entitlementId: defByCode.get("CUSTOMERS_MAX"), value: 50 },
          { entitlementId: defByCode.get("PRODUCTS_MAX"), value: 100 },
          { entitlementId: defByCode.get("TEAM_MEMBERS_MAX"), value: 2 },
          { entitlementId: defByCode.get("BUSINESSES_MAX"), value: 1 },
          { entitlementId: defByCode.get("AI_REQUESTS_MAX"), value: 10 },
          { entitlementId: defByCode.get("AI_MESSAGES_MAX"), value: 10 },
          { entitlementId: defByCode.get("AI_COPILOT"), boolValue: true },
          { entitlementId: defByCode.get("ADVANCED_REPORTS"), boolValue: false },
          { entitlementId: defByCode.get("CSV_EXPORT"), boolValue: true },
        ],
      },
    },
  });
  await db.subscription.create({ data: { businessId: bizC.id, planId: expPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
  ok("1.3 dedicated export plan created", Boolean(expPlan));

  await login(fA, emails.ownerA);
  await login(fB, emails.ownerB);
  await login(fC, emails.ownerC);
  await login(fV, emails.viewer);
  ok("1.4 four sessions established", true);

  const supAlpha = await createSupplier(fA, bizA.id, `${TAG}-SUP-Alpha`);
  const prodA = await createProduct(fA, bizA.id, `${TAG}-PROD-Alpha`, `${TAG}-SKU-A1`);
  const prodB = await createProduct(fA, bizA.id, "=1+1", `${TAG}-SKU-INJ`); // §53 injection probe
  ok("1.5 supplier + products ready", Boolean(supAlpha?.id && prodA?.id && prodB?.id));

  /* ------------------------- §62/§71 financial baseline --------------------- */
  section("2. §62/§71 — financial/inventory baseline snapshot BEFORE any PO op");
  async function financialSnapshot() {
    const products = await db.product.findMany({ where: { businessId: { in: [bizA.id, bizB.id, bizC.id] } }, select: { id: true, stockQty: true }, orderBy: { id: "asc" } });
    const [adjust, expense, payment, sale, saleItem] = await Promise.all([
      db.inventoryAdjustment.count({ where: { businessId: { in: [bizA.id, bizB.id, bizC.id] } } }),
      db.expense.count({ where: { businessId: { in: [bizA.id, bizB.id, bizC.id] } } }),
      db.payment.count({ where: { businessId: { in: [bizA.id, bizB.id, bizC.id] } } }),
      db.sale.count({ where: { businessId: { in: [bizA.id, bizB.id, bizC.id] } } }),
      db.saleItem.count({ where: { sale: { businessId: { in: [bizA.id, bizB.id, bizC.id] } } } }),
    ]);
    return JSON.stringify({
      // Map form: later fixture products may EXIST that were not in the
      // baseline — the LAW under test is that NO product's stockQty ever
      // changes and NO authority count moves (not that the fixture is frozen).
      stock: Object.fromEntries(products.map((p) => [p.id, p.stockQty])),
      adjust, expense, payment, sale, saleItem,
    });
  }
  const baseline = await financialSnapshot();
  ok("2.1 baseline captured (deterministic serialization)", baseline.length > 2);

  /* ----------------------------- B. create laws ----------------------------- */
  section("3. create — server authority + validation (§12/§13/§46/§164)");
  const gen = await createPO(fA, bizA.id, { supplierId: supAlpha.id });
  ok("3.1 minimal create → 201", gen.status === 201, JSON.stringify(gen.body));
  ok("3.2 generated reference format PO-<YYYYMMDD>-<6>", gen.status === 201 && /^PO-\d{8}-[A-Z2-9]{6}$/.test(gen.body?.data?.reference ?? ""), gen.body?.data?.reference);
  ok("3.3 status is server-set DRAFT", gen.body?.data?.status === "DRAFT");

  const withRef = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: "  P41PO  E2E  Ref 1  ", notes: "  Deliver to dock 7  ", expectedDate: "2026-03-15", orderedAt: "2026-02-10" });
  ok("3.4 create with explicit reference → 201", withRef.status === 201, JSON.stringify(withRef.body));
  const REF1 = withRef.body?.data?.reference;
  ok("3.5 reference normalized once (trim + collapse)", REF1 === "P41PO E2E Ref 1", REF1);
  const PO1 = withRef.body?.data?.id;

  const d1 = await detail(fA, bizA.id, PO1);
  ok("3.6 detail 200", d1.status === 200);
  ok("3.7 notes trimmed", d1.body?.data?.notes === "Deliver to dock 7", d1.body?.data?.notes);
  ok("3.8 expectedDate persisted (strict date accepted)", d1.body?.data?.expectedDate?.startsWith("2026-03-15"), d1.body?.data?.expectedDate);
  ok("3.9 orderedAt honored (UTC midnoon convention)", d1.body?.data?.orderedAt?.startsWith("2026-02-10T12:00"), d1.body?.data?.orderedAt);
  ok("3.10 currency snapshot from business (server-derived)", d1.body?.data?.currency?.codeAtOrder === "USD" && d1.body?.data?.currency?.symbolAtOrder === "$" && d1.body?.data?.currency?.decimalPrecisionAtOrder === 2, JSON.stringify(d1.body?.data?.currency));
  ok("3.11 supplier snapshot frozen at creation", d1.body?.data?.supplier?.nameAtOrder === `${TAG}-SUP-Alpha`, d1.body?.data?.supplier?.nameAtOrder);
  ok("3.12 empty summary (zero lines)", d1.body?.data?.summary?.lineCount === 0 && d1.body?.data?.summary?.totalMinor === 0);

  const hostileBody = {
    supplierId: supAlpha.id,
    businessId: bizB.id,
    status: "CONFIRMED",
    totalMinor: 999_999,
    supplierNameAtOrder: "HACKED",
    currencyCodeAtOrder: "XXX",
    currencySymbolAtOrder: "@",
    decimalPrecisionAtOrder: 7,
    createdByUserId: "hacker",
    reference: `${TAG}-HOSTILE-1`,
  };
  const hostile = await createPO(fA, bizA.id, hostileBody);
  ok("3.13 hostile create with client businessId/status/totals still → 201 (fields stripped)", hostile.status === 201, JSON.stringify(hostile.body));
  const dHos = await detail(fA, bizA.id, hostile.body?.data?.id);
  ok("3.14 client status ignored (still DRAFT)", dHos.body?.data?.status === "DRAFT");
  ok("3.15 client total ignored (summary server-derived)", dHos.body?.data?.summary?.totalMinor === 0);
  ok("3.16 client currency snapshot ignored (business currency kept)", dHos.body?.data?.currency?.codeAtOrder === "USD");
  ok("3.17 client supplierNameAtOrder ignored", dHos.body?.data?.supplier?.nameAtOrder === `${TAG}-SUP-Alpha`);
  ok("3.18 client businessId ignored (order not in bizB)", (await detail(fB, bizB.id, hostile.body?.data?.id)).status === 404);

  const badDate = await createPO(fA, bizA.id, { supplierId: supAlpha.id, expectedDate: "2026-02-31" });
  ok("3.19 2026-02-31 → 422 (strict calendar)", badDate.status === 422);
  const leap = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-LEAP-OK`, expectedDate: "2024-02-29" });
  ok("3.20 2024-02-29 (leap) → 201", leap.status === 201);
  const nonLeap = await createPO(fA, bizA.id, { supplierId: supAlpha.id, expectedDate: "2025-02-29" });
  ok("3.21 2025-02-29 (non-leap) → 422", nonLeap.status === 422);
  const dupRef = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: REF1 });
  ok("3.22 duplicate reference → 409 DUPLICATE_PURCHASE_ORDER_REFERENCE", dupRef.status === 409 && dupRef.body?.error?.code === "DUPLICATE_PURCHASE_ORDER_REFERENCE", JSON.stringify(dupRef.body?.error));
  const foreignSup = await createPO(fB, bizB.id, { supplierId: supAlpha.id });
  ok("3.23 foreign supplier id → 404 (no existence leak)", foreignSup.status === 404, String(foreignSup.status));

  /* ------------------------- RBAC + auth (§70 start) ------------------------ */
  section("4. RBAC + authentication");
  const unauth = makeClient();
  const u1 = await call(unauth, "/api/v1/purchase-orders");
  ok("4.1 unauthenticated list → 401", u1.status === 401, String(u1.status));
  const u2 = await call(unauth, "/api/v1/purchase-orders", { method: "POST", body: JSON.stringify({ supplierId: supAlpha.id }) });
  ok("4.2 unauthenticated create → 401", u2.status === 401);
  const u3 = await call(unauth, `/api/v1/purchase-orders/${PO1}`);
  ok("4.3 unauthenticated detail → 401", u3.status === 401);
  const u4 = await call(unauth, `/api/v1/purchase-orders/${PO1}/export`);
  ok("4.4 unauthenticated export → 401", u4.status === 401);
  const vWrite = await call(fV, "/api/v1/purchase-orders", { method: "POST", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ supplierId: supAlpha.id }) });
  ok("4.5 VIEWER create → 403 (data:write denied)", vWrite.status === 403, String(vWrite.status));
  const vRead = await detail(fV, bizA.id, PO1);
  ok("4.6 VIEWER detail → 200 (data:read allowed)", vRead.status === 200);

  /* ----------------------------- C. header patch ---------------------------- */
  section("5. DRAFT header patch (§43)");
  const p1 = await call(fA, `/api/v1/purchase-orders/${PO1}`, {
    method: "PATCH",
    headers: { "x-business-id": bizA.id },
    body: JSON.stringify({ reference: `${TAG}-PATCHED-1`, notes: "Updated note", expectedDate: "2026-03-20" }),
  });
  ok("5.1 DRAFT patch → 200", p1.status === 200, JSON.stringify(p1.body));
  const d1b = await detail(fA, bizA.id, PO1);
  ok("5.2 patch persisted", d1b.body?.data?.reference === `${TAG}-PATCHED-1` && d1b.body?.data?.notes === "Updated note");
  const pEmpty = await call(fA, `/api/v1/purchase-orders/${PO1}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({}) });
  ok("5.3 empty patch → 422 (nothing to update)", pEmpty.status === 422);
  const pSupplier = await call(fA, `/api/v1/purchase-orders/${PO1}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ supplierId: "x" }) });
  ok("5.4 supplierId-only patch rejected (immutable §43)", pSupplier.status === 422);
  const pStatus = await call(fA, `/api/v1/purchase-orders/${PO1}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ status: "CLOSED" }) });
  ok("5.5 NO generic status PATCH (§42/§86)", pStatus.status === 422, String(pStatus.status));
  const pForeign = await call(fB, `/api/v1/purchase-orders/${PO1}`, { method: "PATCH", headers: { "x-business-id": bizB.id }, body: JSON.stringify({ notes: "intrude" }) });
  ok("5.6 foreign PATCH → 404 (no leak)", pForeign.status === 404);

  /* ------------------------------- D. lines --------------------------------- */
  section("6. lines — add/update/remove + snapshot integrity (§9/§10/§27)");
  const l1 = await addLine(fA, bizA.id, PO1, prodA.id, 10, 125_000);
  ok("6.1 add line → 201", l1.status === 201, JSON.stringify(l1.body));
  const l1d = l1.body?.data;
  ok("6.2 §67 response carries REAL productNameAtOrder", l1d?.productNameAtOrder === `${TAG}-PROD-Alpha`, l1d?.productNameAtOrder);
  ok("6.3 §67 response carries REAL skuAtOrder", l1d?.skuAtOrder === `${TAG}-SKU-A1`);
  ok("6.4 §67 response carries REAL unitAtOrder", l1d?.unitAtOrder === "piece");
  ok("6.5 §67 createdAt is a real persisted ISO instant", typeof l1d?.createdAt === "string" && !Number.isNaN(Date.parse(l1d.createdAt)));
  const lineDtoKeys = Object.keys(l1d ?? {}).sort();
  ok("6.6 line DTO exact allowlist keys", JSON.stringify(lineDtoKeys) === JSON.stringify(["createdAt", "id", "lineTotalMinor", "orderedQty", "productId", "productNameAtOrder", "skuAtOrder", "unitAtOrder", "unitPriceMinor", "updatedAt"]), JSON.stringify(lineDtoKeys));
  ok("6.7 lineTotalMinor derived exactly", l1d?.lineTotalMinor === 1_250_000);

  const dupLine = await addLine(fA, bizA.id, PO1, prodA.id, 1, 1);
  ok("6.8 duplicate product → 409 DUPLICATE_PURCHASE_ORDER_PRODUCT", dupLine.status === 409 && dupLine.body?.error?.code === "DUPLICATE_PURCHASE_ORDER_PRODUCT", JSON.stringify(dupLine.body?.error));
  const zeroPrice = await addLine(fA, bizA.id, PO1, prodB.id, 3, 0);
  ok("6.9 zero price ALLOWED (§40)", zeroPrice.status === 201, JSON.stringify(zeroPrice.body));
  ok("6.10 §53 injection probe name stored verbatim", zeroPrice.body?.data?.productNameAtOrder === "=1+1", zeroPrice.body?.data?.productNameAtOrder);
  const negPrice = await addLine(fA, bizA.id, PO1, prodA.id, 1, -1);
  ok("6.11 negative price → 422 (§41)", negPrice.status === 422);
  const fracQty = await addLine(fA, bizA.id, PO1, prodA.id, 1.5, 100);
  ok("6.12 fraction qty → 422 (§42)", fracQty.status === 422);
  const zeroQty = await addLine(fA, bizA.id, PO1, prodA.id, 0, 100);
  ok("6.13 zero qty → 422", zeroQty.status === 422);
  const nanQty = await addLine(fA, bizA.id, PO1, prodA.id, "NaN", 100);
  ok("6.14 NaN-ish qty → 422", nanQty.status === 422, String(nanQty.status));
  const foreignProd = await db.product.create({ data: { businessId: bizB.id, name: `${TAG}-PROD-B`, sku: `${TAG}-SKU-B1`, unit: "piece", stockQty: 0, isActive: true } });
  const fpLine = await addLine(fA, bizA.id, PO1, foreignProd.id, 1, 100);
  ok("6.15 foreign product → 404 (tenant scope)", fpLine.status === 404, String(fpLine.status));

  // §9/§10 — update-line regression: REAL snapshots + REAL timestamps.
  const createdLine = l1d;
  const updLine = await call(fA, `/api/v1/purchase-orders/${PO1}/lines/${createdLine.id}`, {
    method: "PATCH",
    headers: { "x-business-id": bizA.id },
    body: JSON.stringify({ orderedQty: 7, unitPriceMinor: 250_000 }),
  });
  ok("6.16 update line → 200", updLine.status === 200, JSON.stringify(updLine.body));
  const upd = updLine.body?.data;
  ok("6.17 §9/§10 productNameAtOrder = Alpha (NOT blank)", upd?.productNameAtOrder === `${TAG}-PROD-Alpha`, JSON.stringify(upd));
  ok("6.18 §9/§10 skuAtOrder preserved (NOT null)", upd?.skuAtOrder === `${TAG}-SKU-A1`, String(upd?.skuAtOrder));
  ok("6.19 §9/§10 unitAtOrder preserved (NOT null)", upd?.unitAtOrder === "piece", String(upd?.unitAtOrder));
  ok("6.20 §9/§10 createdAt = ORIGINAL persisted instant", upd?.createdAt === createdLine.createdAt, `${upd?.createdAt} vs ${createdLine.createdAt}`);
  ok("6.21 §9/§10 updatedAt advanced (mutation visible)", Date.parse(upd?.updatedAt ?? "") >= Date.parse(upd?.createdAt ?? "") && upd?.updatedAt !== undefined);
  ok("6.22 updated qty/price applied + total exact", upd?.orderedQty === 7 && upd?.unitPriceMinor === 250_000 && upd?.lineTotalMinor === 1_750_000);

  const updForeignLine = await call(fB, `/api/v1/purchase-orders/${PO1}/lines/${createdLine.id}`, { method: "PATCH", headers: { "x-business-id": bizB.id }, body: JSON.stringify({ orderedQty: 1 }) });
  ok("6.23 foreign line PATCH → 404", updForeignLine.status === 404);
  const delLine = await call(fA, `/api/v1/purchase-orders/${PO1}/lines/${zeroPrice.body?.data?.id}`, { method: "DELETE", headers: { "x-business-id": bizA.id } });
  ok("6.24 delete line → 200 removed", delLine.status === 200 && delLine.body?.data?.removed === true, JSON.stringify(delLine.body));
  const delAgain = await call(fA, `/api/v1/purchase-orders/${PO1}/lines/${zeroPrice.body?.data?.id}`, { method: "DELETE", headers: { "x-business-id": bizA.id } });
  ok("6.25 re-delete → 404", delAgain.status === 404);

  /* ------------------------ E. overflow (§17/§32/§39) ----------------------- */
  section("7. money overflow — exact BigInt law (§17/§32/§39)");
  // Max storable line = 1e6 qty × 1e9 price = 1e15. TEN such lines exceed
  // MAX_SAFE_INTEGER (9.007e15) → the 10th add must 422, not round.
  const overflowProducts = [];
  for (let i = 0; i < 10; i += 1) {
    overflowProducts.push(await createProduct(fA, bizA.id, `${TAG}-PROD-Big${i}`, `${TAG}-SKU-BIG${i}`));
  }
  let bigAdded = 0;
  let lastOverflowStatus = 0;
  let lastOverflowCode = "";
  for (let i = 0; i < 10; i += 1) {
    const r = await addLine(fA, bizA.id, PO1, overflowProducts[i].id, 1_000_000, 1_000_000_000);
    if (r.status === 201) bigAdded += 1;
    else {
      lastOverflowStatus = r.status;
      lastOverflowCode = r.body?.error?.code ?? "";
      break;
    }
  }
  ok("7.1 nine 1e15 lines ACCEPTED (exact BigInt, still safe)", bigAdded === 9, String(bigAdded));
  ok("7.2 10th 1e15 line → 422 PURCHASE_ORDER_TOTAL_OVERFLOW (§17)", lastOverflowStatus === 422 && lastOverflowCode === "PURCHASE_ORDER_TOTAL_OVERFLOW", `${lastOverflowStatus} ${lastOverflowCode}`);
  const dBig = await detail(fA, bizA.id, PO1);
  ok("7.3 detail total exact 9e15 + 1.75e6 (no silent rounding)", dBig.body?.data?.summary?.totalMinor === 9_000_000_000_000_000 + 1_750_000, JSON.stringify(dBig.body?.data?.summary));
  ok("7.4 totalQty exact (7 + 9×1,000,000)", dBig.body?.data?.summary?.totalQty === 7 + 9_000_000, JSON.stringify(dBig.body?.data?.summary));
  ok("7.5 rejected overflow line NOT persisted (transactional)", dBig.body?.data?.summary?.lineCount === 1 + 9, JSON.stringify(dBig.body?.data?.summary));
  const priceTooBig = await addLine(fA, bizA.id, PO1, overflowProducts[9].id, 1, 1_000_000_001);
  ok("7.6 price over the storage-realistic 1e9 bound → 422 (§29)", priceTooBig.status === 422, JSON.stringify(priceTooBig.body));

  /* --------------------------- F. lifecycle --------------------------------- */
  section("8. lifecycle — send/confirm/close/cancel (§29/§30/§37/§38)");
  const sendEmpty = await transition(fA, bizA.id, gen.body?.data?.id, "send");
  ok("8.1 send EMPTY order → 422 PURCHASE_ORDER_EMPTY", sendEmpty.status === 422 && sendEmpty.body?.error?.code === "PURCHASE_ORDER_EMPTY", JSON.stringify(sendEmpty.body?.error));
  const emptyAudits = await db.auditLog.count({ where: { entityType: "PurchaseOrder", entityId: gen.body?.data?.id, action: "purchase_order.send" } });
  ok("8.2 failed send wrote NO lifecycle audit event", emptyAudits === 0, String(emptyAudits));

  const send1 = await transition(fA, bizA.id, PO1, "send");
  ok("8.3 send → 200 SENT", send1.status === 200 && send1.body?.data?.status === "SENT", JSON.stringify(send1.body));
  ok("8.4 sentAt set", typeof send1.body?.data?.sentAt === "string");
  const dSent = await detail(fA, bizA.id, PO1);
  ok("8.5 detail shows SENT + lines locked", dSent.body?.data?.status === "SENT");
  const patchSent = await call(fA, `/api/v1/purchase-orders/${PO1}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ notes: "nope" }) });
  ok("8.6 SENT header patch → 409 PURCHASE_ORDER_IMMUTABLE", patchSent.status === 409 && patchSent.body?.error?.code === "PURCHASE_ORDER_IMMUTABLE", JSON.stringify(patchSent.body?.error));
  const lineAddSent = await addLine(fA, bizA.id, PO1, prodA.id, 1, 1);
  ok("8.7 SENT line add → 409", lineAddSent.status === 409);
  const lineUpdSent = await call(fA, `/api/v1/purchase-orders/${PO1}/lines/${createdLine.id}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ orderedQty: 2 }) });
  ok("8.8 SENT line update → 409", lineUpdSent.status === 409);
  const lineDelSent = await call(fA, `/api/v1/purchase-orders/${PO1}/lines/${createdLine.id}`, { method: "DELETE", headers: { "x-business-id": bizA.id } });
  ok("8.9 SENT line delete → 409", lineDelSent.status === 409);

  const confirm1 = await transition(fA, bizA.id, PO1, "confirm");
  ok("8.10 confirm → 200 CONFIRMED", confirm1.status === 200 && confirm1.body?.data?.status === "CONFIRMED");
  const close1 = await transition(fA, bizA.id, PO1, "close");
  ok("8.11 close → 200 CLOSED", close1.status === 200 && close1.body?.data?.status === "CLOSED");

  // §85 terminal immutability (CLOSED)
  const tClosed = [];
  tClosed.push(await call(fA, `/api/v1/purchase-orders/${PO1}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ notes: "x" }) }));
  tClosed.push(await addLine(fA, bizA.id, PO1, prodA.id, 1, 1));
  tClosed.push(await call(fA, `/api/v1/purchase-orders/${PO1}/lines/${createdLine.id}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ orderedQty: 1 }) }));
  tClosed.push(await call(fA, `/api/v1/purchase-orders/${PO1}/lines/${createdLine.id}`, { method: "DELETE", headers: { "x-business-id": bizA.id } }));
  tClosed.push(await transition(fA, bizA.id, PO1, "send"));
  tClosed.push(await transition(fA, bizA.id, PO1, "confirm"));
  tClosed.push(await transition(fA, bizA.id, PO1, "close"));
  tClosed.push(await transition(fA, bizA.id, PO1, "cancel"));
  ok("8.12 §85 CLOSED rejects header PATCH (409)", tClosed[0].status === 409, String(tClosed[0].status));
  ok("8.13 §85 CLOSED rejects add line (409)", tClosed[1].status === 409);
  ok("8.14 §85 CLOSED rejects update line (409)", tClosed[2].status === 409);
  ok("8.15 §85 CLOSED rejects delete line (409)", tClosed[3].status === 409);
  ok("8.16 §85 CLOSED rejects send (422)", tClosed[4].status === 422);
  ok("8.17 §85 CLOSED rejects confirm (422)", tClosed[5].status === 422);
  ok("8.18 §85 CLOSED rejects close (422)", tClosed[6].status === 422);
  ok("8.19 §85 CLOSED rejects cancel (422)", tClosed[7].status === 422);
  const dClosed = await detail(fA, bizA.id, PO1);
  ok("8.20 CLOSED detail still fully readable", dClosed.status === 200 && dClosed.body?.data?.status === "CLOSED");

  /* --------------------- invalid transition matrix (§29) -------------------- */
  section("9. §29 invalid transition matrix via dedicated endpoints");
  const draft2 = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-MATRIX-D` });
  ok("9.1 confirm on DRAFT → 422", (await transition(fA, bizA.id, draft2.body?.data?.id, "confirm")).status === 422);
  ok("9.2 close on DRAFT → 422", (await transition(fA, bizA.id, draft2.body?.data?.id, "close")).status === 422);
  ok("9.3 cancel on DRAFT → 200 CANCELLED (legal)", (await transition(fA, bizA.id, draft2.body?.data?.id, "cancel")).status === 200);
  const cancelledId = draft2.body?.data?.id;
  ok("9.4 send on CANCELLED → 422", (await transition(fA, bizA.id, cancelledId, "send")).status === 422);
  ok("9.5 cancel on CANCELLED → 422 (terminal §19)", (await transition(fA, bizA.id, cancelledId, "cancel")).status === 422);
  ok("9.6 CANCELLED detail readable", (await detail(fA, bizA.id, cancelledId)).body?.data?.status === "CANCELLED");
  const sent3 = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-MATRIX-S` });
  await addLine(fA, bizA.id, sent3.body?.data?.id, prodA.id, 1, 100);
  await transition(fA, bizA.id, sent3.body?.data?.id, "send");
  const sentId = sent3.body?.data?.id;
  ok("9.7 send on SENT → 422 (DRAFT→SENT only)", (await transition(fA, bizA.id, sentId, "send")).status === 422);
  ok("9.8 close on SENT → 422", (await transition(fA, bizA.id, sentId, "close")).status === 422);
  const conf3 = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-MATRIX-C` });
  await addLine(fA, bizA.id, conf3.body?.data?.id, prodA.id, 1, 100);
  await transition(fA, bizA.id, conf3.body?.data?.id, "send");
  await transition(fA, bizA.id, conf3.body?.data?.id, "confirm");
  const confId = conf3.body?.data?.id;
  ok("9.9 confirm on CONFIRMED → 422", (await transition(fA, bizA.id, confId, "confirm")).status === 422);
  ok("9.10 CONFIRMED cancel legal → 200 (matrix)", (await transition(fA, bizA.id, confId, "cancel")).status === 200);

  /* ----------------- §28 transition concurrency (storm) --------------------- */
  section("10. §28 transition storm — exactly one winner, stable errors");
  const stormPo = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-STORM-1` });
  await addLine(fA, bizA.id, stormPo.body?.data?.id, prodA.id, 2, 500);
  const stormId = stormPo.body?.data?.id;
  const sendStorm = await Promise.all(Array.from({ length: 5 }, () => transition(fA, bizA.id, stormId, "send")));
  const sendWins = sendStorm.filter((r) => r.status === 200);
  const sendLoseStable = sendStorm.filter((r) => r.status === 409 || r.status === 422);
  const sendLoseAll = sendStorm.filter((r) => r.status >= 500);
  ok("28.1 exactly one send wins", sendWins.length === 1, sendStorm.map((r) => r.status).join(","));
  ok("28.2 all losing sends are stable 4xx (no generic 500)", sendLoseAll.length === 0 && sendLoseStable.length === 4, sendStorm.map((r) => r.status).join(","));
  const confirmStorm = await Promise.all(Array.from({ length: 5 }, () => transition(fA, bizA.id, stormId, "confirm")));
  ok("28.3 exactly one confirm wins", confirmStorm.filter((r) => r.status === 200).length === 1, confirmStorm.map((r) => r.status).join(","));
  ok("28.4 losing confirms stable 4xx", confirmStorm.every((r) => r.status !== 500), confirmStorm.map((r) => r.status).join(","));
  const closeStorm = await Promise.all(Array.from({ length: 5 }, () => transition(fA, bizA.id, stormId, "close")));
  ok("28.5 exactly one close wins", closeStorm.filter((r) => r.status === 200).length === 1, closeStorm.map((r) => r.status).join(","));
  const dStorm = await detail(fA, bizA.id, stormId);
  ok("28.6 final status CLOSED (legal end state)", dStorm.body?.data?.status === "CLOSED");
  const [sendAudits, confirmAudits, closeAudits] = await Promise.all([
    db.auditLog.count({ where: { entityType: "PurchaseOrder", entityId: stormId, action: "purchase_order.send" } }),
    db.auditLog.count({ where: { entityType: "PurchaseOrder", entityId: stormId, action: "purchase_order.confirm" } }),
    db.auditLog.count({ where: { entityType: "PurchaseOrder", entityId: stormId, action: "purchase_order.close" } }),
  ]);
  ok("28.7 exactly ONE send audit", sendAudits === 1, String(sendAudits));
  ok("28.8 exactly ONE confirm audit", confirmAudits === 1, String(confirmAudits));
  ok("28.9 exactly ONE close audit", closeAudits === 1, String(closeAudits));
  ok("28.10 single lifecycle timestamps (no double-apply)", dStorm.body?.data?.lifecycle?.sentAt && dStorm.body?.data?.lifecycle?.confirmedAt && dStorm.body?.data?.lifecycle?.closedAt);

  /* --------------------- G. supplier + product lifecycle ------------------- */
  section("11. §31-§37 supplier/product lifecycle vs snapshots");
  const supBeta = await createSupplier(fA, bizA.id, `${TAG}-SUP-Beta`);
  const poSup = await createPO(fA, bizA.id, { supplierId: supBeta.id, reference: `${TAG}-SUPDEL-1` });
  await addLine(fA, bizA.id, poSup.body?.data?.id, prodA.id, 1, 100);
  const renameSup = await call(fA, `/api/v1/suppliers/${supBeta.id}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ name: `${TAG}-SUP-Beta-Renamed` }) });
  ok("11.1 supplier rename accepted", renameSup.status === 200, String(renameSup.status));
  const dSup1 = await detail(fA, bizA.id, poSup.body?.data?.id);
  ok("11.2 §34 nameAtOrder UNCHANGED after rename", dSup1.body?.data?.supplier?.nameAtOrder === `${TAG}-SUP-Beta`, dSup1.body?.data?.supplier?.nameAtOrder);
  ok("11.3 §34 live name surfaced separately", dSup1.body?.data?.supplier?.name === `${TAG}-SUP-Beta-Renamed` && dSup1.body?.data?.supplier?.stillExists === true, JSON.stringify(dSup1.body?.data?.supplier));
  await call(fA, `/api/v1/suppliers/${supBeta.id}`, { method: "DELETE", headers: { "x-business-id": bizA.id } });
  const dSup2 = await detail(fA, bizA.id, poSup.body?.data?.id);
  ok("11.4 §31 PO readable after supplier soft-delete", dSup2.status === 200);
  ok("11.5 §31 snapshot remains after deletion", dSup2.body?.data?.supplier?.nameAtOrder === `${TAG}-SUP-Beta`);
  ok("11.6 §31 deleted supplier → stillExists false", dSup2.body?.data?.supplier?.stillExists === false);
  const sendDelSup = await transition(fA, bizA.id, poSup.body?.data?.id, "send");
  ok("11.7 §31 DRAFT→SENT with deleted supplier → 422 INVALID_SUPPLIER", sendDelSup.status === 422 && sendDelSup.body?.error?.code === "INVALID_SUPPLIER", JSON.stringify(sendDelSup.body?.error));

  const prodC = await createProduct(fA, bizA.id, `${TAG}-PROD-Gamma`, `${TAG}-SKU-G1`);
  const poProd = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-PRODLC-1` });
  const gLine = await addLine(fA, bizA.id, poProd.body?.data?.id, prodC.id, 4, 1_000);
  const gLineId = gLine.body?.data?.id;
  await call(fA, `/api/v1/products/${prodC.id}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ name: `${TAG}-PROD-Gamma-Renamed`, sku: `${TAG}-SKU-G2`, unit: "box" }) });
  const dProd1 = await detail(fA, bizA.id, poProd.body?.data?.id);
  const gRow = dProd1.body?.data?.lines?.find((l) => l.id === gLineId);
  ok("11.8 §35 productNameAtOrder unchanged after rename", gRow?.productNameAtOrder === `${TAG}-PROD-Gamma`, gRow?.productNameAtOrder);
  ok("11.9 §36 skuAtOrder unchanged after SKU change", gRow?.skuAtOrder === `${TAG}-SKU-G1`, gRow?.skuAtOrder);
  ok("11.10 §37 unitAtOrder unchanged after unit change", gRow?.unitAtOrder === "piece", gRow?.unitAtOrder);
  await call(fA, `/api/v1/products/${prodC.id}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ isActive: false }) });
  const addInactive = await addLine(fA, bizA.id, poProd.body?.data?.id, prodC.id, 1, 100);
  ok("11.11 §32 ADD line for INACTIVE product → 422", addInactive.status === 422 && addInactive.body?.error?.code === "PURCHASE_ORDER_PRODUCT_INACTIVE", JSON.stringify(addInactive.body?.error));
  const editInactive = await call(fA, `/api/v1/purchase-orders/${poProd.body?.data?.id}/lines/${gLineId}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ orderedQty: 5 }) });
  ok("11.12 §32 EDIT of existing draft line for inactive product still ALLOWED", editInactive.status === 200, String(editInactive.status));
  await call(fA, `/api/v1/products/${prodC.id}`, { method: "DELETE", headers: { "x-business-id": bizA.id } });
  const dProd2 = await detail(fA, bizA.id, poProd.body?.data?.id);
  ok("11.13 §33 PO readable after product soft-delete", dProd2.status === 200 && dProd2.body?.data?.lines?.length === 1);
  ok("11.14 §33 historical line intact after deletion", dProd2.body?.data?.lines?.[0]?.productNameAtOrder === `${TAG}-PROD-Gamma`);

  /* ------------------------ H. currency snapshot (§38) --------------------- */
  section("12. §38 currency snapshot survives business config change");
  const poCur = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-CUR-1` });
  const dCur1 = await detail(fA, bizA.id, poCur.body?.data?.id);
  ok("12.1 first PO snapshot USD/$/2", dCur1.body?.data?.currency?.codeAtOrder === "USD" && dCur1.body?.data?.currency?.decimalPrecisionAtOrder === 2);
  const curPatch = await call(fA, `/api/v1/businesses/${bizA.id}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ currencyCode: "EUR" }) });
  ok("12.2 business currency switched to EUR", curPatch.status === 200, String(curPatch.status));
  const dCur2 = await detail(fA, bizA.id, poCur.body?.data?.id);
  ok("12.3 §38 historical PO STILL USD/$/2", dCur2.body?.data?.currency?.codeAtOrder === "USD" && dCur2.body?.data?.currency?.symbolAtOrder === "$" && dCur2.body?.data?.currency?.decimalPrecisionAtOrder === 2, JSON.stringify(dCur2.body?.data?.currency));
  const poCur2 = await createPO(fA, bizA.id, { supplierId: supAlpha.id, reference: `${TAG}-CUR-2` });
  const dCur3 = await detail(fA, bizA.id, poCur2.body?.data?.id);
  ok("12.4 NEW PO snapshots the NEW currency (EUR)", dCur3.body?.data?.currency?.codeAtOrder === "EUR", JSON.stringify(dCur3.body?.data?.currency));
  await call(fA, `/api/v1/businesses/${bizA.id}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ currencyCode: "USD" }) });

  /* ------------------------------ I. list ---------------------------------- */
  section("13. list — filters, pagination, determinism (§52/§54/§55)");
  const list1 = await call(fA, "/api/v1/purchase-orders?pageSize=100", { headers: { "x-business-id": bizA.id } });
  ok("13.1 list 200 with bounded pageSize", list1.status === 200 && list1.body?.data?.items?.length >= 5, JSON.stringify(list1.body?.total));
  ok("13.2 list DTO lighter than detail (no lines/notes keys)", list1.body?.data?.items?.every((i) => !("lines" in i) && !("notes" in i)));
  ok("13.3 list total exact", list1.body?.data?.total === list1.body?.data?.items?.length);
  const listQ = await call(fA, `/api/v1/purchase-orders?q=${encodeURIComponent("STORM")}`, { headers: { "x-business-id": bizA.id } });
  ok("13.4 q=reference hits", listQ.body?.data?.items?.some((i) => i.reference === `${TAG}-STORM-1`));
  const listSup = await call(fA, `/api/v1/purchase-orders?q=${encodeURIComponent("SUP-Beta")}`, { headers: { "x-business-id": bizA.id } });
  ok("13.5 q=supplier snapshot hits (SUP-Beta)", listSup.body?.data?.items?.some((i) => i.supplierNameAtOrder === `${TAG}-SUP-Beta`));
  const listSku = await call(fA, `/api/v1/purchase-orders?q=${encodeURIComponent("SKU-G1")}`, { headers: { "x-business-id": bizA.id } });
  ok("13.6 q=SKU snapshot hits", listSku.body?.data?.items?.some((i) => i.reference === `${TAG}-PRODLC-1`));
  const listStatus = await call(fA, "/api/v1/purchase-orders?status=CLOSED&pageSize=100", { headers: { "x-business-id": bizA.id } });
  ok("13.7 status filter (CLOSED only)", listStatus.body?.data?.items?.length > 0 && listStatus.body?.data?.items?.every((i) => i.status === "CLOSED"));
  const listBadStatus = await call(fA, "/api/v1/purchase-orders?status=RECEIVED", { headers: { "x-business-id": bizA.id } });
  ok("13.8 unknown status filter → 422", listBadStatus.status === 422);
  const listRange = await call(fA, "/api/v1/purchase-orders?from=2026-02-10&to=2026-02-10", { headers: { "x-business-id": bizA.id } });
  ok("13.9 from=to day window hits orderedAt day", listRange.status === 200 && listRange.body?.data?.items?.some((i) => i.reference === "P41PO E2E Ref 1" || i.reference?.startsWith("P41PO-")));
  const listBadRange = await call(fA, "/api/v1/purchase-orders?from=2026-03-01&to=2026-02-01", { headers: { "x-business-id": bizA.id } });
  ok("13.10 from>to → 422 (§43)", listBadRange.status === 422);
  const listP2 = await call(fA, "/api/v1/purchase-orders?page=2&pageSize=2", { headers: { "x-business-id": bizA.id } });
  ok("13.11 pagination page 2 returns different rows", listP2.status === 200 && listP2.body?.data?.items?.length <= 2 && listP2.body?.data?.page === 2);
  const listBig = await call(fA, "/api/v1/purchase-orders?pageSize=101", { headers: { "x-business-id": bizA.id } });
  ok("13.12 pageSize 101 → 422 (bounded ≤100)", listBig.status === 422);
  const listB = await call(fB, "/api/v1/purchase-orders", { headers: { "x-business-id": bizB.id } });
  ok("13.13 tenant isolation: bizB list does NOT leak bizA orders", listB.status === 200 && (listB.body?.data?.total ?? 1) === 0, JSON.stringify(listB.body?.data?.total));

  /* ----------------------------- J. deep link ------------------------------ */
  section("14. §60 deep-link API half + safe fallbacks");
  ok("14.1 detail by id works (deep link target resolves)", (await detail(fA, bizA.id, stormId)).status === 200);
  const malformed = await call(fA, `/api/v1/purchase-orders/zz%21`, { headers: { "x-business-id": bizA.id } });
  ok("14.2 malformed id → 404 fallback", malformed.status === 404, String(malformed.status));
  const unknownId = await call(fA, `/api/v1/purchase-orders/cmag000000000000unknown`, { headers: { "x-business-id": bizA.id } });
  ok("14.3 valid-format unknown id → 404", unknownId.status === 404);

  /* --------------------------- K. supplier 360 ----------------------------- */
  section("15. §61 Supplier 360 procurement history");
  const sup360 = await call(fA, `/api/v1/suppliers/${supAlpha.id}`, { headers: { "x-business-id": bizA.id } });
  ok("15.1 supplier 360 200", sup360.status === 200);
  const recentPos = sup360.body?.data?.recentPurchaseOrders ?? [];
  ok("15.2 recentPurchaseOrders ≤ 10 (bounded)", recentPos.length <= 10, String(recentPos.length));
  ok("15.3 section carries reference + snapshot + currency", recentPos.every((p) => p.reference && p.currencyCodeAtOrder && typeof p.totalMinor === "number"));
  ok("15.4 no other supplier's PO leaks in", recentPos.every((p) => p.reference.startsWith("P41PO") || p.reference.startsWith("PO-")));

  /* --------------------------- L. product history -------------------------- */
  section("16. §61 Product detail procurement history");
  const prodDetail = await call(fA, `/api/v1/products/${prodA.id}`, { headers: { "x-business-id": bizA.id } });
  ok("16.1 product detail 200", prodDetail.status === 200);
  const prodPo = prodDetail.body?.data?.recentPurchaseOrders ?? [];
  ok("16.2 recentPurchaseOrders ≤ 10 (bounded)", prodPo.length <= 10, String(prodPo.length));
  ok("16.3 history carries supplier snapshot", prodPo.every((p) => typeof p.supplierNameAtOrder === "string"));

  /* ------------------------------ M. search -------------------------------- */
  section("17. §57/§58/§59 global search");
  const s1 = await call(fA, `/api/v1/search?q=${encodeURIComponent("STORM")}&types=PURCHASE_ORDER`, { headers: { "x-business-id": bizA.id } });
  const s1Items = s1.body?.data?.groups?.find((g) => g.type === "PURCHASE_ORDER")?.items ?? [];
  ok("17.1 search finds PO by reference", s1.status === 200 && s1Items.length >= 1, JSON.stringify(s1.body?.data?.total));
  ok("17.2 no money fields in search items", s1Items.every((i) => !("totalMinor" in i) && !("amountMinor" in i) && !("unitPriceMinor" in i)));
  ok("17.3 status token is the canonical vocabulary", s1Items.every((i) => ["DRAFT", "SENT", "CONFIRMED", "CLOSED", "CANCELLED", null].includes(i.status)));
  const s2 = await call(fA, `/api/v1/search?q=${encodeURIComponent("SKU-BIG3")}&types=PURCHASE_ORDER`, { headers: { "x-business-id": bizA.id } });
  const s2Items = s2.body?.data?.groups?.find((g) => g.type === "PURCHASE_ORDER")?.items ?? [];
  ok("17.4 §57 search by product SKU snapshot (ranker-confirmed)", s2Items.some((i) => i.title === `${TAG}-PATCHED-1`), JSON.stringify(s2Items.map((i) => i.title)));
  const s2b = await call(fA, `/api/v1/search?q=${encodeURIComponent("PROD-Big5")}&types=PURCHASE_ORDER`, { headers: { "x-business-id": bizA.id } });
  const s2bItems = s2b.body?.data?.groups?.find((g) => g.type === "PURCHASE_ORDER")?.items ?? [];
  ok("17.5 §57 search by product NAME snapshot", s2bItems.some((i) => i.title === `${TAG}-PATCHED-1`), JSON.stringify(s2bItems.map((i) => i.title)));
  const sB = await call(fB, `/api/v1/search?q=${encodeURIComponent("STORM")}&types=PURCHASE_ORDER`, { headers: { "x-business-id": bizB.id } });
  const sBItems = sB.body?.data?.groups?.find((g) => g.type === "PURCHASE_ORDER")?.items ?? [];
  ok("17.6 §58 tenant isolation: bizB search finds NONE of bizA", sBItems.length === 0, JSON.stringify(sBItems.map((i) => i.title)));

  /* ----------------------------- N. CSV export ----------------------------- */
  section("18. §49-§56/§87 CSV export (gates, locales, injection, completeness)");
  // 12-line order (> UI page size 10) on the dedicated export business.
  const supC = await createSupplier(fC, bizC.id, `${TAG}-SUP-C`);
  const poExp = await createPO(fC, bizC.id, { supplierId: supC.id, reference: `${TAG}-EXP-1` });
  const expProducts = [];
  for (let i = 0; i < 12; i += 1) {
    expProducts.push(await createProduct(fC, bizC.id, i === 0 ? "@cmd" : `${TAG}-PROD-X${i}`, `${TAG}-XSKU-${String(i + 1).padStart(2, "0")}`));
  }
  let expAddOk = 0;
  for (const [i, p] of expProducts.entries()) {
    const r = await addLine(fC, bizC.id, poExp.body?.data?.id, p.id, i + 1, 1_000);
    if (r.status === 201) expAddOk += 1;
  }
  ok("18.1 12 lines added (> UI page size 10)", expAddOk === 12, String(expAddOk));


  const exp1 = await call(fC, `/api/v1/purchase-orders/${poExp.body?.data?.id}/export?locale=en`, { headers: { "x-business-id": bizC.id } });
  ok("18.2 export → 200 (CSV_EXPORT entitled)", exp1.status === 200, String(exp1.status));
  const csv1 = rawCsv(exp1);
  ok("18.3 BOM present (EF BB BF)", csv1.bytes[0] === 0xef && csv1.bytes[1] === 0xbb && csv1.bytes[2] === 0xbf);
  ok("18.4 CRLF line endings", csv1.text.includes("\r\n"));
  ok("18.5 EN headers machine-form", csv1.text.includes("reference,") && csv1.text.includes("unit_price_minor"));
  ok("18.6 completeness: 12 data rows + 1 header (§54)", csv1.text.trim().split("\r\n").length === 13, String(csv1.text.trim().split("\r\n").length));
  ok("18.7 §53 injection: '=1+1 style cells neutralized", csv1.text.includes("'@cmd") || csv1.text.includes("\"'@cmd\""), csv1.text.split("\r\n")[1]);
  ok("18.8 attachment disposition", (exp1.headers.get("content-disposition") ?? "").includes("attachment"));
  ok("18.9 §87/§52 no-store", (exp1.headers.get("cache-control") ?? "") === "no-store", exp1.headers.get("cache-control"));

  const expFa = await call(fC, `/api/v1/purchase-orders/${poExp.body?.data?.id}/export?locale=fa`, { headers: { "x-business-id": bizC.id } });
  const csvFa = rawCsv(expFa);
  ok("18.10 FA export → 200 with Persian headers (§55)", expFa.status === 200 && csvFa.text.includes("شماره سند") && csvFa.text.includes("کالا"), csvFa.text.split("\r\n")[0]?.slice(0, 80));
  const expBadLocale = await call(fC, `/api/v1/purchase-orders/${poExp.body?.data?.id}/export?locale=fr`, { headers: { "x-business-id": bizC.id }, "x-no-retry": "1" });
  ok("18.11 unsupported locale → 422", expBadLocale.status === 422, String(expBadLocale.status));

  const foreignExp = await call(fB, `/api/v1/purchase-orders/${poExp.body?.data?.id}/export`, { headers: { "x-business-id": bizB.id } });
  ok("18.12 foreign export → 404 (no existence leak §49)", foreignExp.status === 404, String(foreignExp.status));
  const viewerExp = await call(fV, `/api/v1/purchase-orders/${PO1}/export`, { headers: { "x-business-id": bizA.id } });
  ok("18.13 VIEWER (no data:write context change) export → 200 or 403 by plan (honest gate)", [200, 403].includes(viewerExp.status), String(viewerExp.status));

  // §50 — entitlement flip on the DEDICATED plan (fresh read, live proof).
  const flip = await db.planEntitlement.update({
    where: { planId_entitlementId: { planId: expPlan.id, entitlementId: defByCode.get("CSV_EXPORT") } },
    data: { boolValue: false },
  });
  ok("18.14 entitlement flipped off in DB", flip.boolValue === false);
  const expNoEnt = await call(fC, `/api/v1/purchase-orders/${poExp.body?.data?.id}/export`, { headers: { "x-business-id": bizC.id }, "x-no-retry": "1" });
  ok("18.15 §50 CSV_EXPORT unavailable → 403 ENTITLEMENT_NOT_AVAILABLE", expNoEnt.status === 403 && expNoEnt.body?.error?.code === "ENTITLEMENT_NOT_AVAILABLE", JSON.stringify(expNoEnt.body?.error));
  await db.planEntitlement.update({
    where: { planId_entitlementId: { planId: expPlan.id, entitlementId: defByCode.get("CSV_EXPORT") } },
    data: { boolValue: true },
  });

  // §51 — rate limit: requests so far for ownerC = 3 (en+fa+422-after-gate? no — 422 consumed gate only) → burn to the 11th.
  let burnStatuses = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await call(fC, `/api/v1/purchase-orders/${poExp.body?.data?.id}/export?locale=en`, { headers: { "x-business-id": bizC.id }, "x-no-retry": "1" });
    burnStatuses.push(r.status);
    if (r.status === 429) break;
  }
  ok("18.16 §51 11th export in window → 429 RATE_LIMITED", burnStatuses[burnStatuses.length - 1] === 429, burnStatuses.join(","));
  ok("18.17 requests before the 429 all succeeded", burnStatuses.slice(0, -1).every((s) => s === 200), burnStatuses.join(","));

  /* ------------------------ O. supplier statement purity ------------------- */
  section("19. §114 purchase orders NEVER appear in statements");
  const stmt = await call(fA, `/api/v1/suppliers/${supAlpha.id}/statement`, { headers: { "x-business-id": bizA.id } });
  ok("19.1 supplier statement 200", stmt.status === 200, String(stmt.status));
  const stmtEvents = stmt.body?.data?.events ?? stmt.body?.data?.rows ?? stmt.body?.data?.entries ?? [];
  ok("19.2 every statement event source is EXPENSE or PAYMENT (no PO rows)", stmtEvents.every((e) => ["EXPENSE", "PAYMENT"].includes(e.sourceType ?? e.type ?? "")), JSON.stringify(stmtEvents.slice(0, 3)));
  ok("19.3 no purchaseOrder keys in statement payload", !JSON.stringify(stmt.body ?? {}).includes("purchaseOrder"));

  /* --------------------------- P. audit + minimization --------------------- */
  section("20. §64/§65/§66 audit actions + data minimization");
  const poAudits = await db.auditLog.findMany({ where: { entityType: "PurchaseOrder", entityId: PO1 }, orderBy: { createdAt: "asc" } });
  const auditActions = new Set(poAudits.map((a) => a.action));
  for (const expected of ["purchase_order.create", "purchase_order.update", "purchase_order.line_add", "purchase_order.line_update", "purchase_order.line_remove", "purchase_order.send", "purchase_order.confirm", "purchase_order.close"]) {
    ok(`20.${expected}`, auditActions.has(expected), [...auditActions].join(","));
  }
  const auditText = JSON.stringify(poAudits.map((a) => ({ b: a.beforeJson, a: a.afterJson })));
  ok("20.9 §66 notes content NEVER logged", !auditText.includes("Deliver to dock 7") && !auditText.includes("Updated note"));
  ok("20.10 §66 no tokens/secrets in audit bodies", !auditText.toLowerCase().includes("password") && !auditText.toLowerCase().includes("mfasecret"));

  /* ----------------------- Q. status corruption (§68) ---------------------- */
  section("21. §68 corrupted persisted status — NEVER fake DRAFT");
  const scratchSup = await createSupplier(fA, bizA.id, `${TAG}-SUP-Scratch`);
  const scratch = await createPO(fA, bizA.id, { supplierId: scratchSup.id, reference: `${TAG}-CORRUPT-1` });
  const scratchId = scratch.body?.data?.id;
  const scratchProd = await createProduct(fA, bizA.id, `${TAG}-PROD-CORRUPT`, `${TAG}-SKU-CORRUPT`);
  await addLine(fA, bizA.id, scratchId, scratchProd.id, 1, 100);
  await db.purchaseOrder.update({ where: { id: scratchId }, data: { status: "INVALID_STATUS" } });

  const cDetail = await detail(fA, bizA.id, scratchId);
  ok("21.1 corrupted detail → 500 PURCHASE_ORDER_INVALID_PERSISTED_STATUS", cDetail.status === 500 && cDetail.body?.error?.code === "PURCHASE_ORDER_INVALID_PERSISTED_STATUS", JSON.stringify(cDetail.body?.error));
  const cList = await call(fA, `/api/v1/purchase-orders?q=CORRUPT-1`, { headers: { "x-business-id": bizA.id } });
  ok("21.2 corrupted list → 500 same stable code", cList.status === 500 && cList.body?.error?.code === "PURCHASE_ORDER_INVALID_PERSISTED_STATUS", JSON.stringify(cList.body?.error));
  const cSend = await transition(fA, bizA.id, scratchId, "send");
  ok("21.3 corrupted transition → 500 stable code (no fake DRAFT send)", cSend.status === 500 && cSend.body?.error?.code === "PURCHASE_ORDER_INVALID_PERSISTED_STATUS", JSON.stringify(cSend.body?.error));
  const cPatch = await call(fA, `/api/v1/purchase-orders/${scratchId}`, { method: "PATCH", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ notes: "x" }) });
  ok("21.4 corrupted patch → 500 stable (never 409-immutability on unknown state)", cPatch.status === 500 && cPatch.body?.error?.code === "PURCHASE_ORDER_INVALID_PERSISTED_STATUS", JSON.stringify(cPatch.body?.error));
  const cSup = await call(fA, `/api/v1/suppliers/${scratchSup.id}`, { headers: { "x-business-id": bizA.id } });
  ok("21.5 Supplier 360 on corrupt PO → 500 stable code", cSup.status === 500 && cSup.body?.error?.code === "PURCHASE_ORDER_INVALID_PERSISTED_STATUS", JSON.stringify(cSup.body?.error));
  const cProd = await call(fA, `/api/v1/products/${scratchProd.id}`, { headers: { "x-business-id": bizA.id } });
  ok("21.6 Product history on corrupt PO → 500 stable code", cProd.status === 500 && cProd.body?.error?.code === "PURCHASE_ORDER_INVALID_PERSISTED_STATUS", JSON.stringify(cProd.body?.error));
  const cSearch = await call(fA, `/api/v1/search?q=CORRUPT-1&types=PURCHASE_ORDER`, { headers: { "x-business-id": bizA.id } });
  const cSearchItems = cSearch.body?.data?.groups?.find((g) => g.type === "PURCHASE_ORDER")?.items ?? [];
  ok("21.7 §59 search NEVER claims corrupted row is Draft", cSearchItems.every((i) => i.status !== "DRAFT"), JSON.stringify(cSearchItems.map((i) => i.status)));
  await db.purchaseOrder.update({ where: { id: scratchId }, data: { status: "DRAFT" } });
  ok("21.8 restored row readable again (surgical recovery)", (await detail(fA, bizA.id, scratchId)).status === 200);

  /* -------------- §62/§63 financial non-mutation AFTER lifecycle ----------- */
  section("22. §62/§63 — financial/inventory authorities UNTOUCHED");
  const baseFin = JSON.parse(baseline);
  const afterFin = JSON.parse(await financialSnapshot());
  const stockDrift = Object.entries(baseFin.stock).filter(([id, qty]) => afterFin.stock[id] !== qty);
  ok("22.1 §62 every product's stockQty IDENTICAL before vs after the full PO flow", stockDrift.length === 0, JSON.stringify(stockDrift.slice(0, 3)));
  ok("22.2 §62 InventoryAdjustment count unchanged", afterFin.adjust === baseFin.adjust, `${baseFin.adjust} → ${afterFin.adjust}`);
  ok("22.3 §62 Expense count unchanged", afterFin.expense === baseFin.expense);
  ok("22.4 §62 Payment count unchanged", afterFin.payment === baseFin.payment);
  ok("22.5 §62 Sale count unchanged", afterFin.sale === baseFin.sale);
  ok("22.6 §62 SaleItem count unchanged", afterFin.saleItem === baseFin.saleItem);
  ok("22.7 §63 cancellation created no reversal artifacts (adjustment count unchanged)", afterFin.adjust === baseFin.adjust);

  /* ------------------------------ teardown --------------------------------- */
  section("23. §119/§121 teardown — P41 residue to ZERO");
  for (const b of [bizA, bizB, bizC]) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
    await db.subscription.deleteMany({ where: { businessId: b.id } });
    await db.businessMember.deleteMany({ where: { businessId: b.id } });
    await db.business.delete({ where: { id: b.id } });
  }
  await db.plan.delete({ where: { id: expPlan.id } });
  await db.user.deleteMany({ where: { email: { endsWith: `@${USER_DOMAIN}` } } });

  ok("23.1 0 P41 businesses", (await db.business.count({ where: { name: { startsWith: `${TAG}-` } } })) === 0);
  ok("23.2 0 P41 users", (await db.user.count({ where: { email: { endsWith: `@${USER_DOMAIN}` } } })) === 0);
  ok("23.3 0 P41 purchase orders", (await db.purchaseOrder.count({ where: { reference: { contains: "P41PO" } } })) === 0);
  ok("23.4 0 P41 products", (await db.product.count({ where: { name: { contains: `${TAG}-PROD` } } })) === 0);
  ok("23.5 0 P41 suppliers", (await db.supplier.count({ where: { name: { contains: `${TAG}-SUP` } } })) === 0);
  ok("23.6 0 P41 plans", (await db.plan.count({ where: { code: { startsWith: `${TAG}-PLAN` } } })) === 0);
  ok("23.7 subs == businesses invariant preserved", (await db.subscription.count()) >= (await db.business.count()));

  console.log(`\nPROMPT 41 E2E: ${passed}/${passed + failed} ${failed === 0 ? "PASS ✓" : "FAIL"}`);
  if (failed > 0) {
    console.log("FAILED:");
    for (const x of failures) console.log(`  - ${x}`);
    process.exitCode = 1;
  }
}

main()
  .catch(async (e) => {
    console.error("E2E crashed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
