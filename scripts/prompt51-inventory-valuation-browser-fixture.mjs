#!/usr/bin/env node
/**
 * scripts/prompt51-inventory-valuation-browser-fixture.mjs — Prompt 51
 * browser-QA fixture (mirrors the P47–P50 browser-fixture convention).
 *
 * Seeds a STABLE visual fixture for real-browser QA of the detailed
 * inventory valuation panel:
 *   - owner p51qa-owner@test.local (login-first, kept between runs)
 *   - business P51QA-VISUAL (Asia/Tehran, USD) on STARTER (CSV_EXPORT on)
 *   - the 10-product catalog covering every state: positive cost, zero
 *     cost with stock, zero stock, low stock, inactive-with-stock,
 *     negative stock, duplicate names, unicode name, formula-injection
 *     name, extra products for pagination (>25 rows on STARTER? no —
 *     STARTER PRODUCTS_MAX is 200; we seed 27 so the default page of 25
 *     hasMore=true exercises the pagination controls)
 *   - wipes ALL previous fixture products first (idempotent, adopt-back)
 *
 * Run: bun scripts/prompt51-inventory-valuation-browser-fixture.mjs
 * Teardown: bun scripts/prompt51-inventory-valuation-browser-fixture.mjs --teardown
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createRequire } = await import("node:module");
const req = createRequire(new URL("../package.json", import.meta.url));
const { PrismaClient } = req("@prisma/client");
const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const EMAIL = "p51qa-owner@test.local";
const BIZ_NAME = "P51QA-VISUAL";
const jar = new Map();

async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.53.14.9", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

const teardown = process.argv.includes("--teardown");

async function login() {
  const csrf0 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf0, email: EMAIL, password: PASS, redirect: "false", json: "true" }).toString() });
  const me = await f("/api/v1/me");
  if (me.status !== 200) {
    const reg = await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P51QA Owner", email: EMAIL, password: PASS }) });
    if (!(reg.status === 201 || reg.status === 409)) throw new Error(`register failed ${reg.status}`);
    const csrf1 = (await f("/api/auth/csrf")).body?.csrfToken;
    await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf1, email: EMAIL, password: PASS, redirect: "false", json: "true" }).toString() });
  }
}

const owner = await (async () => {
  await login();
  const me = await f("/api/v1/me");
  if (me.status !== 200) throw new Error("owner session failed");
  return db.user.findUnique({ where: { email: EMAIL } });
})();

let biz = await db.business.findFirst({ where: { name: BIZ_NAME } });
if (teardown) {
  if (biz) {
    await db.inventoryAdjustment.deleteMany({ where: { businessId: biz.id } }).catch(() => {});
    await db.payment.deleteMany({ where: { businessId: biz.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: biz.id } } });
    await db.sale.deleteMany({ where: { businessId: biz.id } });
    await db.expense.deleteMany({ where: { businessId: biz.id } });
    await db.customer.deleteMany({ where: { businessId: biz.id } });
    await db.supplier.deleteMany({ where: { businessId: biz.id } });
    await db.product.deleteMany({ where: { businessId: biz.id } });
    await db.auditLog.deleteMany({ where: { businessId: biz.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: biz.id } } }).catch(() => {});
    await db.subscription.deleteMany({ where: { businessId: biz.id } }).catch(() => {});
    console.log("P51QA-VISUAL fixture wiped (business row kept for limiter hygiene).");
  }
  await db.$disconnect();
  process.exit(0);
}

if (!biz) {
  // BUSINESSES_MAX: bump owned businesses to PRO briefly (the owner may
  // already carry the E2E check's two fixture businesses).
  const bumpPlan = await db.plan.findUnique({ where: { code: "PRO" } });
  const freePlan = await db.plan.findUnique({ where: { code: "FREE" } });
  const owned = await db.business.findMany({ where: { ownerId: owner.id }, select: { id: true } });
  const bumped = [];
  for (const b of owned) {
    const sub = await db.subscription.findUnique({ where: { businessId: b.id } });
    if (sub && sub.planId !== bumpPlan.id) {
      await db.subscription.update({ where: { businessId: b.id }, data: { planId: bumpPlan.id } });
      // P51-R1: raw fixture plan bumps stay AUDITABLE (P48 fixture law —
      // prompt20-billing-check B2 counts non-FREE subscriptions without a
      // PLAN_CHANGED event as a failure).
      await db.subscriptionEvent.create({ data: { businessId: b.id, subscriptionId: sub.id, type: "PLAN_CHANGED", toStatus: "ACTIVE", fromPlanCode: "FREE", toPlanCode: "PRO", dataJson: '{"source":"p51r1-browser-fixture-bump"}' } });
      bumped.push(b.id);
    }
  }
  const res = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: BIZ_NAME, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }) });
  for (const b of bumped) {
    const sub = await db.subscription.findUnique({ where: { businessId: b.id } });
    await db.subscription.update({ where: { businessId: b.id }, data: { planId: freePlan.id } }).catch(() => {});
    if (sub) {
      await db.subscriptionEvent.create({ data: { businessId: b.id, subscriptionId: sub.id, type: "PLAN_CHANGED", toStatus: "ACTIVE", fromPlanCode: "PRO", toPlanCode: "FREE", dataJson: '{"source":"p51r1-browser-fixture-restore"}' } }).catch(() => {});
    }
  }
  if (res.status === 201) {
    biz = await db.business.findUnique({ where: { id: res.body.data.business.id } });
  } else if (res.status === 429 && res.body?.error?.code === "RATE_LIMITED") {
    // P51-R1: rate-limit-aware fallback (mirrors the main check harness) —
    // the user-scoped business-create limiter is long-window; after heavy
    // QA the API create can 429 for a long time. The API create path is
    // proven live; mirror its result at the db level (business + OWNER
    // membership), keeping the subsequent STARTER subscription step and
    // its audit events.
    const ownerUser = owner;
    biz = await db.business.create({ data: { name: BIZ_NAME, slug: `p51qa-visual-${Date.now()}`, currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2, locale: "en", timezone: "Asia/Tehran", ownerId: ownerUser.id } });
    await db.businessMember.create({ data: { businessId: biz.id, userId: ownerUser.id, role: "OWNER" } });
  } else {
    throw new Error(`business create failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}
// STARTER (CSV_EXPORT visible for the export QA).
// P51-R1: the raw fixture path stays AUDITABLE and mirrors the real
// billing flow (prompt20 B2/B3 invariants): the subscription is created
// as FREE with a CREATED event, then lifted to STARTER with a
// PLAN_CHANGED event — never a silent raw plan write.
const starter = await db.plan.findUnique({ where: { code: "STARTER" } });
let subA = await db.subscription.findUnique({ where: { businessId: biz.id } });
if (!subA) {
  const free = await db.plan.findUnique({ where: { code: "FREE" } });
  subA = await db.subscription.create({ data: { businessId: biz.id, planId: free.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
  await db.subscriptionEvent.create({ data: { businessId: biz.id, subscriptionId: subA.id, type: "CREATED", toStatus: "ACTIVE", toPlanCode: "FREE", dataJson: '{"source":"p51q-browser-fixture-bootstrap"}' } });
}
if (subA.planId !== starter.id) {
  const fromPlan = await db.plan.findUnique({ where: { id: subA.planId } });
  await db.subscription.update({ where: { businessId: biz.id }, data: { planId: starter.id } });
  await db.subscriptionEvent.create({ data: { businessId: biz.id, subscriptionId: subA.id, type: "PLAN_CHANGED", toStatus: "ACTIVE", fromPlanCode: fromPlan?.code ?? null, toPlanCode: "STARTER", dataJson: '{"source":"p51q-browser-fixture-plan-set"}' } });
}

// Wipe previous fixture products (idempotent re-runs).
await db.inventoryAdjustment.deleteMany({ where: { businessId: biz.id } }).catch(() => {});
await db.saleItem.deleteMany({ where: { sale: { businessId: biz.id } } });
await db.sale.deleteMany({ where: { businessId: biz.id } });
await db.expense.deleteMany({ where: { businessId: biz.id } });
await db.product.deleteMany({ where: { businessId: biz.id } });

const H = { "x-business-id": biz.id };
async function mkProduct(body) {
  const r = await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify(body) });
  if (r.status !== 201) throw new Error(`product failed: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  return r.body.data;
}
// The showcase catalog (27 products → default page 25 hasMore=true).
const catalog = [
  { name: "Alpha Widget", sku: "SKU-AWD", unit: "piece", salePriceMinor: 9_000, costPriceMinor: 500, stockQty: 10, lowStockAt: 5 },
  { name: "Alpha Widget", sku: "SKU-AWD2", unit: "piece", salePriceMinor: 9_500, costPriceMinor: 1_200, stockQty: 2, lowStockAt: 1 },
  { name: "Beta Freebie", sku: "SKU-BETA", unit: "piece", salePriceMinor: 100, costPriceMinor: 0, stockQty: 7, lowStockAt: 5 },
  { name: "Gamma Out", sku: "SKU-GAMMA", unit: "kg", salePriceMinor: 1_500, costPriceMinor: 999, stockQty: 0, lowStockAt: 5 },
  { name: "Delta Low", sku: "SKU-DELTA", unit: "m", salePriceMinor: 8_000, costPriceMinor: 2_500, stockQty: 3, lowStockAt: 5 },
  { name: "Inactive Stock", sku: "SKU-INACT", unit: "piece", salePriceMinor: 700, costPriceMinor: 300, stockQty: 4, lowStockAt: 2 },
  { name: "Negative Stock", sku: "SKU-NEG", unit: "piece", salePriceMinor: 600, costPriceMinor: 400, stockQty: 0, lowStockAt: 5 },
  { name: "=SOMEFORMULA()", sku: "SKU-EQ", unit: "piece", salePriceMinor: 200, costPriceMinor: 100, stockQty: 1, lowStockAt: 0 },
  { name: "پارسل فارسی", sku: "SKU-FA", unit: "piece", salePriceMinor: 400, costPriceMinor: 200, stockQty: 5, lowStockAt: 3 },
  { name: "Long Name Product With A Very Long Descriptive Title For Layout Testing 0123456789", sku: "SKU-LONG-NAME-0123456789", unit: "hour", salePriceMinor: 1_000, costPriceMinor: 700, stockQty: 1, lowStockAt: 0 },
];
for (let i = 1; i <= 17; i++) {
  catalog.push({ name: `Bulk Item ${String(i).padStart(2, "0")}`, sku: `SKU-BULK-${String(i).padStart(2, "0")}`, unit: "piece", salePriceMinor: 500 + i * 10, costPriceMinor: 120 + i * 7, stockQty: i, lowStockAt: 2 });
}
const created = [];
for (const c of catalog) created.push(await mkProduct(c));
await db.product.update({ where: { id: created[6].id }, data: { stockQty: -2 } });
await db.product.update({ where: { id: created[5].id }, data: { isActive: false } });

// A few sales + expenses so the Reports module renders its full content
// (the inventory card lives inside the activity branch).
const iso = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const cust = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: "Visual Customer Co." }) })).body?.data;
const sup = (await f("/api/v1/suppliers", { method: "POST", headers: H, body: JSON.stringify({ name: "Visual Supplier Ltd" }) })).body?.data;
for (const [i, days] of [1, 3, 6].entries()) {
  const p = created[i];
  const r = await f("/api/v1/sales", { method: "POST", headers: H, body: JSON.stringify({ customerId: cust.id, issueDate: iso(days), items: [{ productId: p.id, name: p.name, unit: p.unit ?? "piece", qty: 1, unitPriceMinor: p.salePriceMinor }] }) });
  if (r.status !== 201) throw new Error(`sale failed ${r.status}`);
}
await f("/api/v1/expenses", { method: "POST", headers: H, body: JSON.stringify({ supplierId: sup.id, category: "Visual Rent", amountMinor: 12_000, spentAt: iso(2) }) });
await f("/api/v1/expenses", { method: "POST", headers: H, body: JSON.stringify({ supplierId: sup.id, category: "Visual Utilities", amountMinor: 4_500, spentAt: iso(4) }) });

const total = created.reduce((s, p) => s + p.stockQty * p.costPriceMinor, 0);
console.log(`P51QA-VISUAL ready: ${created.length} products, operational total ${total} minor (via API: 25 for alpha-bulk, 2 db-level states applied).`);
console.log("Login: p51qa-owner@test.local / testpass123 — Reports → Inventory health → Detailed valuation.");
await db.$disconnect();
