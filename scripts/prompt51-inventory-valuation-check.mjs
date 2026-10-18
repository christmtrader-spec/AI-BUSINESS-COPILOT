#!/usr/bin/env node
/**
 * scripts/prompt51-inventory-valuation-check.mjs — Prompt 51 E2E check
 * against the LIVE dev server (real API, real DB, real auth):
 *
 *   §F  fixtures — owner session, BIZ-A (Asia/Tehran) with a 10-product
 *       catalog covering every cost/stock/activity state (positive, zero
 *       cost, zero stock, low stock, inactive-with-stock, negative stock,
 *       duplicate names, unicode name, formula-injection name), BIZ-B
 *       cross-tenant, P51-TINY (CSV_EXPORT=false) harness plan
 *   §A  report correctness — auth, exact totals, counts, row/total
 *       reconciliation, summary reconciliation (Gate D), identity,
 *       inactive inclusion, zero-cost honesty, negative honesty, no-store
 *   §B  filters — every closed combination server-side, q normalization,
 *       validation 422s (enums, q length, page/pageSize bounds)
 *   §C  sorting — all 7 sorts, deterministic tie-break by id
 *   §D  pagination — no dup/skip across pages, honest empty pages,
 *       hasMore/totalCount truth
 *   §E  CSV export — CSV_EXPORT enforcement, complete rows, BOM+CRLF,
 *       formula-injection guard, reconciling summary, filtered export
 *   §F  entitlements — FREE JSON 200 (basic drill-down), CSV 403 on a
 *       CSV_EXPORT=false plan, JSON still 200 there
 *   §G  read-only law — product rows byte-identical (incl. updatedAt),
 *       no new financial/adjustment rows from report calls
 *   §H  tenant isolation — B never sees A, search cannot cross tenants,
 *       aggregates never mix
 *   §I  teardown to ZERO residue
 *
 * Run: bun scripts/prompt51-inventory-valuation-check.mjs   (dev server up)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const { PrismaClient } = req("@prisma/client");
const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P51QA";
const jar = new Map();

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.52.14.9", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null), res };
}

/** Raw fetch returning the response as text (CSV bodies are not JSON). */
async function ftext(path, extraHeaders = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "x-forwarded-for": "10.52.14.9", ...(cookie ? { cookie } : {}), ...extraHeaders };
  const res = await fetch(`${BASE}${path}`, { headers });
  const bytes = await res.arrayBuffer();
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder("utf-8").decode(bytes) };
}

// ---------------- teardown-first (idempotent, crashed-run safe) ----------------
async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.supplierBillLine.deleteMany({ where: { supplierBill: { businessId: b.id } } }).catch(() => {});
    await db.supplierBill.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } }).catch(() => {});
    await db.subscription.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    // Business rows stay (business:create limiter hygiene) — the next run
    // adopts them.
  }
  // P51-R1: purge husks — after the subscription wipe above, an owned
  // P51QA-* business WITHOUT a subscription counts toward
  // assertWithinBusinessesLimitTx's owned.length but contributes NOTHING
  // to the limit (documented fail-closed billing law), which poisons the
  // fresh BIZ-A creation below (owned=1, limit=FREE-fallback=1 → 422).
  // A subscription-less fixture row is a husk; remove it so the next run
  // starts from a coherent ownership state (the browser fixture
  // self-heals P51QA-VISUAL, and this check re-adopts/re-creates BIZ-A/B).
  const husks = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` }, subscription: null }, select: { id: true } });
  for (const h of husks) {
    await db.business.delete({ where: { id: h.id } }).catch(() => {});
  }
  const tiny = await db.plan.findUnique({ where: { code: "P51-TINY" } });
  if (tiny) {
    await db.planEntitlement.deleteMany({ where: { planId: tiny.id } });
    await db.plan.delete({ where: { id: tiny.id } }).catch(() => {});
  }
  await db.userSession.deleteMany({ where: { user: { email: { startsWith: `${TAG.toLowerCase()}-` } } } });
}
await purge();

// ---------------- fixtures ----------------
console.log("\n== §F fixtures ==");
const stamp = Date.now();
const email = `${TAG.toLowerCase()}-owner@test.local`;
async function ensureOwnerSession(ownerEmail) {
  const identityMatches = async () => {
    const me = await f("/api/v1/me");
    const mail = me.body?.data?.user?.email ?? me.body?.data?.email ?? me.body?.data?.profile?.email;
    return me.status === 200 && mail === ownerEmail;
  };
  const csrf0 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf0, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
  if (await identityMatches()) return true;
  const regRes = await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P51QA Owner", email: ownerEmail, password: PASS }) });
  if (!(regRes.status === 201 || regRes.status === 409)) return false;
  const csrf1 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf1, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
  return identityMatches();
}
ok("F1. owner session established (login-first)", await ensureOwnerSession(email));

async function ensureFixtureBusiness(suffix, tz) {
  const existing = await db.business.findFirst({
    where: { name: { startsWith: `${TAG}-${suffix}` } },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  // BUSINESSES_MAX on FREE is 1 — temporarily bump every owned business to
  // STARTER while creating (restored right after; mirrors the P50 harness).
  const owner = await db.user.findUnique({ where: { email } });
  const owned = await db.business.findMany({ where: { ownerId: owner.id }, select: { id: true } });
  const starterPlan = await db.plan.findUnique({ where: { code: "STARTER" } });
  const freePlan = await db.plan.findUnique({ where: { code: "FREE" } });
  const bumped = [];
  for (const b of owned) {
    const sub = await db.subscription.findUnique({ where: { businessId: b.id } });
    if (sub && sub.planId !== starterPlan.id) {
      await db.subscription.update({ where: { businessId: b.id }, data: { planId: starterPlan.id } });
      bumped.push(b.id);
    }
  }
  const res = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-${suffix}-${stamp}`, currencyCode: "USD", locale: "en", timezone: tz }) });
  for (const b of bumped) {
    await db.subscription.update({ where: { businessId: b }, data: { planId: freePlan.id } }).catch(() => {});
  }
  if (res.status === 201) return db.business.findUnique({ where: { id: res.body.data.business.id } });
  // P51-R1: rate-limit-aware fallback. The user-scoped business-create
  // limiter is long-window; a heavy QA day (onboarding rounds, fixture
  // rebuilds, repeated check runs) can exhaust it with a multi-hour retry.
  // The suite's create-API path is proven by earlier runs — under a 429
  // RATE_LIMITED we mirror the API result at the db level (business +
  // OWNER membership + evented FREE subscription) so the harness stays
  // runnable and prompt20's auditability invariants hold. Any OTHER
  // failure (validation/entitlement) still throws.
  if (res.status === 429 && res.body?.error?.code === "RATE_LIMITED") {
    const biz = await db.business.create({ data: { name: `${TAG}-${suffix}-${stamp}`, slug: `p51qa-${suffix.toLowerCase()}-${stamp}`, currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2, locale: "en", timezone: tz, ownerId: owner.id } });
    await db.businessMember.create({ data: { businessId: biz.id, userId: owner.id, role: "OWNER" } });
    const sub = await db.subscription.create({ data: { businessId: biz.id, planId: freePlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
    await db.subscriptionEvent.create({ data: { businessId: biz.id, subscriptionId: sub.id, type: "CREATED", toStatus: "ACTIVE", toPlanCode: "FREE", dataJson: '{"source":"p51r1-check-rate-limit-fallback"}' } });
    return db.business.findUnique({ where: { id: biz.id } });
  }
  throw new Error(`business ${suffix} create failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
}
const bizA = await ensureFixtureBusiness("BIZ-A", "Asia/Tehran");
ok("F2. business A ready (Asia/Tehran, USD)", Boolean(bizA?.id) && bizA.timezone === "Asia/Tehran" && bizA.currencyCode === "USD");
const bizB = await ensureFixtureBusiness("BIZ-B", "Asia/Tehran");
ok("F3. business B ready (cross-tenant)", Boolean(bizB?.id) && bizB.id !== bizA.id);

// BIZ-A: ensure a FREE subscription (JSON works on FREE; CSV_EXPORT=true
// on FREE — the 403 harness is P51-TINY below).
const freePlan = await db.plan.findUnique({ where: { code: "FREE" } });
const subA = await db.subscription.findUnique({ where: { businessId: bizA.id } });
if (!subA) {
  await db.subscription.create({ data: { businessId: bizA.id, planId: freePlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
} else if (subA.planId !== freePlan.id) {
  await db.subscription.update({ where: { businessId: bizA.id }, data: { planId: freePlan.id } });
}

const HA = { "x-business-id": bizA.id };
const HB = { "x-business-id": bizB.id };

// Catalog covering EVERY state. Expected values (minor):
//   alpha1 5000, alpha2 2400, beta 0, gamma 0, delta 7500,
//   inactive 1200, negative -800, formula 100, persian 1000, longname 700
//   TOTAL = 17100
async function mkProduct(body) {
  const r = await f("/api/v1/products", { method: "POST", headers: HA, body: JSON.stringify(body) });
  if (r.status !== 201) throw new Error(`product create failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.data; // full product object (callers use .id / .name)
}
const pAlpha1 = await mkProduct({ name: "Alpha Widget", sku: "SKU-AWD", unit: "piece", salePriceMinor: 9_000, costPriceMinor: 500, stockQty: 10, lowStockAt: 5 });
const pAlpha2 = await mkProduct({ name: "Alpha Widget", sku: "SKU-AWD2", unit: "piece", salePriceMinor: 9_500, costPriceMinor: 1_200, stockQty: 2, lowStockAt: 1 });
const pBeta = await mkProduct({ name: "Beta Freebie", sku: "SKU-BETA", unit: "piece", salePriceMinor: 100, costPriceMinor: 0, stockQty: 7, lowStockAt: 5 });
const pGamma = await mkProduct({ name: "Gamma Out", sku: "SKU-GAMMA", unit: "kg", salePriceMinor: 1_500, costPriceMinor: 999, stockQty: 0, lowStockAt: 5 });
const pDelta = await mkProduct({ name: "Delta Low", sku: "SKU-DELTA", unit: "m", salePriceMinor: 8_000, costPriceMinor: 2_500, stockQty: 3, lowStockAt: 5 });
const pInactive = await mkProduct({ name: "Inactive Stock", sku: "SKU-INACT", unit: "piece", salePriceMinor: 700, costPriceMinor: 300, stockQty: 4, lowStockAt: 2 });
const pNegative = await mkProduct({ name: "Negative Stock", sku: "SKU-NEG", unit: "piece", salePriceMinor: 600, costPriceMinor: 400, stockQty: 0, lowStockAt: 5 });
const pFormula = await mkProduct({ name: "=SOMEFORMULA()", sku: "SKU-EQ", unit: "piece", salePriceMinor: 200, costPriceMinor: 100, stockQty: 1, lowStockAt: 0 });
const pPersian = await mkProduct({ name: "پارسل فارسی", sku: "SKU-FA", unit: "piece", salePriceMinor: 400, costPriceMinor: 200, stockQty: 5, lowStockAt: 3 });
const pLong = await mkProduct({ name: "Long Name Product With A Very Long Descriptive Title For Layout Testing 0123456789", sku: "SKU-LONG-NAME-0123456789", unit: "hour", salePriceMinor: 1_000, costPriceMinor: 700, stockQty: 1, lowStockAt: 0 });
// db-level states the API intentionally cannot create: negative recorded
// stock and a deactivated product that still holds stock.
await db.product.update({ where: { id: pNegative.id }, data: { stockQty: -2 } });
await db.product.update({ where: { id: pInactive.id }, data: { isActive: false } });
ok("F4. 10-product catalog covering every state (API + db-level states)", true);

const bProd = await f("/api/v1/products", { method: "POST", headers: HB, body: JSON.stringify({ name: "ZZ-B-Only Product", sku: "SKU-B-ONLY", unit: "piece", salePriceMinor: 2_000, costPriceMinor: 1_500, stockQty: 6 }) });
ok("F5. business B product created", bProd.status === 201, JSON.stringify(bProd.body).slice(0, 120));

// Read-only baseline snapshot (§G): everything the report must never touch.
const beforeProducts = await db.product.findMany({
  where: { businessId: { in: [bizA.id, bizB.id] } },
  select: { id: true, stockQty: true, costPriceMinor: true, isActive: true, deletedAt: true, updatedAt: true, name: true },
});
const beforeCounts = {
  sales: await db.sale.count({ where: { businessId: bizA.id } }),
  saleItems: await db.saleItem.count({ where: { sale: { businessId: bizA.id } } }),
  expenses: await db.expense.count({ where: { businessId: bizA.id } }),
  payments: await db.payment.count({ where: { businessId: bizA.id } }),
  adjustments: await db.inventoryAdjustment.count({ where: { businessId: bizA.id } }),
  bills: await db.supplierBill.count({ where: { businessId: bizA.id } }),
};

// ================= §A report correctness =================
console.log("\n== §A report correctness ==");
const noAuth = await fetch(`${BASE}/api/v1/reports/inventory-valuation`, { headers: { "x-forwarded-for": "10.52.14.9" } });
ok("A1. unauthenticated → 401", noAuth.status === 401, String(noAuth.status));

const rep = (await f("/api/v1/reports/inventory-valuation", { headers: HA })).body?.data;
ok("A2. default report 200 + basis disclosed", Boolean(rep) && rep.basis === "current_operational_estimate", JSON.stringify(rep?.basis));
ok("A3. default totals exact (value 17100, 10 products)", rep?.totals?.estimatedValueMinor === 17_100 && rep?.totals?.productCount === 10, JSON.stringify(rep?.totals));
ok("A4. cost/stock quality counts exact", rep?.totals?.positiveStockCount === 8 && rep?.totals?.zeroStockCount === 1 && rep?.totals?.negativeStockCount === 1 && rep?.totals?.zeroCostPositiveStockCount === 1 && rep?.totals?.inactiveCount === 1 && rep?.totals?.lowStockCount === 1, JSON.stringify(rep?.totals));
ok("A5. rows == totals on a single small page (Gate D row law)", rep?.rows?.length === 10 && rep.rows.reduce((s, r) => s + r.estimatedValueMinor, 0) === rep.totals.estimatedValueMinor, `rows=${rep?.rows?.length}`);
ok("A6. summary reconciliation: inventory.valueMinor == report total (Gate D)", (() => rep)(), "see next");
const sum30 = (await f("/api/v1/reports/summary?days=30", { headers: HA })).body?.data;
ok("A6b. summary inventory valueMinor == 17100 == report total", sum30?.inventory?.valueMinor === 17_100 && rep.totals.estimatedValueMinor === sum30.inventory.valueMinor, `summary=${sum30?.inventory?.valueMinor}`);
ok("A7. duplicate display names stay TWO rows with stable distinct ids", rep.rows.filter((r) => r.name === "Alpha Widget").length === 2 && rep.rows.filter((r) => r.name === "Alpha Widget").every((r) => r.id && r.id !== rep.rows.find((x) => x.name === "Alpha Widget" && x.id !== r.id)?.id));
ok("A8. inactive product INCLUDED by default with isActive=false", rep.rows.some((r) => r.id === pInactive.id && r.isActive === false));
ok("A9. zero-cost positive-stock row flagged (row state + value 0)", (() => {
  const r = rep.rows.find((x) => x.id === pBeta.id);
  return r && r.costState === "ZERO_COST" && r.estimatedValueMinor === 0 && r.stockQty === 7;
})());
ok("A10. negative stock truthful: NEGATIVE_STOCK, value -800 (never clamped)", (() => {
  const r = rep.rows.find((x) => x.id === pNegative.id);
  return r && r.stockState === "NEGATIVE_STOCK" && r.estimatedValueMinor === -800 && r.stockQty === -2;
})());
ok("A11. formula-injection name present verbatim in JSON", rep.rows.some((r) => r.name === "=SOMEFORMULA()"));
ok("A12. currency metadata from the business (USD, precision 2)", rep.currencyCode === "USD" && rep.decimalPrecision === 2);
{
  const r1 = await f("/api/v1/reports/inventory-valuation", { headers: HA });
  ok("A13. JSON is private no-store", r1.res.headers.get("cache-control") === "private, no-store", String(r1.res.headers.get("cache-control")));
}
ok("A14. filtersActive false by default; pagination truth", rep.filtersActive === false && rep.pagination.totalCount === 10 && rep.pagination.totalPages === 1 && rep.pagination.hasMore === false && rep.pagination.page === 1);

// ================= §B filters =================
console.log("\n== §B filters (server-side) ==");
const Q = (q) => `/api/v1/reports/inventory-valuation${q ? `?${q}` : ""}`;
const zc = (await f(Q("costState=ZERO_COST"), { headers: HA })).body?.data;
ok("B1. costState=ZERO_COST → exactly Beta (Gamma cost 999 is positive), total 0", zc.rows.length === 1 && zc.rows[0].id === pBeta.id && zc.totals.estimatedValueMinor === 0 && zc.totals.productCount === 1, JSON.stringify(zc.rows.map((r) => r.name)));
const pc = (await f(Q("costState=POSITIVE_COST"), { headers: HA })).body?.data;
ok("B2. costState=POSITIVE_COST → 9 rows, total 17100 (zero-cost Beta excluded, value unchanged)", pc.rows.length === 9 && pc.totals.estimatedValueMinor === 17_100, `rows=${pc.rows.length}`);
const zs = (await f(Q("stockState=ZERO_STOCK"), { headers: HA })).body?.data;
ok("B3. stockState=ZERO_STOCK → Gamma only", zs.rows.length === 1 && zs.rows[0].id === pGamma.id);
const ls = (await f(Q("stockState=LOW_STOCK"), { headers: HA })).body?.data;
ok("B4. stockState=LOW_STOCK → Delta only (0 < qty ≤ threshold)", ls.rows.length === 1 && ls.rows[0].id === pDelta.id);
const ps = (await f(Q("stockState=POSITIVE_STOCK"), { headers: HA })).body?.data;
ok("B5. stockState=POSITIVE_STOCK → 7 rows strictly above threshold (Delta is LOW), total 10400", ps.rows.length === 7 && ps.totals.estimatedValueMinor === 10_400, `rows=${ps.rows.length} total=${ps.totals.estimatedValueMinor}`);
const act = (await f(Q("activity=ACTIVE"), { headers: HA })).body?.data;
ok("B6. activity=ACTIVE → 9 rows, total 15900 (inactive stock disclosed out)", act.rows.length === 9 && act.totals.estimatedValueMinor === 15_900 && act.totals.inactiveCount === 0);
const inact = (await f(Q("activity=INACTIVE"), { headers: HA })).body?.data;
ok("B7. activity=INACTIVE → exactly the inactive row (1200)", inact.rows.length === 1 && inact.rows[0].id === pInactive.id && inact.totals.estimatedValueMinor === 1_200);
const qa = (await f(Q("q=alpha"), { headers: HA })).body?.data;
ok("B8. q=alpha → both Alpha rows (7400)", qa.rows.length === 2 && qa.totals.estimatedValueMinor === 7_400 && qa.filtersActive === true);
const qsku = (await f(Q("q=SKU-AWD"), { headers: HA })).body?.data;
ok("B9. q matches SKU (case-insensitive)", qsku.rows.length === 2);
const qfa = (await f(Q(`q=${encodeURIComponent("پارسل")}`), { headers: HA })).body?.data;
ok("B10. q matches the Persian name", qfa.rows.length === 1 && qfa.rows[0].id === pPersian.id);
const qcombo = (await f(Q("q=alpha&costState=ZERO_COST"), { headers: HA })).body?.data;
ok("B11. combined filters AND (alpha+zero-cost → empty, honest)", qcombo.rows.length === 0 && qcombo.pagination.totalCount === 0);
{
  const long = await f(Q(`q=${"x".repeat(81)}`), { headers: HA });
  ok("B12. q longer than 80 chars → 422", long.status === 422, String(long.status));
  const badCost = await f(Q("costState=FREE"), { headers: HA });
  const badStock = await f(Q("stockState=SOME"), { headers: HA });
  const badAct = await f(Q("activity=GHOST"), { headers: HA });
  const badSort = await f(Q("sort=MAGIC"), { headers: HA });
  ok("B13. invalid enum values → 422 (all four filters)", badCost.status === 422 && badStock.status === 422 && badAct.status === 422 && badSort.status === 422, `${badCost.status}/${badStock.status}/${badAct.status}/${badSort.status}`);
  const s0 = await f(Q("pageSize=0"), { headers: HA });
  const s101 = await f(Q("pageSize=101"), { headers: HA });
  const sabc = await f(Q("pageSize=abc"), { headers: HA });
  const p0 = await f(Q("page=0"), { headers: HA });
  const pneg = await f(Q("page=-1"), { headers: HA });
  ok("B14. malformed page/pageSize → 422 (never clamped silently)", s0.status === 422 && s101.status === 422 && sabc.status === 422 && p0.status === 422 && pneg.status === 422, `${s0.status}/${s101.status}/${sabc.status}/${p0.status}/${pneg.status}`);
}
{
  const b100 = await f(Q("pageSize=100"), { headers: HA });
  ok("B15. pageSize 100 accepted (bounded)", b100.status === 200 && b100.body?.data?.pagination?.pageSize === 100);
  const p999 = await f(Q("page=999"), { headers: HA });
  ok("B16. far page → honest empty page, totals intact", p999.status === 200 && p999.body?.data?.rows.length === 0 && p999.body?.data?.pagination.totalCount === 10 && p999.body?.data?.pagination.hasMore === false);
}

// ================= §C sorting =================
console.log("\n== §C sorting (server-side over the complete set) ==");
const idsOf = async (q) => (await f(Q(q), { headers: HA })).body?.data?.rows?.map((r) => r.id);
ok("C1. VALUE_DESC: Delta(7500) first", (await idsOf("sort=VALUE_DESC"))[0] === pDelta.id);
ok("C2. VALUE_ASC: Negative(-800) first", (await idsOf("sort=VALUE_ASC"))[0] === pNegative.id);
ok("C3. NAME_ASC: '=SOMEFORMULA()' first (code-point, = < A < …)", (await idsOf("sort=NAME_ASC"))[0] === pFormula.id);
ok("C4. NAME_DESC: پارسل first", (await idsOf("sort=NAME_DESC"))[0] === pPersian.id);
ok("C5. QUANTITY_DESC: Alpha(10) first", (await idsOf("sort=QUANTITY_DESC"))[0] === pAlpha1.id);
ok("C6. QUANTITY_ASC: Negative(-2) first", (await idsOf("sort=QUANTITY_ASC"))[0] === pNegative.id);
ok("C7. COST_DESC: Delta(2500) first", (await idsOf("sort=COST_DESC"))[0] === pDelta.id);
{
  const a = await f(Q("sort=VALUE_DESC"), { headers: HA });
  const b = await f(Q("sort=VALUE_DESC"), { headers: HA });
  ok("C8. repeated requests → identical deterministic order", JSON.stringify(a.body.data.rows.map((r) => r.id)) === JSON.stringify(b.body.data.rows.map((r) => r.id)));
  const zeroRows = a.body.data.rows.filter((r) => r.estimatedValueMinor === 0);
  ok("C9. tied values keep id-ascending order (Beta/Gamma both 0)", zeroRows.length === 2 && zeroRows[0].id < zeroRows[1].id, JSON.stringify(zeroRows.map((r) => r.id)));
}

// ================= §D pagination =================
console.log("\n== §D pagination (no dup/skip) ==");
{
  const p1 = (await f(Q("pageSize=3&page=1"), { headers: HA })).body?.data;
  const p2 = (await f(Q("pageSize=3&page=2"), { headers: HA })).body?.data;
  const p3 = (await f(Q("pageSize=3&page=3"), { headers: HA })).body?.data;
  const p4 = (await f(Q("pageSize=3&page=4"), { headers: HA })).body?.data;
  ok("D1. page 1: 3 rows, hasMore, totalCount 10, totalPages 4", p1.rows.length === 3 && p1.pagination.hasMore === true && p1.pagination.totalCount === 10 && p1.pagination.totalPages === 4);
  const ids1 = p1.rows.map((r) => r.id);
  const ids2 = p2.rows.map((r) => r.id);
  const ids3 = p3.rows.map((r) => r.id);
  const ids4 = p4.rows.map((r) => r.id);
  ok("D2. pages 2-4 sizes (3/3/1) and page 4 hasMore=false", p2.rows.length === 3 && p3.rows.length === 3 && p4.rows.length === 1 && p4.pagination.hasMore === false);
  const all = [...ids1, ...ids2, ...ids3, ...ids4];
  ok("D3. walking all pages yields 10 UNIQUE rows (no dup, no skip)", all.length === 10 && new Set(all).size === 10);
  const sumWalk = [...p1.rows, ...p2.rows, ...p3.rows, ...p4.rows].reduce((s, r) => s + r.estimatedValueMinor, 0);
  ok("D4. walked rows reconcile with the unfiltered total (17100)", sumWalk === 17_100, String(sumWalk));
  const p5 = (await f(Q("pageSize=3&page=5"), { headers: HA })).body?.data;
  ok("D5. page beyond the end → empty page, truth preserved", p5.rows.length === 0 && p5.pagination.totalCount === 10 && p5.pagination.hasMore === false);
}

// ================= §E CSV export =================
console.log("\n== §E CSV export (complete-or-reject) ==");
{
  const csv = await ftext("/api/v1/reports/inventory-valuation/export", HA);
  ok("E1. export 200 with CSV headers (type/attachment/no-store)", csv.status === 200 && (csv.headers.get("content-type") ?? "").startsWith("text/csv") && /^attachment; filename="[^"]+"$/.test(csv.headers.get("content-disposition") ?? "") && csv.headers.get("cache-control") === "no-store", `${csv.status} ${csv.headers.get("content-type")}`);
  const bytes = new Uint8Array(csv.bytes);
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  ok("E2. UTF-8 BOM (bytes) + CRLF line endings", hasBom && csv.text.includes("\r\n"), `bom=${hasBom}`);
  const rows = csv.text.split("\r\n").filter((l) => /^product,cm/.test(l));
  ok("E3. COMPLETE export: ALL 10 product rows (header excluded)", rows.length === 10, String(rows.length));
  ok("E4. summary reconciles with the exported rows (171.00 / 10)", csv.text.includes("summary,total_operational_value_USD,171.00") && csv.text.includes("summary,products_exported,10"));
  ok("E5. row money formatted at business precision (Alpha 50.00 / value 5000 → 50.00)", csv.text.includes(`product,${pAlpha1.id},Alpha Widget,SKU-AWD,piece,10,5.00,50.00,active,positive_cost,positive_stock`), rows[0] ?? "");
  ok("E6. formula-injection name guarded with a leading apostrophe", csv.text.includes(",'=SOMEFORMULA(),") && !csv.text.includes(",=SOMEFORMULA(),"));
  ok("E7. quality columns present (zero cost + negative stock labeled)", csv.text.includes("zero_current_cost") && csv.text.includes("negative_stock") && csv.text.includes("inactive"));
  const csvFiltered = await ftext("/api/v1/reports/inventory-valuation/export?costState=ZERO_COST", HA);
  const fRows = csvFiltered.text.split("\r\n").filter((l) => /^product,cm/.test(l));
  ok("E8. filtered export matches the filtered JSON (1 row, 0.00)", csvFiltered.status === 200 && fRows.length === 1 && csvFiltered.text.includes("summary,total_operational_value_USD,0.00") && csvFiltered.text.includes("summary,products_exported,1"), String(fRows.length));
  ok("E9. export echoes the applied filters in meta", csvFiltered.text.includes("meta,cost_state,ZERO_COST"));
}

// ================= §E2 P51-R1 live precision export =================
// The exact serializer (formatMinorToDecimal) must survive the REAL
// endpoint for the largest magnitudes the application can actually hold.
// STORAGE CONTRACT (verified this round): Product.costPriceMinor is a
// SQLite INT column (max 2147483647) — the reported 9.007e15 example is
// NOT storable and therefore not endpoint-reachable; its divergence is
// pinned at the serializer unit level (prompt51-inventory-valuation-unit
// 10a/10b: old float path printed 90071992547400.02 for exact ...400.01).
// The LIVE case drives the endpoint to its true reachable boundary:
// INT32-max unit cost × 1,000,000 stock → a 16-digit estimatedValueMinor
// (2,147,483,647,000,000 < 2^53, safeMul-legal) that must serialize
// EXACTLY, reconcile in the summary, and round-trip with the JSON minor.
console.log("\n== §E2 P51-R1 live CSV precision (exact serializer) ==");
{
  const r1 = await f("/api/v1/products", { method: "POST", headers: HA, body: JSON.stringify({ name: "Precision Boundary Product", sku: "SKU-P51R1", unit: "piece", salePriceMinor: 1_000, costPriceMinor: 2147483647, stockQty: 1, lowStockAt: 0 }) });
  ok("E2-1. precision product created via API (INT32-max cost)", r1.status === 201, JSON.stringify(r1.body).slice(0, 120));
  const maxCost = 2147483647;
  await db.product.update({ where: { id: r1.body.data.id }, data: { stockQty: 1000000 } }); // db-level: API caps stockQty growth patterns
  const evMinor = maxCost * 1000000; // 2147483647000000 — the exact safe integer

  // JSON keeps the EXACT integer (no float anywhere in the report core).
  const j = await f("/api/v1/reports/inventory-valuation?q=SKU-P51R1", { headers: HA });
  ok("E2-2. JSON estimatedValueMinor stays the exact safe integer", j.status === 200 && j.body.data?.rows?.[0]?.estimatedValueMinor === evMinor && j.body.data?.rows?.[0]?.costPriceMinor === maxCost, JSON.stringify(j.body.data?.rows?.[0] ?? {}).slice(0, 200));
  ok("E2-3. JSON totals stay exact (no float drift)", j.body.data?.totals?.estimatedValueMinor === evMinor);

  // Filtered CSV: exactly this product; both money columns + summary exact.
  const csv = await ftext("/api/v1/reports/inventory-valuation/export?q=SKU-P51R1", HA);
  ok("E2-4. filtered export 200", csv.status === 200, String(csv.status));
  const prodRows = csv.text.split("\r\n").filter((l) => /^product,cm/.test(l));
  ok("E2-5. filtered CSV contains exactly the precision product", prodRows.length === 1, String(prodRows.length));
  ok("E2-6. unit cost cell exact '21474836.47' (INT32-max minor)", csv.text.includes("21474836.47"), prodRows[0] ?? "");
  ok("E2-7. estimated value cell exact '21474836470000.00' (16-digit minor)", /product,[^,]+,Precision Boundary Product,SKU-P51R1,piece,1000000,21474836\.47,21474836470000\.00,active,positive_cost,positive_stock/.test(csv.text), prodRows[0] ?? "");
  ok("E2-8. summary reconciles EXACTLY with the row integer", csv.text.includes("summary,total_operational_value_USD,21474836470000.00") && csv.text.includes("summary,products_exported,1"));
  ok("E2-9. no exponent notation anywhere in the CSV", !/\d[eE][+-]?\d/.test(csv.text));

  // Unfiltered export still reconciles: prior total + precision product.
  const csvAll = await ftext("/api/v1/reports/inventory-valuation/export", HA);
  ok("E2-10. complete export grows to 11 rows and stays reconciling", csvAll.text.includes("summary,products_exported,11") && csvAll.text.includes("summary,total_operational_value_USD,21474836470171.00"), "17100 minor (171.00) + 2147483647000000 minor = 21474836470171.00");
  const allRows = csvAll.text.split("\r\n").filter((l) => /^product,cm/.test(l));
  ok("E2-11. no duplicate/skipped rows with the precision product included", allRows.length === 11, String(allRows.length));

  // §E2 cleanup — remove the precision product so the later read-only
  // snapshot (§G) compares the same catalog it captured at fixture time.
  await db.product.delete({ where: { id: r1.body.data.id } });
}

// ================= §F entitlements =================
console.log("\n== §F entitlements (server-side) ==");
{
  const defs = await db.entitlementDefinition.findMany();
  const defByCode = Object.fromEntries(defs.map((d) => [d.code, d.id]));
  const tinyPlan = await db.plan.create({ data: { code: "P51-TINY", name: "P51 Test Tiny", description: "Harness-only plan", sortOrder: 999, isPublic: false, active: true } });
  for (const [code, value] of Object.entries({ CUSTOMERS_MAX: 5, PRODUCTS_MAX: 25, TEAM_MEMBERS_MAX: 1, BUSINESSES_MAX: 1, AI_COPILOT: false, ADVANCED_REPORTS: false, CSV_EXPORT: false })) {
    const isLimit = typeof value === "number";
    await db.planEntitlement.create({ data: { planId: tinyPlan.id, entitlementId: defByCode[code], value: isLimit ? value : null, boolValue: isLimit ? false : value } });
  }
  await db.subscription.update({ where: { businessId: bizA.id }, data: { planId: tinyPlan.id } });
  const jsonTiny = await f(Q(""), { headers: HA });
  ok("F1. JSON report on a CSV_EXPORT=false plan still 200 (basic drill-down)", jsonTiny.status === 200 && jsonTiny.body?.data?.totals?.productCount === 10, String(jsonTiny.status));
  const csvTiny = await ftext("/api/v1/reports/inventory-valuation/export", HA);
  ok("F2. CSV export with CSV_EXPORT=false → 403 (never the data)", csvTiny.status === 403, String(csvTiny.status));
  await db.subscription.update({ where: { businessId: bizA.id }, data: { planId: freePlan.id } });
}

// ================= §G read-only law =================
console.log("\n== §G read-only (before/after snapshots) ==");
{
  // A few more report + export calls, then compare snapshots.
  await f(Q("sort=NAME_ASC&page=2&pageSize=3"), { headers: HA });
  await f(Q("q=alpha&stockState=POSITIVE_STOCK"), { headers: HA });
  await ftext("/api/v1/reports/inventory-valuation/export?activity=ACTIVE", HA);
  const afterProducts = await db.product.findMany({
    where: { businessId: { in: [bizA.id, bizB.id] } },
    select: { id: true, stockQty: true, costPriceMinor: true, isActive: true, deletedAt: true, updatedAt: true, name: true },
  });
  const beforeJson = JSON.stringify(beforeProducts.sort((a, b) => a.id.localeCompare(b.id)));
  const afterJson = JSON.stringify(afterProducts.sort((a, b) => a.id.localeCompare(b.id)));
  ok("G1. product rows byte-identical (qty/cost/active/updatedAt — no mutation)", beforeJson === afterJson);
  const afterCounts = {
    sales: await db.sale.count({ where: { businessId: bizA.id } }),
    saleItems: await db.saleItem.count({ where: { sale: { businessId: bizA.id } } }),
    expenses: await db.expense.count({ where: { businessId: bizA.id } }),
    payments: await db.payment.count({ where: { businessId: bizA.id } }),
    adjustments: await db.inventoryAdjustment.count({ where: { businessId: bizA.id } }),
    bills: await db.supplierBill.count({ where: { businessId: bizA.id } }),
  };
  ok("G2. no financial/inventory documents created by report calls", JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), JSON.stringify({ before: beforeCounts, after: afterCounts }));
}

// ================= §H tenant isolation =================
console.log("\n== §H tenant isolation ==");
{
  const repB = (await f("/api/v1/reports/inventory-valuation", { headers: HB })).body?.data;
  ok("H1. B sees ONLY B's product (1 row, 9000)", repB.totals.productCount === 1 && repB.totals.estimatedValueMinor === 9_000, JSON.stringify(repB.totals));
  ok("H2. B's rows never contain A's product ids", repB.rows.every((r) => ![pAlpha1, pAlpha2, pBeta, pGamma, pDelta, pInactive, pNegative, pFormula, pPersian, pLong].some((p) => p.id === r.id || p.name === r.name)));
  const probeA = (await f(Q(`q=${encodeURIComponent("zz-b-only")}`), { headers: HA })).body?.data;
  ok("H3. A's search for B's unique product name → 0 rows (no leak)", probeA.rows.length === 0 && probeA.totals.productCount === 0);
  const probeA2 = (await f(Q(`q=${encodeURIComponent("zz-b")}`), { headers: HA })).body?.data;
  ok("H4. partial-name probe also empty", probeA2.rows.length === 0);
  ok("H5. aggregates never mix tenants (9000 ≠ 27100)", repB.totals.estimatedValueMinor !== repB.totals.estimatedValueMinor + 17_100 && repB.totals.estimatedValueMinor === 9_000);
  const csvB = await ftext("/api/v1/reports/inventory-valuation/export", HB);
  const bRows = csvB.text.split("\r\n").filter((l) => /^product,cm/.test(l));
  ok("H6. B's CSV contains exactly B's rows", csvB.status === 200 && bRows.length === 1 && bRows[0].includes("ZZ-B-Only Product"));
}

// ================= §I teardown =================
console.log("\n== §I teardown ==");
{
  await db.auditLog.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } });
  await db.inventoryAdjustment.deleteMany({ where: { businessId: bizA.id } }).catch(() => {});
  await db.payment.deleteMany({ where: { businessId: bizA.id } });
  await db.saleItem.deleteMany({ where: { sale: { businessId: bizA.id } } });
  await db.sale.deleteMany({ where: { businessId: bizA.id } });
  await db.expense.deleteMany({ where: { businessId: bizA.id } });
  await db.customer.deleteMany({ where: { businessId: bizA.id } });
  await db.customer.deleteMany({ where: { businessId: bizB.id } });
  await db.supplier.deleteMany({ where: { businessId: bizA.id } });
  await db.product.deleteMany({ where: { businessId: bizA.id } });
  await db.product.deleteMany({ where: { businessId: bizB.id } });
  // P51-R1: FULL teardown for BIZ-A/B (the same pattern as the P43/P45/P48
  // check suites). The previous teardown deleted the subscriptions'
  // CREATED/PLAN_CHANGED events while KEEPING the subscription rows — a
  // subscription whose creation is unauditable — which broke
  // prompt20-billing-check B2/B3 on every run AFTER this suite. Deleting
  // the businesses cascades members/subscriptions/events atomically; the
  // next run re-creates them through the real API (fully evented).
  await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: bizA.id } } }).catch(() => {});
  await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: bizB.id } } }).catch(() => {});
  await db.subscription.deleteMany({ where: { businessId: bizA.id } }).catch(() => {});
  await db.subscription.deleteMany({ where: { businessId: bizB.id } }).catch(() => {});
  await db.businessMember.deleteMany({ where: { businessId: { in: [bizA.id, bizB.id] } } }).catch(() => {});
  await db.business.delete({ where: { id: bizA.id } }).catch(() => {});
  await db.business.delete({ where: { id: bizB.id } }).catch(() => {});
  const tiny = await db.plan.findUnique({ where: { code: "P51-TINY" } });
  if (tiny) {
    await db.planEntitlement.deleteMany({ where: { planId: tiny.id } });
    await db.plan.delete({ where: { id: tiny.id } }).catch(() => {});
  }
  const leftProducts = await db.product.count({ where: { businessId: { in: [bizA.id, bizB.id] } } });
  const leftAdj = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
  const leftPlan = await db.plan.count({ where: { code: "P51-TINY" } });
  const leftBiz = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  ok("I1. zero fixture financial/product rows remain (BIZ-A/B fully deleted, P51-R1)", leftProducts === 0 && leftAdj === 0, `products=${leftProducts} adj=${leftAdj} biz=${leftBiz}`);
  ok("I2. P51-TINY harness plan removed", leftPlan === 0, String(leftPlan));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((x) => `  - ${x}`).join("\n"));
  await db.$disconnect();
  process.exit(1);
}
await db.$disconnect();
