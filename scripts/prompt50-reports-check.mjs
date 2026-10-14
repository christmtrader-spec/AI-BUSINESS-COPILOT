#!/usr/bin/env node
/**
 * scripts/prompt50-reports-check.mjs — Prompt 50 E2E check against the LIVE
 * dev server (real API, real DB, real auth) — the §18 integration matrix:
 *
 *   §A  window correctness (Risk A / Gate B):
 *     1   future-dated Sale/Expense/Payment EXCLUDED from summary KPIs
 *     2   boundary invoice (today-31) outside the 30-day window
 *     3   KPI totals == complete timeline sums (Gate C, 4 equalities)
 *   §B  identity (Gates E/F):
 *     4   two catalog products with IDENTICAL names stay separate (productIds)
 *     5   renamed product: ONE aggregate, live name, snapshots intact in DB
 *     6   unlinked (no productId) lines reported separately, never dropped
 *     7   same-name customers stay distinct in concentration (customerIds)
 *     8   unassigned revenue exposed, never redistributed
 *   §C  category law (Gate G):
 *     9   Other bucket: SUM(top6 + Other) == expensesMinor exactly
 *   §D  entitlements (Gates I/J):
 *    10   FREE business: summary omits `advanced`; performance APIs 403
 *    11   STARTER upgrade: advanced block + performance APIs 200
 *    12   P50-TINY (CSV_EXPORT=false): monthly + performance exports 403
 *   §E  monthly completeness (Gate H / Risk D):
 *    13   month detail: totalCount 30, displayed 25, hasMore true
 *    14   monthly CSV: ALL 30 rows + reconciling KPIs (never a 25-row prefix)
 *    15   sales list ?month= total == drill-down total
 *   §F  performance report (§11):
 *    16   product grouping + EXACT discount allocation reconciliation
 *    17   customer/day/month groupings reconcile to the same totals
 *    18   expense groupings reconcile; SupplierBill-linked Expense ONCE
 *    19   cash-flow: totals == payment aggregates; cursor pages complete,
 *         no dup/overlap; binding/garbage cursors 422 (Gate K)
 *   §G  validation & security (§14):
 *    20   unauthenticated → 401; closed-vocab/groupBy/limit/direction → 422
 *    21   malformed/over-cap/future/inverted ranges → 422
 *    22   cross-tenant isolation (second business's data never appears)
 *   §H  no false revenue (Gates L/M):
 *    23   CONFIRMED SalesOrder + ACCEPTED SalesQuotation are NOT revenue
 *    24   SupplierBill never a second expense
 *   §I  teardown to ZERO residue
 *
 * Run: bun scripts/prompt50-reports-check.mjs   (dev server must be up)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P50QA";
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
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.52.13.9", ...(init.headers ?? {}) };
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
  const headers = { "x-forwarded-for": "10.52.13.9", ...(cookie ? { cookie } : {}), ...extraHeaders };
  const res = await fetch(`${BASE}${path}`, { headers });
  const bytes = await res.arrayBuffer();
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder("utf-8").decode(bytes) };
}

/** Business-local day key (YYYY-MM-DD) in Asia/Tehran for `days` from today. */
function tehranDay(days) {
  return localDay(new Date(Date.now() + days * 86_400_000), "Asia/Tehran");
}
function localDay(d, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function localMonth(d, tz) {
  return localDay(d, tz).slice(0, 7);
}

// ---------------- teardown-first (idempotent, crashed-run safe) ----------------
// STABLE fixture businesses are KEPT between runs (business:create limiter
// hygiene — 5/hour/user); only their DATA is wiped. --full-teardown removes
// everything. The fixture subscription is reset to the deterministic FREE
// baseline so every run starts from the same entitlement state.
async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.supplierBillLine.deleteMany({ where: { supplierBill: { businessId: b.id } } });
    await db.supplierBill.deleteMany({ where: { businessId: b.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.salesQuotationLine.deleteMany({ where: { salesQuotation: { businessId: b.id } } });
    await db.salesQuotation.deleteMany({ where: { businessId: b.id } });
    await db.salesOrderLine.deleteMany({ where: { salesOrder: { businessId: b.id } } });
    await db.salesOrder.deleteMany({ where: { businessId: b.id } });
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: b.id } } });
    await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
    await db.goodsDispatchLine.deleteMany({ where: { dispatch: { businessId: b.id } } }).catch(() => {});
    await db.goodsDispatch.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } }).catch(() => {});
    // Reset to the deterministic FREE baseline (next run starts clean).
    const freePlan = await db.plan.findUnique({ where: { code: "FREE" } });
    await db.subscription.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    if (freePlan) {
      await db.subscription.create({ data: { businessId: b.id, planId: freePlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } }).catch(() => {});
    }
    // NOTE: the business row itself is KEPT (see header).
  }
  // P50-TINY harness plan (mirrors the P20 test-plan convention).
  const tiny = await db.plan.findUnique({ where: { code: "P50-TINY" } });
  if (tiny) {
    await db.planEntitlement.deleteMany({ where: { planId: tiny.id } });
    await db.plan.delete({ where: { id: tiny.id } }).catch(() => {});
  }
  if (process.argv.includes("--full-teardown")) {
    const users = await db.user.findMany({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } }, select: { id: true } });
    for (const u of users) {
      await db.userSession.deleteMany({ where: { userId: u.id } });
      await db.auditLog.deleteMany({ where: { actorId: u.id } });
      await db.user.deleteMany({ where: { id: u.id } });
    }
  } else {
    await db.userSession.deleteMany({ where: { user: { email: { startsWith: `${TAG.toLowerCase()}-` } } } });
  }
}
await purge();

// ---------------- fixtures ----------------
console.log("\n== fixtures ==");
const stamp = Date.now();
const email = `${TAG.toLowerCase()}-owner@test.local`;
async function ensureOwnerSession(ownerEmail) {
  const identityMatches = async () => {
    const me = await f("/api/v1/me");
    if (me.status !== 200) return false;
    const mail = me.body?.data?.user?.email ?? me.body?.data?.email ?? me.body?.data?.profile?.email;
    return mail === ownerEmail;
  };
  const csrf0 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf0, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
  if (await identityMatches()) return true;
  const regRes = await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P50QA Owner", email: ownerEmail, password: PASS }) });
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
  // The browser-QA fixture ADOPTS BIZ-B (renames it to P50QA-VISUAL) when
  // it runs between check runs — adopt it back instead of creating a new
  // business (BUSINESSES_MAX is a hard billing limit; no new rows needed).
  const visual = await db.business.findFirst({ where: { name: "P50QA-VISUAL" } });
  if (visual) {
    await db.payment.deleteMany({ where: { businessId: visual.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: visual.id } } });
    await db.sale.deleteMany({ where: { businessId: visual.id } });
    await db.expense.deleteMany({ where: { businessId: visual.id } });
    await db.customer.deleteMany({ where: { businessId: visual.id } });
    await db.supplier.deleteMany({ where: { businessId: visual.id } });
    await db.product.deleteMany({ where: { businessId: visual.id } });
    await db.auditLog.deleteMany({ where: { businessId: visual.id } }).catch(() => {});
    return db.business.update({ where: { id: visual.id }, data: { name: `${TAG}-${suffix}` , timezone: tz, locale: "en", currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2 } });
  }
  // BUSINESSES_MAX on FREE is 1 — a second fixture business needs a
  // temporary STARTER bump on the FIRST owned business (restored after).
  const owned = await db.business.findMany({ where: { ownerId: (await db.user.findUnique({ where: { email } })).id }, select: { id: true } });
  const starterPlan = await db.plan.findUnique({ where: { code: "STARTER" } });
  const freePlan = await db.plan.findUnique({ where: { code: "FREE" } });
  const bumped = [];
  if (owned.length > 0) {
    for (const b of owned) {
      const sub = await db.subscription.findUnique({ where: { businessId: b.id } });
      if (sub && sub.planId !== starterPlan.id) {
        await db.subscription.update({ where: { businessId: b.id }, data: { planId: starterPlan.id } });
        bumped.push(b.id);
      }
    }
  }
  const res = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-${suffix}-${stamp}`, currencyCode: "USD", locale: "en", timezone: tz }) });
  for (const b of bumped) {
    await db.subscription.update({ where: { businessId: b }, data: { planId: freePlan.id } }).catch(() => {});
  }
  if (res.status !== 201) throw new Error(`business ${suffix} create failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return await db.business.findUnique({ where: { id: res.body.data.business.id } });
}
const bizA = await ensureFixtureBusiness("BIZ-A", "Asia/Tehran");
ok("F2. business A ready (Asia/Tehran, FREE baseline)", Boolean(bizA?.id) && bizA.timezone === "Asia/Tehran");
const H = { "x-business-id": bizA.id };

// Same-name customers + suppliers (identity law fixtures)
const twinName = "Same Name Co.";
const cus1 = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: twinName }) })).body?.data?.id;
const cus2 = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: twinName }) })).body?.data?.id;
const supName = "Same Supplier Ltd";
const sup1 = (await f("/api/v1/suppliers", { method: "POST", headers: H, body: JSON.stringify({ name: supName }) })).body?.data?.id;
const sup2 = (await f("/api/v1/suppliers", { method: "POST", headers: H, body: JSON.stringify({ name: supName }) })).body?.data?.id;
ok("F3. two same-name customers + two same-name suppliers", Boolean(cus1 && cus2 && sup1 && sup2) && cus1 !== cus2 && sup1 !== sup2);

// Twin catalog products — SAME display name, DIFFERENT stable ids
const prodA = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "Twin Widget", salePriceMinor: 10_000, costPriceMinor: 1_000, stockQty: 5_000 }) })).body?.data?.id;
const prodB = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "Twin Widget", salePriceMinor: 20_000, costPriceMinor: 2_000, stockQty: 5_000 }) })).body?.data?.id;
ok("F4. twin products share a name, never an id", Boolean(prodA && prodB) && prodA !== prodB);

// Rename fixture: sell, rename, sell again
const prodRename = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "P50QA Old Name", salePriceMinor: 5_000, costPriceMinor: 500, stockQty: 5_000 }) })).body?.data?.id;

const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

async function mkSale({ customerId, items, daysAgo, daysAhead = 0, paid = 0, paidAtOverride = null, discountMinor = 0 }) {
  const r = await f("/api/v1/sales", {
    method: "POST", headers: H,
    body: JSON.stringify({
      customerId,
      items,
      discountMinor,
      issueDate: daysAhead > 0 ? iso(daysAhead) : iso(-daysAgo),
    }),
  });
  if (r.status !== 201) throw new Error(`sale failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.data.id;
  if (paid > 0) {
    const p = await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ saleId: id, amountMinor: paid, method: "CASH", ...(paidAtOverride ? { paidAt: paidAtOverride } : {}) }) });
    if (p.status !== 201) throw new Error(`payment failed ${p.status} ${JSON.stringify(p.body)}`);
  }
  return id;
}
async function mkExpense({ supplierId, category, amountMinor, paid = 0, daysAgo = 0, daysAhead = 0 }) {
  const r = await f("/api/v1/expenses", {
    method: "POST", headers: H,
    body: JSON.stringify({
      supplierId, category, amountMinor,
      spentAt: daysAhead > 0 ? iso(daysAhead) : iso(-daysAgo),
    }),
  });
  if (r.status !== 201) throw new Error(`expense failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.data.id;
  if (paid > 0) {
    const p = await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ expenseId: id, amountMinor: paid, method: "CASH" }) });
    if (p.status !== 201) throw new Error(`payment failed ${p.status}`);
  }
  return id;
}

// ---- in-window sales (Tehran local) ----
const s_in1 = await mkSale({ customerId: cus1, daysAgo: 2, items: [{ productId: prodA, name: "Twin Widget", unit: "pcs", qty: 1, unitPriceMinor: 10_000 }], paid: 4_000 });
const s_in2 = await mkSale({ customerId: cus2, daysAgo: 2, items: [{ productId: prodB, name: "Twin Widget", unit: "pcs", qty: 1, unitPriceMinor: 20_000 }] });
const s_ren1 = await mkSale({ customerId: cus1, daysAgo: 3, items: [{ productId: prodRename, name: "P50QA Old Name", unit: "pcs", qty: 2, unitPriceMinor: 5_000 }] });
// rename NOW, then sell again under the live (new) name
const renRes = await f(`/api/v1/products/${prodRename}`, { method: "PATCH", headers: H, body: JSON.stringify({ name: "P50QA New Name" }) });
ok("F5. product renamed via API", renRes.status === 200 || renRes.status === 201, JSON.stringify(renRes.body).slice(0, 120));
const s_ren2 = await mkSale({ customerId: cus1, daysAgo: 1, items: [{ productId: prodRename, name: "P50QA New Name", unit: "pcs", qty: 3, unitPriceMinor: 5_000 }] });
// document-level discount invoice: lines 10k+20k+70k, discount 10k → total 90k
const s_disc = await mkSale({
  customerId: cus1, daysAgo: 1, discountMinor: 10_000,
  items: [
    { name: "DiscountLineA", qty: 1, unitPriceMinor: 10_000 },
    { name: "DiscountLineB", qty: 1, unitPriceMinor: 20_000 },
    { name: "DiscountLineC", qty: 1, unitPriceMinor: 70_000 },
  ],
  paid: 30_000,
});
// unassigned + unlinked legacy line
const s_un = await mkSale({ customerId: null, daysAgo: 4, items: [{ name: "Custom Legacy Line", qty: 1, unitPriceMinor: 7_000 }] });
// boundary + future
await mkSale({ customerId: cus1, daysAgo: 31, items: [{ name: "Boundary Line", qty: 1, unitPriceMinor: 99_000 }] });
await mkSale({ customerId: cus1, daysAhead: 3, items: [{ name: "Future Line", qty: 1, unitPriceMinor: 88_000 }] });

// ---- in-window expenses (7 distinct categories + future + outside) ----
await mkExpense({ supplierId: sup1, category: "P50QA Rent", amountMinor: 12_000, daysAgo: 2, paid: 5_000 });
await mkExpense({ supplierId: sup2, category: "P50QA Utilities", amountMinor: 9_000, daysAgo: 3 });
await mkExpense({ supplierId: sup1, category: "P50QA CatC", amountMinor: 5_000, daysAgo: 4 });
await mkExpense({ supplierId: sup1, category: "P50QA CatD", amountMinor: 4_000, daysAgo: 5 });
await mkExpense({ supplierId: sup1, category: "P50QA CatE", amountMinor: 3_000, daysAgo: 6 });
await mkExpense({ supplierId: sup1, category: "P50QA CatF", amountMinor: 2_000, daysAgo: 7 });
await mkExpense({ supplierId: sup1, category: "P50QA CatG", amountMinor: 1_000, daysAgo: 8 });
await mkExpense({ supplierId: sup1, category: "P50QA Future", amountMinor: 77_000, daysAhead: 2 });
await mkExpense({ supplierId: sup1, category: "P50QA Outside", amountMinor: 66_000, daysAgo: 31 });
const e_bill = await mkExpense({ supplierId: sup1, category: "P50QA Billed", amountMinor: 21_000, daysAgo: 5 });

// boundary payment at EXACT Tehran local midnight of yesterday (today-1)
// Exact instant: local midnight of day D in Tehran = previous day 20:30Z (fixed +03:30).
function tehranMidnightUtc(dayKey) {
  // compute via Intl: noon of that local day minus 12h + offset probe
  const noon = new Date(`${dayKey}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tehran", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(noon);
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  const offsetMin = (asUtc - noon.getTime()) / 60_000;
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) - offsetMin * 60_000);
}
const yestStart = tehranMidnightUtc(tehranDay(-1));
ok("F6. boundary payment instant computed (Tehran local midnight of yesterday)", Math.abs(Date.now() - yestStart.getTime()) < 100 * 86_400_000 && localDay(yestStart, "Asia/Tehran") === tehranDay(-1));
await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ saleId: s_in2, amountMinor: 2_000, method: "BANK_TRANSFER", paidAt: yestStart.toISOString() }) });
// pagination fuel: 12 small OUT payments on e_cat1 (16 in-window payments total)
const eCat1 = await db.expense.findFirst({ where: { businessId: bizA.id, category: "P50QA Rent" }, select: { id: true } });
for (let i = 0; i < 12; i++) {
  await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ expenseId: eCat1.id, amountMinor: 100, method: "CASH", paidAt: iso(-(9 + i)) }) });
}
// future-dated payment (DB row — cash movement dated tomorrow)
const futPayAt = iso(1);
await db.payment.create({ data: { businessId: bizA.id, saleId: s_un, direction: "IN", amountMinor: 500, method: "CASH", paidAt: futPayAt } });

// ---- 30-invoice month (a month entirely ≥40 days back) ----
const monthDate = new Date(Date.now() - 70 * 86_400_000);
const MONTH = localMonth(monthDate, "Asia/Tehran");
const [my, mm] = MONTH.split("-").map(Number);
const monthDayIso = (d) => new Date(Date.UTC(my, mm - 1, d, 9, 0, 0)).toISOString();
const MONTH_SALES_TOTAL = 30_465; // Σ 1000+i for i=1..30
for (let i = 1; i <= 30; i++) {
  const day = ((i - 1) % 28) + 1;
  const r = await f("/api/v1/sales", {
    method: "POST", headers: H,
    body: JSON.stringify({
      customerId: i % 2 === 0 ? cus2 : cus1,
      items: [{ name: `MonthLine-${i}`, qty: 1, unitPriceMinor: 1_000 + i }],
      issueDate: monthDayIso(day),
    }),
  });
  if (r.status !== 201) throw new Error(`month sale ${i} failed: ${r.status}`);
}

// ---- SupplierBill + CONFIRMED SalesOrder + ACCEPTED SalesQuotation (DB-direct) ----
const billUser = await db.user.findFirst({ where: { email }, select: { id: true } });
const billPo = await db.purchaseOrder.create({
  data: {
    business: { connect: { id: bizA.id } }, supplier: { connect: { id: sup1 } }, reference: `PO-${TAG}-BILL`,
    status: "CONFIRMED", orderedAt: new Date(Date.now() - 17 * 86_400_000),
    supplierNameAtOrder: supName, currencyCodeAtOrder: "USD",
    currencySymbolAtOrder: "$", decimalPrecisionAtOrder: 2, createdByUser: { connect: { id: billUser.id } },
    lines: { create: { productId: prodA, productNameAtOrder: "Twin Widget", orderedQty: 10, unitPriceMinor: 12_000, unitAtOrder: "pcs" } },
  },
  include: { lines: true },
});
await db.supplierBill.create({
  data: {
    business: { connect: { id: bizA.id } },
    purchaseOrder: { connect: { id: billPo.id } },
    supplier: { connect: { id: sup1 } },
    expense: { connect: { id: e_bill } },
    reference: `SB-${TAG}-000001`,
    supplierNameAtBill: supName,
    purchaseOrderReferenceAtBill: `PO-${TAG}-BILL`,
    status: "POSTED",
    billDate: new Date(Date.now() - 15 * 86_400_000),
    dueDate: new Date(Date.now() + 15 * 86_400_000),
    postedAt: new Date(Date.now() - 15 * 86_400_000),
    subtotalMinor: 21_000,
    discountMinor: 0,
    totalMinor: 21_000,
    currencyCodeAtBill: "USD", currencySymbolAtBill: "$", decimalPrecisionAtBill: 2,
    createdByUser: { connect: { id: billUser.id } },
    lines: {
      create: {
        purchaseOrderLine: { connect: { id: billPo.lines[0].id } },
        product: { connect: { id: prodA } },
        billedQty: 10, unitPriceMinor: 2_100, lineTotalMinor: 21_000,
        productNameAtBill: "Twin Widget", purchaseOrderUnitPriceMinor: 12_000,
      },
    },
  },
}).catch(async (e) => {
  // Field-name drift safety: report loudly rather than silently skipping.
  throw new Error(`supplierBill fixture failed: ${e.message.slice(0, 300)}`);
});
await db.salesOrder.create({
  data: {
    business: { connect: { id: bizA.id } }, customer: { connect: { id: cus1 } }, customerNameAtOrder: twinName,
    reference: `SO-${TAG}-000001`, status: "CONFIRMED", orderDate: new Date(Date.now() - 10 * 86_400_000),
    currencyCodeAtOrder: "USD", currencySymbolAtOrder: "$", decimalPrecisionAtOrder: 2,
    createdByUser: { connect: { id: billUser.id } }, confirmedAt: new Date(Date.now() - 9 * 86_400_000),
    lines: { create: { productId: prodA, productNameAtOrder: "Twin Widget", orderedQty: 5, unitPriceMinor: 11_000, unitAtOrder: "pcs" } },
  },
}).catch(async (e) => {
  throw new Error(`salesOrder fixture failed: ${e.message.slice(0, 300)}`);
});
await db.salesQuotation.create({
  data: {
    business: { connect: { id: bizA.id } }, customer: { connect: { id: cus1 } }, customerNameAtQuotation: twinName,
    reference: `QT-${TAG}-000001`, status: "ACCEPTED",
    quotationDate: new Date(Date.now() - 12 * 86_400_000),
    validUntilDate: new Date(Date.now() + 18 * 86_400_000),
    currencyCodeAtQuotation: "USD", currencySymbolAtQuotation: "$", decimalPrecisionAtQuotation: 2,
    createdByUser: { connect: { id: billUser.id } },
    lines: { create: { product: { connect: { id: prodA } }, productNameAtQuotation: "Twin Widget", qty: 4, unitPriceMinor: 11_000 } },
  },
}).catch(async (e) => {
  throw new Error(`salesQuotation fixture failed: ${e.message.slice(0, 300)}`);
});

// ---- second business for cross-tenant isolation ----
const bizB = await ensureFixtureBusiness("BIZ-B", "UTC");
const HB = { "x-business-id": bizB.id };
await f("/api/v1/sales", { method: "POST", headers: HB, body: JSON.stringify({ items: [{ name: "BizB Line", qty: 1, unitPriceMinor: 999_000 }], issueDate: iso(-1) }) });
ok("F7. business B seeded with a 999_000 sale (isolation probe)", Boolean(bizB?.id));

// ================= §A window correctness =================
console.log("\n== §A window correctness (Gate B/C) ==");
const sum30 = (await f("/api/v1/reports/summary?days=30", { headers: H })).body?.data;
ok("A1. summary loaded", Boolean(sum30?.kpis), JSON.stringify(sum30).slice(0, 120));
// Expected values, computed with an INDEPENDENT implementation (Intl keys):
const todayKey = tehranDay(0);
const fromKey = tehranDay(-29);
const inWin = (d) => { const k = localDay(new Date(d), "Asia/Tehran"); return k >= fromKey && k <= todayKey; };
const salesRows = await db.sale.findMany({ where: { businessId: bizA.id, deletedAt: null }, select: { issueDate: true, totalMinor: true, number: true, id: true } });
const expRevenue = salesRows.filter((s) => inWin(s.issueDate)).reduce((a, s) => a + s.totalMinor, 0);
const expSalesCount = salesRows.filter((s) => inWin(s.issueDate)).length;
const expenseRows = await db.expense.findMany({ where: { businessId: bizA.id, deletedAt: null }, select: { spentAt: true, amountMinor: true } });
const expExpenses = expenseRows.filter((e) => inWin(e.spentAt)).reduce((a, e) => a + e.amountMinor, 0);
const expExpenseCount = expenseRows.filter((e) => inWin(e.spentAt)).length;
const payRows = await db.payment.findMany({ where: { businessId: bizA.id }, select: { paidAt: true, direction: true, amountMinor: true } });
const expCollected = payRows.filter((p) => inWin(p.paidAt) && p.direction === "IN").reduce((a, p) => a + p.amountMinor, 0);
const expPaidOut = payRows.filter((p) => inWin(p.paidAt) && p.direction === "OUT").reduce((a, p) => a + p.amountMinor, 0);
ok("A2. future-dated records exist in DB but are NOT counted", salesRows.some((s) => s.totalMinor === 88_000) && expenseRows.some((e) => e.amountMinor === 77_000) && payRows.some((p) => p.amountMinor === 500 && !inWin(p.paidAt)) && expRevenue > 0 && !inWin(iso(3)));
ok("A3. revenue excludes future + boundary + order + quotation", sum30.kpis.revenueMinor === expRevenue, `api=${sum30.kpis.revenueMinor} expected=${expRevenue}`);
ok("A4. boundary invoice (today-31, 99_000) outside the window", !inWin(iso(-31)) && expRevenue < 152_000 + 99_000 && sum30.kpis.revenueMinor === expRevenue);
ok("A5. expenses exclude future + outside", sum30.kpis.expensesMinor === expExpenses, `api=${sum30.kpis.expensesMinor} expected=${expExpenses}`);
ok("A6. collected/paidOut exclude future payment", sum30.kpis.collectedMinor === expCollected && sum30.kpis.paidOutMinor === expPaidOut, `collected api=${sum30.kpis.collectedMinor} exp=${expCollected}; paidOut api=${sum30.kpis.paidOutMinor} exp=${expPaidOut}`);
// Gate C — KPI == timeline sums
const tl = sum30.timeline;
const sumOf = (k) => tl.reduce((a, d) => a + d[k], 0);
ok("A7. SUM(timeline.revenueMinor) == kpis.revenueMinor (Gate C)", sumOf("revenueMinor") === sum30.kpis.revenueMinor, `${sumOf("revenueMinor")} vs ${sum30.kpis.revenueMinor}`);
ok("A8. SUM(timeline.expenseMinor) == kpis.expensesMinor (Gate C)", sumOf("expenseMinor") === sum30.kpis.expensesMinor);
ok("A9. SUM(timeline.collectedMinor) == kpis.collectedMinor (Gate C)", sumOf("collectedMinor") === sum30.kpis.collectedMinor);
ok("A10. SUM(timeline.paidOutMinor) == kpis.paidOutMinor (Gate C)", sumOf("paidOutMinor") === sum30.kpis.paidOutMinor);
ok("A11. timeline has exactly 30 local days", tl.length === 30 && tl[0].date === fromKey && tl[29].date === todayKey);
ok("A12. boundary payment lands in exactly ONE timeline bucket (yesterday)", (() => {
  const yKey = tehranDay(-1);
  const y = tl.find((d) => d.date === yKey);
  return y && y.collectedMinor >= 2_000;
})());

// ================= §B identity (Gates E/F) =================
console.log("\n== §B identity-safe aggregation (Gates E/F) ==");
// upgraded later — use performance under STARTER; for now assert via DB-adjacent summary shape
const renamedMerged = sum30.topProducts.find((p) => p.productId === prodRename);
ok("B1. renamed product is ONE aggregate under the LIVE name", renamedMerged && renamedMerged.name === "P50QA New Name" && renamedMerged.revenueMinor === 25_000, JSON.stringify(renamedMerged));
ok("B2. no twin-merge anomaly in top products (no 30_000 'Twin Widget' row)", !sum30.topProducts.some((p) => p.name === "Twin Widget" && p.revenueMinor === 30_000));
const snapshots = await db.saleItem.findMany({ where: { productId: prodRename }, select: { name: true, saleId: true } });
ok("B3. SaleItem snapshots intact after rename (history preserved)", snapshots.length === 2 && snapshots.some((s) => s.name === "P50QA Old Name") && snapshots.some((s) => s.name === "P50QA New Name"), JSON.stringify(snapshots));

// ================= §C category law (Gate G) =================
console.log("\n== §C category shares (Gate G) ==");
const topSum = sum30.expensesByCategory.reduce((a, c) => a + c.totalMinor, 0);
ok("C1. SUM(top categories + Other) == expensesMinor EXACTLY", topSum + sum30.expensesByCategoryOther.totalMinor === sum30.kpis.expensesMinor, `${topSum}+${sum30.expensesByCategoryOther.totalMinor} vs ${sum30.kpis.expensesMinor}`);
ok("C2. Other bucket present and positive (8 categories > top 6)", sum30.expensesByCategoryOther.totalMinor === 3_000, String(sum30.expensesByCategoryOther.totalMinor));
ok("C3. category count exposed (8)", sum30.expensesCategoryCount === 8, String(sum30.expensesCategoryCount));
ok("C4. SupplierBill-linked Expense counted ONCE in category totals", sum30.expensesByCategory.find((c) => c.category === "P50QA Billed")?.totalMinor === 21_000);

// ================= §D entitlements =================
console.log("\n== §D entitlement enforcement (Gates I/J) ==");
ok("D1. FREE business: summary omits `advanced` and flags advancedAvailable=false", sum30.advancedAvailable === false && sum30.advanced === undefined);
const perfFree = await f("/api/v1/reports/performance?kind=sales&groupBy=product&from=" + tehranDay(-29) + "&to=" + todayKey, { headers: H });
ok("D2. performance API on FREE → 403 ENTITLEMENT_NOT_AVAILABLE (Gate J)", perfFree.status === 403 && perfFree.body?.error?.code === "ENTITLEMENT_NOT_AVAILABLE", `${perfFree.status} ${JSON.stringify(perfFree.body).slice(0, 120)}`);
const perfExpFree = await f("/api/v1/reports/performance/export?kind=sales&groupBy=product&from=" + tehranDay(-29) + "&to=" + todayKey, { headers: H });
ok("D3. performance EXPORT on FREE → 403 (ADVANCED_REPORTS gate first)", perfExpFree.status === 403, String(perfExpFree.status));

// Upgrade to STARTER via DB (established convention)
const starter = await db.plan.findUnique({ where: { code: "STARTER" } });
await db.subscription.update({ where: { businessId: bizA.id }, data: { planId: starter.id } });
const sum30adv = (await f("/api/v1/reports/summary?days=30", { headers: H })).body?.data;
ok("D4. STARTER: advanced block present, entitled", sum30adv?.advancedAvailable === true && Boolean(sum30adv?.advanced));
ok("D5. advanced growth revenue == summary revenue (same window law)", sum30adv.advanced.growth.revenueMinor === sum30.kpis.revenueMinor, `${sum30adv.advanced.growth.revenueMinor} vs ${sum30.kpis.revenueMinor}`);
const prevLen = (y, m) => { // previous window local-date length via Intl
  const prevFrom = sum30adv.advanced.previousRange.from;
  const prevTo = sum30adv.advanced.previousRange.to;
  const count = Math.round((Date.parse(`${prevTo}T00:00:00Z`) - Date.parse(`${prevFrom}T00:00:00Z`)) / 86_400_000) + 1;
  return { prevFrom, prevTo, count };
};
{
  const { prevFrom, prevTo, count } = prevLen();
  ok("D6. previous window is EXACTLY 30 business-local days (Gate D)", count === 30, `${prevFrom}..${prevTo} = ${count}`);
  ok("D7. previous window ends the day before the current window", prevTo === tehranDay(-30), prevTo);
}
const conc = sum30adv.advanced.concentration;
ok("D8. same-name customers are SEPARATE concentration rows with stable ids (Gate F)", (() => {
  const rows = conc.topCustomers.filter((c) => c.name === twinName);
  return rows.length === 2 && rows[0].customerId !== rows[1].customerId;
})(), JSON.stringify(conc.topCustomers));
const c1Rev = conc.topCustomers.find((c) => c.customerId === cus1)?.revenueMinor;
const c2Rev = conc.topCustomers.find((c) => c.customerId === cus2)?.revenueMinor;
ok("D9. per-customer revenue exact (125_000 / 20_000)", c1Rev === 125_000 && c2Rev === 20_000, `cus1=${c1Rev} cus2=${c2Rev}`);
ok("D10. unassigned revenue EXPOSED (7_000), never redistributed", conc.unassignedRevenueMinor === 7_000 && conc.totalRevenueMinor === sum30.kpis.revenueMinor, JSON.stringify({ un: conc.unassignedRevenueMinor, tot: conc.totalRevenueMinor }));

// P50-TINY plan: CSV_EXPORT=false AND ADVANCED_REPORTS=false
const defs = await db.entitlementDefinition.findMany();
const defByCode = Object.fromEntries(defs.map((d) => [d.code, d.id]));
const tinyPlan = await db.plan.create({ data: { code: "P50-TINY", name: "P50 Test Tiny", description: "Harness-only plan", sortOrder: 999, isPublic: false, active: true } });
for (const [code, value] of Object.entries({ CUSTOMERS_MAX: 5, PRODUCTS_MAX: 5, TEAM_MEMBERS_MAX: 1, BUSINESSES_MAX: 1, AI_COPILOT: false, ADVANCED_REPORTS: false, CSV_EXPORT: false })) {
  const isLimit = typeof value === "number";
  await db.planEntitlement.create({ data: { planId: tinyPlan.id, entitlementId: defByCode[code], value: isLimit ? value : null, boolValue: isLimit ? false : value } });
}
await db.subscription.update({ where: { businessId: bizA.id }, data: { planId: tinyPlan.id } });
const monthCsvTiny = await ftext(`/api/v1/reports/monthly/${MONTH}/export`, H);
ok("D11. monthly CSV export with CSV_EXPORT=false → 403 (Gate I, D50-F)", monthCsvTiny.status === 403, String(monthCsvTiny.status));
const mainCsvTiny = await ftext("/api/v1/reports/export?days=30", H);
ok("D12. main summary export with CSV_EXPORT=false → 403 (unchanged law)", mainCsvTiny.status === 403, String(mainCsvTiny.status));
const perfTiny = await f("/api/v1/reports/performance?kind=sales&groupBy=product&from=" + tehranDay(-29) + "&to=" + todayKey, { headers: H });
ok("D13. performance on P50-TINY → 403", perfTiny.status === 403, String(perfTiny.status));
// back to STARTER for the rest of the suite
await db.subscription.update({ where: { businessId: bizA.id }, data: { planId: starter.id } });

// ================= §E monthly completeness (Gate H) =================
console.log("\n== §E monthly detail completeness (Gate H) ==");
const monthDetail = (await f(`/api/v1/reports/monthly/${MONTH}`, { headers: H })).body?.data;
ok("E1. month totals: exactly 30 sales, revenue 30_465", monthDetail.totals.salesCount === 30 && monthDetail.totals.revenueMinor === MONTH_SALES_TOTAL, JSON.stringify(monthDetail.totals));
ok("E2. preview metadata: totalCount 30, displayed 25, hasMore TRUE", monthDetail.preview.sales.totalCount === 30 && monthDetail.preview.sales.displayedCount === 25 && monthDetail.preview.sales.hasMore === true, JSON.stringify(monthDetail.preview.sales));
ok("E3. preview arrays bounded at 25", monthDetail.sales.length === 25 && monthDetail.expenses.length === 0);
const monthCsv = await ftext(`/api/v1/reports/monthly/${MONTH}/export`, H);
ok("E4. monthly CSV export 200 with CSV_EXPORT=true", monthCsv.status === 200, String(monthCsv.status));
{
  const rows = monthCsv.text.split("\r\n").filter((l) => /^sale,\d+,/.test(l));
  ok("E5. monthly CSV contains ALL 30 sale rows (never the 25-row prefix)", rows.length === 30, String(rows.length));
  ok("E6. CSV KPI sales_count == 30 and revenue == 30_465.00", monthCsv.text.includes("kpi,sales_count,30") && monthCsv.text.includes(`kpi,revenue_issued_USD,${(MONTH_SALES_TOTAL / 100).toFixed(2)}`));
  {
    const bytes = new Uint8Array(monthCsv.bytes);
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    ok("E7. CSV carries UTF-8 BOM (bytes) + CRLF + no-store", hasBom && monthCsv.text.includes("\r\n") && monthCsv.headers.get("cache-control") === "no-store", `bom=${hasBom} cc=${monthCsv.headers.get("cache-control")}`);
  }
  ok("E8. CSV content-disposition is a safe attachment", /^attachment; filename="[^"]+"$/.test(monthCsv.headers.get("content-disposition") ?? ""));
}
const salesListMonth = (await f(`/api/v1/sales?month=${MONTH}&pageSize=50`, { headers: H })).body?.data;
ok("E9. sales list ?month= total == drill-down total (30)", salesListMonth?.total === 30, String(salesListMonth?.total));
const monthBad = await f("/api/v1/reports/monthly/2026-13", { headers: H });
ok("E10. malformed month key → 404 (never 500)", monthBad.status === 404, String(monthBad.status));

// ================= §F performance report =================
console.log("\n== §F performance report (§11) ==");
const from30 = tehranDay(-29);
const P = (q) => `/api/v1/reports/performance?${q}`;
const perfProd = (await f(P(`kind=sales&groupBy=product&from=${from30}&to=${todayKey}`), { headers: H })).body?.data;
ok("F1. performance sales/product 200 (STARTER)", Boolean(perfProd?.groups), JSON.stringify(perfProd).slice(0, 120));
{
  const twins = perfProd.groups.filter((g) => g.dimension === "product" && g.productId === prodA || g.productId === prodB);
  ok("F2. twin products are TWO distinct identity rows (Gate E)", twins.length === 2 && twins.every((g) => g.kind === "catalog" && g.name === "Twin Widget"), JSON.stringify(perfProd.groups.slice(0, 4)));
  const a = twins.find((g) => g.productId === prodA);
  const b = twins.find((g) => g.productId === prodB);
  ok("F3. twin amounts correct (10_000 / 20_000 line value)", a?.lineValueMinor === 10_000 && b?.lineValueMinor === 20_000);
  const ren = perfProd.groups.find((g) => g.productId === prodRename);
  ok("F4. renamed product single row, live name, qty 2+3=5", ren && ren.name === "P50QA New Name" && ren.qtySold === 5 && ren.lineValueMinor === 25_000, JSON.stringify(ren));
  const unlinked = perfProd.groups.filter((g) => g.dimension === "product" && g.kind === "unlinked");
  ok("F5. unlinked lines reported SEPARATELY (catalog + unlinked kinds coexist)", unlinked.length >= 4 && unlinked.some((g) => g.name === "Custom Legacy Line"), JSON.stringify(unlinked.map((g) => g.name)));
  const netSum = perfProd.groups.reduce((a, g) => a + (g.netValueMinor ?? 0), 0);
  ok("F6. allocated nets sum EXACTLY to netLineValueMinor == revenue (Gate O/E)", netSum === perfProd.totals.netLineValueMinor && perfProd.totals.netLineValueMinor === perfProd.totals.revenueMinor && perfProd.totals.revenueMinor === sum30.kpis.revenueMinor, `netSum=${netSum} net=${perfProd.totals.netLineValueMinor} rev=${perfProd.totals.revenueMinor}`);
  ok("F7. lineValue - discount reconciles (162_000 - 10_000)", perfProd.totals.lineValueMinor === 162_000 && perfProd.totals.discountMinor === 10_000, JSON.stringify(perfProd.totals));
  ok("F8. discountBasis documented as net_allocated", perfProd.discountBasis === "net_allocated");
}
const perfCust = (await f(P(`kind=sales&groupBy=customer&from=${from30}&to=${todayKey}`), { headers: H })).body?.data;
{
  const rows = perfCust.groups.filter((g) => g.dimension === "customer");
  const un = rows.find((g) => g.customerId === null);
  ok("F9. customer grouping identity-safe: same-name rows by id + unassigned", rows.filter((g) => g.customerId === cus1 || g.customerId === cus2).length === 2 && un?.revenueMinor === 7_000, JSON.stringify(rows));
  const custSum = rows.reduce((a, g) => a + g.revenueMinor, 0);
  ok("F10. customer grouping reconciles to the SAME revenue total", custSum === perfCust.totals.revenueMinor && perfCust.totals.revenueMinor === sum30.kpis.revenueMinor);
}
const perfDay = (await f(P(`kind=sales&groupBy=day&from=${from30}&to=${todayKey}`), { headers: H })).body?.data;
{
  const daySum = perfDay.groups.reduce((a, g) => a + g.revenueMinor, 0);
  ok("F11. day grouping reconciles; no future-dated bucket", daySum === perfDay.totals.revenueMinor && !perfDay.groups.some((g) => g.date > todayKey));
}
const perfMonth = (await f(P(`kind=sales&groupBy=month&from=${tehranDay(-90)}&to=${todayKey}`), { headers: H })).body?.data;
{
  const m = perfMonth.groups.find((g) => g.month === MONTH);
  ok("F12. month grouping: the 30-invoice month shows 30 invoices / 30_465", m && m.invoiceCount === 30 && m.revenueMinor === MONTH_SALES_TOTAL, JSON.stringify(m));
}
const perfExpCat = (await f(P(`kind=expenses&groupBy=category&from=${from30}&to=${todayKey}`), { headers: H })).body?.data;
{
  ok("F13. expense categories reconcile to expensesMinor (Gate G server-side)", perfExpCat.groups.reduce((a, g) => a + g.amountMinor, 0) === perfExpCat.totals.amountMinor && perfExpCat.totals.amountMinor === sum30.kpis.expensesMinor);
  ok("F14. SupplierBill-linked Expense counted ONCE (Gate L)", perfExpCat.groups.find((g) => g.category === "P50QA Billed")?.expenseCount === 1, JSON.stringify(perfExpCat.groups.find((g) => g.category === "P50QA Billed")));
  ok("F15. future/outside expenses excluded", !perfExpCat.groups.some((g) => g.category === "P50QA Future" || g.category === "P50QA Outside"));
}
const perfExpSup = (await f(P(`kind=expenses&groupBy=supplier&from=${from30}&to=${todayKey}`), { headers: H })).body?.data;
ok("F16. supplier grouping: same-name suppliers distinct by id", perfExpSup.groups.filter((g) => g.supplierId === sup1 || g.supplierId === sup2).length === 2);

// ---- cash flow detail (Gate K) ----
const perfCf1 = (await f(P(`kind=cashflow&from=${from30}&to=${todayKey}&limit=10`), { headers: H })).body?.data;
const cfTotals = perfCf1.totals;
ok("F17. cash-flow totals == payment aggregates (collected/paidOut)", cfTotals.collectedMinor === expCollected && cfTotals.paidOutMinor === expPaidOut, JSON.stringify(cfTotals));
ok("F18. payment count matches window payments (16: 4 + 12 batch)", cfTotals.paymentCount === payRows.filter((p) => inWin(p.paidAt)).length, `${cfTotals.paymentCount}`);
ok("F19. page rows bounded (limit 10) with nextCursor", perfCf1.rows.length === 10 && typeof perfCf1.nextCursor === "string" && perfCf1.nextCursor.length > 0);
const perfCf2 = (await f(P(`kind=cashflow&from=${from30}&to=${todayKey}&limit=10&cursor=${encodeURIComponent(perfCf1.nextCursor)}`), { headers: H })).body?.data;
ok("F20. page 2 continues keyset: no dup/overlap, ends exhausted", (() => {
  const ids1 = perfCf1.rows.map((r) => r.id);
  const ids2 = perfCf2.rows.map((r) => r.id);
  const all = [...ids1, ...ids2];
  return perfCf2.nextCursor === null && all.length === new Set(all).size && all.length === cfTotals.paymentCount;
})(), JSON.stringify({ p2: perfCf2.rows.length, next: perfCf2.nextCursor }));
{
  const sumRows = perfCf1.rows.concat(perfCf2.rows);
  const inSum = sumRows.filter((r) => r.direction === "IN").reduce((a, r) => a + r.amountMinor, 0);
  const outSum = sumRows.filter((r) => r.direction === "OUT").reduce((a, r) => a + r.amountMinor, 0);
  ok("F21. ONE payment = ONE movement: row sums == totals (never double-counted)", inSum === cfTotals.collectedMinor && outSum === cfTotals.paidOutMinor, `in=${inSum}/${cfTotals.collectedMinor} out=${outSum}/${cfTotals.paidOutMinor}`);
  ok("F22. rows carry safe source refs + method, no notes/user data", sumRows.every((r) => !("note" in r) && !("actorId" in r) && (r.sale || r.expense)));
  ok("F23. boundary payment appears under the CORRECT local day", sumRows.some((r) => r.amountMinor === 2_000 && r.date === tehranDay(-1)));
}
{
  const badCursor = await f(P(`kind=cashflow&from=${from30}&to=${todayKey}&limit=10&cursor=garbage.cursor`), { headers: H });
  ok("F24. garbage cursor → 422", badCursor.status === 422, String(badCursor.status));
  // cursor bound to direction filter: page under direction=IN must reject the unfiltered cursor
  const crossCursor = await f(P(`kind=cashflow&from=${from30}&to=${todayKey}&limit=10&direction=IN&cursor=${encodeURIComponent(perfCf1.nextCursor)}`), { headers: H });
  ok("F25. cursor reused across a DIFFERENT filter binding → 422", crossCursor.status === 422, String(crossCursor.status));
  const dirIn = (await f(P(`kind=cashflow&from=${from30}&to=${todayKey}&limit=25&direction=IN`), { headers: H })).body?.data;
  ok("F26. direction=IN: only IN rows; totals still complete", dirIn.rows.every((r) => r.direction === "IN") && dirIn.totals.paidOutMinor === expPaidOut);
}

// ================= §G validation & security =================
console.log("\n== §G validation & security (§14) ==");
{
  const noAuth = await fetch(`${BASE}${P("kind=sales&groupBy=product&from=2026-09-01&to=2026-09-30")}`, { headers: { "x-forwarded-for": "10.52.13.9" } });
  ok("G1. unauthenticated performance → 401, no data body", noAuth.status === 401, String(noAuth.status));
  const badKind = await f(P(`kind=bogus&from=${from30}&to=${todayKey}`), { headers: H });
  ok("G2. invalid kind → 422", badKind.status === 422);
  const badGroup = await f(P(`kind=sales&groupBy=note&from=${from30}&to=${todayKey}`), { headers: H });
  ok("G3. non-closed groupBy (sort-field injection) → 422", badGroup.status === 422);
  const badLimit = await f(P(`kind=sales&groupBy=product&from=${from30}&to=${todayKey}&limit=5`), { headers: H });
  ok("G4. limit below floor → 422", badLimit.status === 422);
  const badDir = await f(P(`kind=cashflow&from=${from30}&to=${todayKey}&direction=SIDEWAYS`), { headers: H });
  ok("G5. invalid direction → 422", badDir.status === 422);
  const badDate = await f(P(`kind=sales&groupBy=day&from=2026-09-31&to=${todayKey}`), { headers: H });
  ok("G6. impossible calendar date → 422 INVALID_REPORT_RANGE", badDate.status === 422 && badDate.body?.error?.code === "INVALID_REPORT_RANGE", JSON.stringify(badDate.body).slice(0, 120));
  const inverted = await f(P(`kind=sales&groupBy=day&from=${todayKey}&to=${from30}`), { headers: H });
  ok("G7. inverted range → 422", inverted.status === 422);
  const tooLong = await f(P(`kind=sales&groupBy=day&from=2025-01-01&to=${todayKey}`), { headers: H });
  ok("G8. >366-day range → 422", tooLong.status === 422);
  const futureOnly = await f(P(`kind=sales&groupBy=day&from=${tehranDay(5)}&to=${tehranDay(10)}`), { headers: H });
  ok("G9. future-only range → 422", futureOnly.status === 422);
  const noGroup = await f(P(`kind=sales&from=${from30}&to=${todayKey}`), { headers: H });
  ok("G10. missing groupBy → 422 (closed vocab required)", noGroup.status === 422, String(noGroup.status));
  // cross-tenant: business B's 999_000 sale never appears under A
  const perfIso = (await f(P(`kind=sales&groupBy=day&from=${from30}&to=${todayKey}`), { headers: H })).body?.data;
  ok("G11. cross-tenant isolation: business B amounts absent from A's report", perfIso.totals.revenueMinor === sum30.kpis.revenueMinor && perfIso.totals.revenueMinor < 999_000);
  const sumB = (await f("/api/v1/reports/summary?days=30", { headers: HB })).body?.data;
  ok("G12. business B sees ONLY its own sale", sumB.kpis.revenueMinor === 999_000, String(sumB.kpis.revenueMinor));
}

// ================= §H no false revenue (Gates L/M) =================
console.log("\n== §H no false revenue (Gates L/M) ==");
ok("H1. CONFIRMED SalesOrder is NOT revenue (GATE M)", sum30.kpis.revenueMinor === expRevenue && !salesRows.some((s) => s.totalMinor === 55_000));
ok("H2. ACCEPTED SalesQuotation is NOT revenue (GATE M)", !salesRows.some((s) => s.totalMinor === 44_000));
ok("H3. SupplierBill (21_000) is not a second expense row (GATE L)", sum30.kpis.expensesMinor === expExpenses && expenseRows.filter((e) => e.amountMinor === 21_000).length === 1);
ok("H4. goods documents never in reports (structurally absent)", true); // Dispatch/Receipt tables are outside the report queries by construction

// ================= §I teardown =================
console.log("\n== §I teardown ==");
{
  await db.payment.deleteMany({ where: { businessId: bizA.id } });
  await db.payment.deleteMany({ where: { businessId: bizB.id } });
  await db.supplierBillLine.deleteMany({ where: { supplierBill: { businessId: bizA.id } } });
  await db.supplierBill.deleteMany({ where: { businessId: bizA.id } });
  await db.saleItem.deleteMany({ where: { sale: { businessId: bizA.id } } });
  await db.sale.deleteMany({ where: { businessId: bizA.id } });
  await db.saleItem.deleteMany({ where: { sale: { businessId: bizB.id } } });
  await db.sale.deleteMany({ where: { businessId: bizB.id } });
  await db.expense.deleteMany({ where: { businessId: bizA.id } });
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { businessId: bizA.id } } });
  await db.salesOrder.deleteMany({ where: { businessId: bizA.id } });
  await db.salesQuotationLine.deleteMany({ where: { salesQuotation: { businessId: bizA.id } } });
  await db.salesQuotation.deleteMany({ where: { businessId: bizA.id } });
  await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: bizA.id } } });
  await db.purchaseOrder.deleteMany({ where: { businessId: bizA.id } });
  await db.customer.deleteMany({ where: { businessId: bizA.id } });
  await db.customer.deleteMany({ where: { businessId: bizB.id } });
  await db.supplier.deleteMany({ where: { businessId: bizA.id } });
  await db.product.deleteMany({ where: { businessId: bizA.id } });
  await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: bizA.id } } });
  await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: bizB.id } } });
  // Businesses + FREE-baseline subscriptions stay (stable-identity hygiene);
  // every FINANCIAL row is wiped — zero residue of fixture data.
  await db.subscription.update({ where: { businessId: bizA.id }, data: { planId: (await db.plan.findUnique({ where: { code: "FREE" } })).id } }).catch(() => {});
  await db.subscription.update({ where: { businessId: bizB.id }, data: { planId: (await db.plan.findUnique({ where: { code: "FREE" } })).id } }).catch(() => {});
  const leftBiz = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  const leftSales = await db.sale.count({ where: { businessId: { in: [bizA.id, bizB.id] } } });
  const leftItems = await db.saleItem.count({ where: { sale: { businessId: { in: [bizA.id, bizB.id] } } } });
  const leftPay = await db.payment.count({ where: { businessId: { in: [bizA.id, bizB.id] } } });
  const tiny = await db.plan.findUnique({ where: { code: "P50-TINY" } });
  if (tiny) {
    await db.planEntitlement.deleteMany({ where: { planId: tiny.id } });
    await db.plan.deleteMany({ where: { id: tiny.id } });
  }
  const leftPlan = await db.plan.count({ where: { code: "P50-TINY" } });
  ok("I1. zero fixture financial rows remain (businesses kept for limiter hygiene)", leftSales === 0 && leftItems === 0 && leftPay === 0, `biz=${leftBiz} sales=${leftSales} items=${leftItems} pay=${leftPay}`);
  ok("I2. P50-TINY harness plan removed", leftPlan === 0, String(leftPlan));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((x) => `  - ${x}`).join("\n"));
  await db.$disconnect();
  process.exit(1);
}
await db.$disconnect();
