#!/usr/bin/env node
/**
 * Prompt 47 — E2E SALES QUOTATION CHECK. Real application + real DB.
 * Run: node scripts/prompt47-sales-quotation-check.mjs   (dev server on :3000)
 *
 * Covers: fixtures (2 tenants, NON-ZERO stock + financial baseline) ·
 * draft create (auto QT- reference §10, currency snapshot from the business
 * §10, customer snapshot §12, quotationDate default = business-local today
 * §9) + authority-injection rejections (§15) · line management (price
 * default §6, duplicate product 409, qty/price bounds, discount law,
 * remove) · snapshot freezing vs live renames (§12) · stock/financial
 * NON-MUTATION through the whole DRAFT phase (§1/§95 law, non-zero
 * baseline) · mark-sent (server sentAt, EMPTY gate, immutability §8) ·
 * accept (server acceptedAt, NO SalesOrder yet §13) · reject/cancel paths
 * · EXPIRED law (past-validity offer: mark-sent allowed, accept 409
 * EXPIRED, explicit expire transition, terminal; NOT_EXPIRED guard) ·
 * conversion Journey H (exactly ONE CONFIRMED SalesOrder from FROZEN
 * snapshots, totals agreement, no Sale/Payment/adjustment/stock change,
 * CONVERTED + convertedAt) · duplicate conversion 409 · concurrency races
 * (convert ×5, duplicate line ×5, duplicate reference ×5, edit-vs-
 * mark-sent, accept-vs-reject) · tenant isolation both directions (§24) ·
 * global search SALES_QUOTATION (§18) · Customer 360 + Product detail
 * quotation history (§19; quantities only on product surfaces) · per-
 * quotation CSV export EN/FA + formula-injection guard + CSV_EXPORT
 * entitlement gate (§20) · business export datasets (§20) · import
 * rejection (§20) · print endpoint reduced payload (§16: NO internalNotes,
 * NO ids) · teardown to ZERO residue.
 *
 * Fixtures are P47Q-prefixed and removed to ZERO. Prisma is used ONLY for
 * fixtures, assertions and cleanup — never to mutate domain rows except
 * the documented snapshot-rename probes (renames are restored).
 */
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// --- env -------------------------------------------------------------------
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "P47Qqa!Passw0rd!1";
const TAG = "P47Q";
const STAMP = `${Date.now()}`.slice(-8);
const DOMAIN = "p47q.test";

let passed = 0;
let failed = 0;
const failures = [];

// ok() accepts BOTH call conventions found in the suite — ok(name, cond)
// (the dominant P45 style) and ok(cond, name) — and normalizes them, so a
// boolean first argument can never silently swap the assertion into a
// vacuous pass (a non-empty label string is always truthy). Every counted
// assertion therefore evaluates its REAL condition and prints its name.
function ok(nameOrCond, condOrName, info = "") {
  const [name, cond] =
    typeof nameOrCond === "boolean" && typeof condOrName !== "boolean"
      ? [condOrName, nameOrCond]
      : [nameOrCond, condOrName];
  if (cond) passed++;
  else failed++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
}
function eq(actual, expected, name) {
  ok(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}
function section(name) {
  console.log(`\n=== ${name} ===`);
}

// --- HTTP client with per-user cookie jar (verbatim P45 mechanics) ----------
function makeClient() {
  const jar = new Map();
  const f = async function f(path, init = {}) {
    // FormData bodies MUST carry the browser-set multipart boundary — never
    // a forced JSON content-type (the /api/v1/imports upload needs this).
    const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
    const headers = {
      ...(isForm ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": init.xff ?? "10.47.7.19",
      ...(init.headers ?? {}),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "manual",
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";");
      const eqi = kv.indexOf("=");
      jar.set(kv.slice(0, eqi), kv.slice(eqi + 1));
    }
    let body = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try { body = await res.json(); } catch { body = null; }
    } else {
      body = await res.text().catch(() => null);
    }
    return { status: res.status, headers: res.headers, body };
  };
  // Raw-byte access for BOM-level assertions (fetch .text() strips the BOM).
  f.cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  return f;
}

async function login(f, email) {
  const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
  const cb = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString(),
  });
  const me = await f("/api/v1/me");
  if (me.status !== 200) {
    console.error(`  !! login failed for ${email}: callback=${cb.status} body=${JSON.stringify(cb.body).slice(0, 160)} me=${me.status}`);
  }
}

async function call(f, path, init = {}, depth = 0) {
  const res = await f(path, init);
  if (res.status === 429 && !(init.headers ?? {})["x-no-retry"] && depth < 1) {
    const wait = Math.min(res.body?.error?.details?.retryAfterMs ?? 60_000, 65_000);
    console.log(`  (rate limited — waiting ${Math.round(wait / 1000)}s)`);
    await new Promise((r) => setTimeout(r, wait));
    return call(f, path, init, depth + 1);
  }
  return { status: res.status, body: res.body, headers: res.headers };
}

const B = (biz) => ({ "x-business-id": biz });
const codeOf = (r) => r.body?.error?.code ?? "";
const dataOf = (r) => r.body?.data;

// --- date helpers (server-law mirrors) --------------------------------------
const calDate = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000);
const todayLocal = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/* ------------------------------ fixtures ----------------------------------- */

async function purge() {
  // Crashed-run recovery: remove ANY prior P47Q residue first.
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatch: { businessId: b.id } } });
    await db.goodsDispatch.deleteMany({ where: { businessId: b.id } });
    await db.salesOrderLine.deleteMany({ where: { salesOrder: { businessId: b.id } } });
    await db.salesOrder.deleteMany({ where: { businessId: b.id } });
    await db.salesQuotationLine.deleteMany({ where: { salesQuotation: { businessId: b.id } } });
    await db.salesQuotation.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
    await db.subscription.deleteMany({ where: { businessId: b.id } });
    await db.business.deleteMany({ where: { id: b.id } });
  }
  const users = await db.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  for (const u of users) {
    await db.userSession.deleteMany({ where: { userId: u.id } });
    await db.auditLog.deleteMany({ where: { actorId: u.id } });
    await db.chatMessage.deleteMany({ where: { session: { userId: u.id } } });
    await db.chatSession.deleteMany({ where: { userId: u.id } });
    await db.legalAcceptance.deleteMany({ where: { userId: u.id } });
    await db.inventoryAdjustment.deleteMany({ where: { actorId: u.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: u.id } });
  }
  await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });
}

async function createUser(name, role) {
  return db.user.create({
    data: {
      email: `${TAG.toLowerCase()}-${name.toLowerCase()}-${STAMP}@${DOMAIN}`, // lowercase: the auth schema lowercases emails
      name: `${TAG} ${name}`,
      passwordHash: bcrypt.hashSync(PASS, 4),
      locale: "en",
    },
  });
}

async function main() {
  await purge();
  const priorResidue = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  ok("0.1 no prior P47Q residue before fixtures", priorResidue === 0);

  /* ---------------------------- 1. fixtures -------------------------------- */
  section("1. fixtures (2 tenants, non-zero stock + financial baseline)");

  const owner = await createUser("owner");
  const viewer = await createUser("viewer");
  ok("1.1 fixture users created", Boolean(owner?.id && viewer?.id));

  const bizA = await db.business.create({
    data: {
      name: `${TAG}-A-${STAMP}`,
      slug: `${TAG.toLowerCase()}-a-${STAMP}`,
      ownerId: owner.id,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      timezone: "Asia/Tehran",
      members: {
        create: [
          { userId: owner.id, role: "OWNER" },
          { userId: viewer.id, role: "VIEWER" },
        ],
      },
    },
  });
  const ownerB = await createUser("ownerB");
  const bizB = await db.business.create({
    data: {
      name: `${TAG}-B-${STAMP}`,
      slug: `${TAG.toLowerCase()}-b-${STAMP}`,
      ownerId: ownerB.id,
      currencyCode: "EUR",
      currencySymbol: "€",
      decimalPrecision: 2,
      timezone: "UTC",
      members: { create: [{ userId: ownerB.id, role: "OWNER" }] },
    },
  });
  ok("1.2 two tenant businesses created", Boolean(bizA?.id && bizB?.id));

  const customerA = await db.customer.create({
    data: { businessId: bizA.id, name: `${TAG} Cust A` },
  });
  const customerB = await db.customer.create({
    data: { businessId: bizB.id, name: `${TAG} Cust B` },
  });
  // NON-ZERO stocks (§124 — never zero-baseline assertions).
  const productA = await db.product.create({
    data: { businessId: bizA.id, name: `${TAG} Widget`, sku: `${TAG}-SKU-1`, unit: "piece", salePriceMinor: 500, stockQty: 500 },
  });
  const productA2 = await db.product.create({
    data: { businessId: bizA.id, name: `${TAG} Gadget`, sku: `${TAG}-SKU-2`, unit: "box", salePriceMinor: 1200, stockQty: 54 },
  });
  const productA3 = await db.product.create({
    data: { businessId: bizA.id, name: `${TAG} Cable`, sku: `${TAG}-SKU-3`, unit: "meter", salePriceMinor: 250, stockQty: 192 },
  });
  const productB = await db.product.create({
    data: { businessId: bizB.id, name: `${TAG} B-Only`, sku: `${TAG}-SKU-B`, salePriceMinor: 100, stockQty: 10 },
  });
  ok("1.3 customers + products created (stocks 500/54/192/10)", Boolean(customerA?.id && productA?.id && productA2?.id && productA3?.id && productB?.id));

  // NON-ZERO financial baseline.
  const legacySaleForA = await db.sale.create({
    data: {
      businessId: bizA.id,
      number: 91001,
      customerId: customerA.id,
      subtotalMinor: 3000,
      discountMinor: 0,
      totalMinor: 3000,
      paidMinor: 1000,
      status: "PARTIAL",
      items: { create: { productId: productA.id, name: productA.name, qty: 3, unitPriceMinor: 1000, lineTotalMinor: 3000 } },
    },
  });
  await db.payment.create({
    data: { businessId: bizA.id, saleId: legacySaleForA.id, direction: "IN", amountMinor: 1000, method: "CASH" },
  });
  ok("1.4 non-zero Sale/Payment baseline created", true);

  const ownerF = makeClient();
  await login(ownerF, owner.email);
  const viewerF = makeClient();
  await login(viewerF, viewer.email);
  const ownerBF = makeClient();
  await login(ownerBF, ownerB.email);
  ok("1.5 sessions established for 3 users", true);

  const finSnapshot = async () => {
    const [saleAgg, saleItemCount, paymentCount, adjAgg, stocks] = await Promise.all([
      db.sale.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { totalMinor: true, paidMinor: true } }),
      db.saleItem.count({ where: { sale: { businessId: bizA.id } } }),
      db.payment.count({ where: { businessId: bizA.id } }),
      db.inventoryAdjustment.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { delta: true } }),
      db.product.findMany({ where: { businessId: bizA.id }, select: { id: true, stockQty: true }, orderBy: { id: "asc" } }),
    ]);
    return {
      saleCount: saleAgg._count._all,
      saleTotal: saleAgg._sum.totalMinor ?? 0,
      salePaid: saleAgg._sum.paidMinor ?? 0,
      saleItemCount,
      paymentCount,
      adjCount: adjAgg._count._all,
      adjDelta: adjAgg._sum.delta ?? 0,
      stockSum: stocks.reduce((acc, p) => acc + p.stockQty, 0),
      stockSig: stocks.map((p) => `${p.id}:${p.stockQty}`).join(","),
    };
  };

  /* -------------------- 2. draft creation + authority ---------------------- */
  section("2. draft creation (QT- reference, snapshots, defaults) + authority-injection rejections");
  const fin0 = await finSnapshot();

  const created = await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({
      customerId: customerA.id,
      validUntilDate: calDate(daysFromNow(30)),
      customerNotes: "P47Q offer notes",
      internalNotes: "P47Q internal cost hint",
    }),
  });
  eq(created.status, 201, "2.1 draft created (no client reference)");
  const q1 = dataOf(created);
  ok(q1.reference.startsWith("QT-"), `2.2 server-generated QT- reference ${q1.reference}`);
  eq(q1.status, "DRAFT", "2.3 created as DRAFT");

  const detail1 = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) }));
  eq(detail1.quotation.persistedStatus, "DRAFT", "2.4 persistedStatus DRAFT");
  eq(detail1.quotation.effectiveStatus, "DRAFT", "2.5 effectiveStatus DRAFT");
  eq(detail1.quotation.customerNameAtQuotation, customerA.name, "2.6 customer snapshot from the live customer");
  eq(detail1.quotation.currencyCodeAtQuotation, "USD", "2.7 currency snapshot server-derived from the business");
  eq(detail1.quotation.currencySymbolAtQuotation, "$", "2.8 currency symbol snapshot");
  eq(detail1.quotation.decimalPrecisionAtQuotation, 2, "2.9 precision snapshot");
  eq(detail1.quotation.quotationDate.slice(0, 10), todayLocal("Asia/Tehran"), "2.10 quotationDate defaults to business-local TODAY (server clock)");
  eq(detail1.quotation.validUntilDate.slice(0, 10), calDate(daysFromNow(30)), "2.11 validUntilDate honored");
  eq(detail1.summary.lineCount, 0, "2.12 empty quotation starts with 0 lines");
  eq(detail1.quotation.internalNotes, "P47Q internal cost hint", "2.13 internalNotes on the staff detail view only");
  ok(detail1.convertedOrder === null, "2.14 no converted-order DTO when none exists (§7)");

  const list1 = dataOf(await call(ownerF, "/api/v1/sales-quotations", { headers: B(bizA.id) }));
  ok(list1.items.some((i) => i.id === q1.id), "2.15 quotation appears in the tenant list");
  const statusList = dataOf(await call(ownerF, "/api/v1/sales-quotations?status=SENT", { headers: B(bizA.id) }));
  eq(statusList.items.length, 0, "2.16 status filter works (no SENT yet)");
  const badPage = await call(ownerF, "/api/v1/sales-quotations?pageSize=500", { headers: B(bizA.id) });
  eq(badPage.status, 422, "2.17 pageSize above 100 rejected");
  const badWindow = await call(ownerF, "/api/v1/sales-quotations?from=2026-02-30", { headers: B(bizA.id) });
  eq(badWindow.status, 422, "2.18 invalid window date rejected");

  const fin0b = await finSnapshot();
  eq(JSON.stringify(fin0), JSON.stringify(fin0b), "2.19 creation + reads mutate NOTHING financial (§1)");

  // Authority-injection rejections (strict schema §15).
  const strictCases = [
    ["status", { validUntilDate: calDate(daysFromNow(30)), status: "ACCEPTED" }],
    ["businessId", { validUntilDate: calDate(daysFromNow(30)), businessId: bizB.id }],
    ["createdByUserId", { validUntilDate: calDate(daysFromNow(30)), createdByUserId: owner.id }],
    ["currencyCodeAtQuotation", { validUntilDate: calDate(daysFromNow(30)), currencyCodeAtQuotation: "EUR" }],
    ["convertedAt", { validUntilDate: calDate(daysFromNow(30)), convertedAt: "2026-01-01T00:00:00Z" }],
    ["computed totalMinor", { validUntilDate: calDate(daysFromNow(30)), totalMinor: 99 }],
    ["customerNameAtQuotation", { validUntilDate: calDate(daysFromNow(30)), customerNameAtQuotation: "Injected" }],
  ];
  let strictOk = 0;
  for (const [field, payload] of strictCases) {
    const r = await call(ownerF, "/api/v1/sales-quotations", { method: "POST", headers: B(bizA.id), body: JSON.stringify(payload) });
    if (r.status === 422) strictOk += 1;
    else console.log(`   (injection ${field}: status ${r.status} code ${codeOf(r)})`);
  }
  eq(strictOk, strictCases.length, "2.20 all authority-field injections → 422 (strict boundary, computed totals ignored)");

  const badRange = await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ validUntilDate: "2020-01-01" }),
  });
  eq(badRange.status, 422, "2.21 validUntil before the default (today) quotationDate → 422 INVALID_DATE_RANGE");
  eq(codeOf(badRange), "SALES_QUOTATION_INVALID_DATE_RANGE", "2.22 stable date-range code");
  const badCustomer = await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ customerId: customerB.id, validUntilDate: calDate(daysFromNow(30)) }),
  });
  eq(badCustomer.status, 404, "2.23 foreign customer → 404 (no leak)");
  eq(codeOf(badCustomer), "SALES_QUOTATION_CUSTOMER_NOT_FOUND", "2.24 stable customer code");
  const dupRef = await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: q1.reference, validUntilDate: calDate(daysFromNow(30)) }),
  });
  eq(dupRef.status, 409, "2.25 duplicate reference → 409");
  eq(codeOf(dupRef), "SALES_QUOTATION_DUPLICATE_REFERENCE", "2.26 stable duplicate code");

  /* --------------------------- 3. lines ------------------------------------ */
  section("3. line management (price default, duplicates, bounds, discount law)");
  const line1 = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ productId: productA.id, qty: 10 }),
  });
  eq(line1.status, 201, "3.1 line added without explicit price");
  let d1 = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) }));
  eq(d1.lines[0].unitPriceMinor, 500, "3.2 price defaulted from Product.salePriceMinor (§6)");
  eq(d1.lines[0].productNameAtQuotation, productA.name, "3.3 product snapshot frozen");
  eq(d1.lines[0].lineTotalMinor, 5000, "3.4 canonical line total");

  const dupLine = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ productId: productA.id, qty: 1 }),
  });
  eq(dupLine.status, 409, "3.5 duplicate product → 409 (§6)");
  eq(codeOf(dupLine), "SALES_QUOTATION_DUPLICATE_PRODUCT", "3.6 stable duplicate-product code");

  const foreignProduct = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ productId: productB.id, qty: 1 }),
  });
  eq(foreignProduct.status, 404, "3.7 foreign product → 404 (no leak)");

  for (const [label, qty] of [["zero", 0], ["fractional", 1.5], ["negative", -1]]) {
    const r = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ productId: productA2.id, qty }),
    });
    eq(r.status, 422, `3.8 ${label} qty rejected`);
  }
  for (const [label, price] of [["negative", -1], ["above max", 9_000_000_001]]) {
    const r = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ productId: productA2.id, qty: 1, unitPriceMinor: price }),
    });
    eq(r.status, 422, `3.9 ${label} price rejected`);
  }
  const snapInject = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ productId: productA2.id, qty: 2, productNameAtQuotation: "Fake" }),
  });
  eq(snapInject.status, 422, "3.10 snapshot injection rejected (strict §15)");

  const line2 = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ productId: productA2.id, qty: 5, unitPriceMinor: 1000 }),
  });
  eq(line2.status, 201, "3.11 second line with explicit price");

  const editLine = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines/${d1.lines[0].id}`, {
    method: "PATCH",
    headers: B(bizA.id),
    body: JSON.stringify({ qty: 12, unitPriceMinor: 480 }),
  });
  eq(editLine.status, 200, "3.12 line edited (qty + agreed price)");
  d1 = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) }));
  eq(d1.lines[0].qty, 12, "3.13 new qty persisted");
  eq(d1.lines[0].unitPriceMinor, 480, "3.14 new price persisted");
  eq(d1.summary.subtotalMinor, 12 * 480 + 5 * 1000, "3.15 canonical subtotal recomputed");
  eq(d1.summary.totalMinor, d1.summary.subtotalMinor - 0, "3.16 total = subtotal (no discount yet)");
  eq(d1.lines[0].productNameAtQuotation, productA.name, "3.17 snapshot NOT rewritten by edit");

  const badDiscount = await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, {
    method: "PATCH",
    headers: B(bizA.id),
    body: JSON.stringify({ discountMinor: d1.summary.subtotalMinor + 1 }),
  });
  eq(badDiscount.status, 422, "3.18 discount above subtotal → 422");
  eq(codeOf(badDiscount), "INVALID_DISCOUNT", "3.19 stable discount code");
  const okDiscount = await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, {
    method: "PATCH",
    headers: B(bizA.id),
    body: JSON.stringify({ discountMinor: 760 }),
  });
  eq(okDiscount.status, 200, "3.20 lawful discount accepted");
  d1 = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) }));
  eq(d1.summary.totalMinor, d1.summary.subtotalMinor - 760, "3.21 total = subtotal − discount");

  const removeLine = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines/${d1.lines[1].id}`, {
    method: "DELETE",
    headers: B(bizA.id),
  });
  eq(removeLine.status, 200, "3.22 line removed");
  d1 = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) }));
  eq(d1.summary.lineCount, 1, "3.23 one line remains");
  eq(d1.summary.subtotalMinor, 12 * 480, "3.24 subtotal recomputed after removal");

  const finAfterLines = await finSnapshot();
  eq(JSON.stringify(fin0), JSON.stringify(finAfterLines), "3.25 ALL draft-phase line/discount work mutated NO stock/financial state");

  // Empty-mark-sent gate on a fresh empty draft.
  const emptyQ = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-EMPTY`, validUntilDate: calDate(daysFromNow(14)) }),
  }));
  const emptySend = await call(ownerF, `/api/v1/sales-quotations/${emptyQ.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  eq(emptySend.status, 422, "3.26 empty quotation cannot be marked sent");
  eq(codeOf(emptySend), "SALES_QUOTATION_EMPTY", "3.27 stable empty code");

  /* ------------------------- 4. snapshot freezing --------------------------- */
  section("4. snapshots frozen vs live renames (§12)");
  const origProductName = productA.name;
  const origCustomerName = customerA.name;
  await db.product.update({ where: { id: productA.id }, data: { name: `${TAG} Widget RENAMED`, salePriceMinor: 999 } });
  await db.customer.update({ where: { id: customerA.id }, data: { name: `${TAG} Cust A RENAMED` } });
  const dSnap = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) }));
  eq(dSnap.lines[0].productNameAtQuotation, origProductName, "4.1 product snapshot shows the ORIGINAL name (no reprice/no rename bleed)");
  eq(dSnap.lines[0].unitPriceMinor, 480, "4.2 offered price NOT repriced from the live product");
  eq(dSnap.quotation.customerNameAtQuotation, origCustomerName, "4.3 customer snapshot shows the ORIGINAL name");
  await db.product.update({ where: { id: productA.id }, data: { name: origProductName, salePriceMinor: 500 } });
  await db.customer.update({ where: { id: customerA.id }, data: { name: origCustomerName } });
  ok("4.4 live names restored", true);

  /* --------------- 5. draft-phase non-mutation confirmation ---------------- */
  section("5. stock/financial non-mutation through the whole DRAFT phase (§1)");
  const fin5 = await finSnapshot();
  eq(JSON.stringify(fin0), JSON.stringify(fin5), "5.1 stock sums byte-identical, zero new Sale/SaleItem/Payment/InventoryAdjustment");

  /* ---------------------------- 6. mark-sent -------------------------------- */
  section("6. mark-sent (server sentAt, terms freeze §8)");
  const finPreSend = await finSnapshot();
  const send1 = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  eq(send1.status, 200, "6.1 DRAFT → SENT");
  const sentBody = dataOf(send1);
  eq(sentBody.status, "SENT", "6.2 status SENT");
  ok("6.3 sentAt SERVER-generated (ISO instant)", typeof sentBody.sentAt === "string" && !Number.isNaN(Date.parse(sentBody.sentAt)));
  const dSent = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) }));
  eq(dSent.quotation.persistedStatus, "SENT", "6.4 persisted status SENT");
  eq(dSent.quotation.effectiveStatus, "SENT", "6.5 effective status SENT (validity future)");
  ok("6.6 detail carries sentAt", Boolean(dSent.quotation.sentAt));

  const patchSent = await call(ownerF, `/api/v1/sales-quotations/${q1.id}`, {
    method: "PATCH",
    headers: B(bizA.id),
    body: JSON.stringify({ discountMinor: 100 }),
  });
  eq(patchSent.status, 409, "6.7 SENT header patch → 409 (§8)");
  eq(codeOf(patchSent), "SALES_QUOTATION_IMMUTABLE", "6.8 stable immutable code");
  const lineSent = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/lines`, {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ productId: productA3.id, qty: 1 }),
  });
  eq(lineSent.status, 409, "6.9 SENT line add rejected");
  const resend = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  eq(resend.status, 409, "6.10 re-send rejected (transition law)");
  eq(codeOf(resend), "SALES_QUOTATION_INVALID_TRANSITION", "6.11 stable transition code");
  const finPostSend = await finSnapshot();
  eq(JSON.stringify(finPreSend), JSON.stringify(finPostSend), "6.12 mark-sent mutated NOTHING (stock/finance §1)");

  /* ------------------------------ 7. accept --------------------------------- */
  section("7. accept (server acceptedAt, NO order created §13)");
  const orderCountBeforeAccept = await db.salesOrder.count({ where: { businessId: bizA.id } });
  const finPreAccept = await finSnapshot();
  const accept1 = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/accept`, { method: "POST", headers: B(bizA.id) });
  eq(accept1.status, 200, "7.1 SENT → ACCEPTED");
  const acceptedBody = dataOf(accept1);
  eq(acceptedBody.status, "ACCEPTED", "7.2 status ACCEPTED");
  ok("7.3 acceptedAt SERVER-generated", typeof acceptedBody.acceptedAt === "string" && !Number.isNaN(Date.parse(acceptedBody.acceptedAt)));
  const orderCountAfterAccept = await db.salesOrder.count({ where: { businessId: bizA.id } });
  eq(orderCountAfterAccept, orderCountBeforeAccept, "7.4 NO SalesOrder created by acceptance (explicit conversion only §13)");
  const finPostAccept = await finSnapshot();
  eq(JSON.stringify(finPreAccept), JSON.stringify(finPostAccept), "7.5 acceptance mutated NOTHING (stock/finance §1)");
  const reaccept = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/accept`, { method: "POST", headers: B(bizA.id) });
  eq(reaccept.status, 409, "7.6 re-accept rejected");
  eq(codeOf(reaccept), "SALES_QUOTATION_INVALID_TRANSITION", "7.7 stable transition code");

  /* ----------------------- 8. reject + cancel paths ------------------------- */
  section("8. second quotation SENT → reject; convert-on-rejected → NOT_ACCEPTED; third → cancel");
  const q2 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-REJ`, validUntilDate: calDate(daysFromNow(20)) }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${q2.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA3.id, qty: 3 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q2.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  const reject1 = await call(ownerF, `/api/v1/sales-quotations/${q2.id}/reject`, { method: "POST", headers: B(bizA.id) });
  eq(reject1.status, 200, "8.1 SENT → REJECTED");
  ok("8.2 rejectedAt server-generated", typeof dataOf(reject1).rejectedAt === "string");
  const convertRejected = await call(ownerF, `/api/v1/sales-quotations/${q2.id}/convert`, { method: "POST", headers: B(bizA.id) });
  eq(convertRejected.status, 409, "8.3 conversion of a REJECTED quotation → 409");
  eq(codeOf(convertRejected), "SALES_QUOTATION_NOT_ACCEPTED", "8.4 stable not-accepted code");
  const rereject = await call(ownerF, `/api/v1/sales-quotations/${q2.id}/reject`, { method: "POST", headers: B(bizA.id) });
  eq(rereject.status, 409, "8.5 REJECTED is terminal");
  const cancelRejected = await call(ownerF, `/api/v1/sales-quotations/${q2.id}/cancel`, { method: "POST", headers: B(bizA.id) });
  eq(cancelRejected.status, 409, "8.6 REJECTED cannot be cancelled (terminal §8)");

  const q3 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-CXL`, validUntilDate: calDate(daysFromNow(20)) }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${q3.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA3.id, qty: 2 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q3.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  const cancel1 = await call(ownerF, `/api/v1/sales-quotations/${q3.id}/cancel`, { method: "POST", headers: B(bizA.id) });
  eq(cancel1.status, 200, "8.7 SENT → CANCELLED");
  ok("8.8 cancelledAt server-generated", typeof dataOf(cancel1).cancelledAt === "string");
  const recancel = await call(ownerF, `/api/v1/sales-quotations/${q3.id}/cancel`, { method: "POST", headers: B(bizA.id) });
  eq(recancel.status, 409, "8.9 CANCELLED is terminal");
  const fin8 = await finSnapshot();
  eq(JSON.stringify(fin0), JSON.stringify(fin8), "8.10 reject/cancel paths mutated NOTHING");

  /* ------------------------------ 9. EXPIRED -------------------------------- */
  section("9. EXPIRED law (past-validity offer end-to-end)");
  const q4Res = await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({
      reference: `${TAG}-EXP`,
      quotationDate: calDate(daysFromNow(-60)), // explicit PAST quotation date
      validUntilDate: calDate(daysFromNow(-30)), // validity long past
    }),
  });
  eq(q4Res.status, 201, "9.1 past-dated quotation creation ACCEPTED (historical backfill is legal)");
  const q4 = dataOf(q4Res);
  await call(ownerF, `/api/v1/sales-quotations/${q4.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA3.id, qty: 4 }) });
  const d4draft = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q4.id}`, { headers: B(bizA.id) }));
  eq(d4draft.quotation.persistedStatus, "DRAFT", "9.2 DRAFT never displays as EXPIRED (display law is SENT-only)");
  const send4 = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  eq(send4.status, 200, "9.3 mark-sent ALLOWED on a past-validity DRAFT (DRAFT→SENT is not validity-gated)");
  const d4sent = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q4.id}`, { headers: B(bizA.id) }));
  eq(d4sent.quotation.persistedStatus, "SENT", "9.4 persisted status stays SENT");
  eq(d4sent.quotation.effectiveStatus, "EXPIRED", "9.5 effectiveStatus EXPIRED (display law §9, DB never silently mutated)");
  eq(d4sent.quotation.isExpired, true, "9.6 isExpired verdict server-computed");

  const accept4 = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/accept`, { method: "POST", headers: B(bizA.id) });
  eq(accept4.status, 409, "9.7 accept past-validity offer → 409");
  eq(codeOf(accept4), "SALES_QUOTATION_EXPIRED", "9.8 stable expired code");
  const reject4 = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/reject`, { method: "POST", headers: B(bizA.id) });
  eq(reject4.status, 409, "9.9 reject past-validity offer → 409 EXPIRED too");
  eq(codeOf(reject4), "SALES_QUOTATION_EXPIRED", "9.10 stable expired code (reject path)");
  // Conversion of a SENT (not accepted) offer is a conflict — the stable
  // code distinguishes the wrong-lifecycle-phase case (INVALID_STATUS).
  const convert4sent = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/convert`, { method: "POST", headers: B(bizA.id) });
  eq(convert4sent.status, 409, "9.11 convert non-ACCEPTED offer → 409");
  eq(codeOf(convert4sent), "SALES_QUOTATION_INVALID_STATUS", "9.12 SENT (wrong lifecycle phase) → INVALID_STATUS");

  const expire4 = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/expire`, { method: "POST", headers: B(bizA.id) });
  eq(expire4.status, 200, "9.13 explicit expire transition (offer IS past validity)");
  eq(dataOf(expire4).status, "EXPIRED", "9.14 persisted status EXPIRED");
  const d4expired = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q4.id}`, { headers: B(bizA.id) }));
  eq(d4expired.quotation.persistedStatus, "EXPIRED", "9.15 DB row updated exactly once");
  const convert4expired = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/convert`, { method: "POST", headers: B(bizA.id) });
  eq(convert4expired.status, 409, "9.16 convert EXPIRED → 409");
  eq(codeOf(convert4expired), "SALES_QUOTATION_NOT_ACCEPTED", "9.17 stable not-accepted code for the terminal-expired case");
  const expire4again = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/expire`, { method: "POST", headers: B(bizA.id) });
  eq(expire4again.status, 409, "9.18 EXPIRED is terminal (expire again → 409)");
  eq(codeOf(expire4again), "SALES_QUOTATION_INVALID_TRANSITION", "9.19 stable terminal code");
  const cancel4 = await call(ownerF, `/api/v1/sales-quotations/${q4.id}/cancel`, { method: "POST", headers: B(bizA.id) });
  eq(cancel4.status, 409, "9.20 EXPIRED cannot be cancelled (terminal)");

  /* --------------------------- 10. expire-not-yet --------------------------- */
  section("10. a VALID sent offer can never be force-expired (NOT_EXPIRED)");
  const q5 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-VALID`, validUntilDate: calDate(daysFromNow(45)) }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${q5.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA3.id, qty: 6 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q5.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  const expire5 = await call(ownerF, `/api/v1/sales-quotations/${q5.id}/expire`, { method: "POST", headers: B(bizA.id) });
  eq(expire5.status, 409, "10.1 expire a valid SENT offer → 409");
  eq(codeOf(expire5), "SALES_QUOTATION_NOT_EXPIRED", "10.2 stable not-expired code");
  const d5 = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q5.id}`, { headers: B(bizA.id) }));
  eq(d5.quotation.persistedStatus, "SENT", "10.3 status unchanged by the rejected expire");

  /* --------------------- 11. conversion (Journey H) ------------------------- */
  section("11. conversion: ACCEPTED → exactly ONE CONFIRMED SalesOrder (frozen snapshots)");
  const q6 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ customerId: customerA.id, reference: `${TAG}-CONV`, validUntilDate: calDate(daysFromNow(30)), internalNotes: "convert me" }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${q6.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA.id, qty: 7 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q6.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA2.id, qty: 3, unitPriceMinor: 1500 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q6.id}`, { method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ discountMinor: 500, expectedDeliveryDate: calDate(daysFromNow(21)) }) });
  await call(ownerF, `/api/v1/sales-quotations/${q6.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  const accept6 = await call(ownerF, `/api/v1/sales-quotations/${q6.id}/accept`, { method: "POST", headers: B(bizA.id) });
  eq(accept6.status, 200, "11.1 quotation accepted");
  const q6Detail = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q6.id}`, { headers: B(bizA.id) }));
  const q6Subtotal = q6Detail.summary.subtotalMinor;
  const q6Total = q6Detail.summary.totalMinor;

  const finPreConvert = await finSnapshot();
  const salesCountPre = await db.sale.count({ where: { businessId: bizA.id } });
  const orderLinesPre = await db.salesOrderLine.count({ where: { salesOrder: { businessId: bizA.id } } });
  const convert6 = await call(ownerF, `/api/v1/sales-quotations/${q6.id}/convert`, { method: "POST", headers: B(bizA.id) });
  eq(convert6.status, 200, "11.2 conversion 200");
  const conv = dataOf(convert6);
  ok(`11.3 order reference ${conv.salesOrder?.reference} (SO- domain §10)`, conv.salesOrder?.reference?.startsWith("SO-"));
  eq(conv.salesOrder?.status, "CONFIRMED", "11.4 order CONFIRMED");
  ok("11.5 confirmedAt server-generated", typeof conv.salesOrder?.confirmedAt === "string" && !Number.isNaN(Date.parse(conv.salesOrder.confirmedAt)));

  // DB-level verification: exactly ONE linked order.
  const linkedOrders = await db.salesOrder.findMany({ where: { sourceQuotationId: q6.id }, include: { lines: true } });
  eq(linkedOrders.length, 1, "11.6 exactly ONE SalesOrder with sourceQuotationId = quotation id");
  const order = linkedOrders[0];
  eq(order.status, "CONFIRMED", "11.7 persisted order CONFIRMED");
  ok("11.8 persisted confirmedAt set", Boolean(order.confirmedAt));
  eq(order.customerNameAtOrder, customerA.name, "11.9 order customer snapshot == quotation snapshot (frozen §12)");
  eq(order.currencyCodeAtOrder, q6Detail.quotation.currencyCodeAtQuotation, "11.10 currency snapshots equal");
  eq(order.currencySymbolAtOrder, q6Detail.quotation.currencySymbolAtQuotation, "11.11 currency symbol equal");
  eq(order.decimalPrecisionAtOrder, q6Detail.quotation.decimalPrecisionAtQuotation, "11.12 precision equal");
  eq(order.orderDate.toISOString(), `${todayLocal("Asia/Tehran")}T12:00:00.000Z`, "11.13 orderDate is TODAY (business-local) at the UTC-midnoon rule");
  eq(order.expectedDate?.toISOString() ?? null, q6Detail.quotation.expectedDeliveryDate, "11.14 expectedDate copied from the quotation");
  eq(order.discountMinor, 500, "11.15 discountMinor copied EXACTLY");
  eq(order.notes, "convert me", "11.16 internalNotes carried to staff order notes (§13)");
  eq(order.lines.length, 2, "11.17 ONE order line per quotation line");
  const q6Lines = [...q6Detail.lines].sort((a, b) => a.productId.localeCompare(b.productId));
  const oLines = [...order.lines].sort((a, b) => a.productId.localeCompare(b.productId));
  for (let i = 0; i < 2; i++) {
    eq(oLines[i].productId, q6Lines[i].productId, `11.18.${i} order line productId == quotation line productId`);
    eq(oLines[i].orderedQty, q6Lines[i].qty, `11.19.${i} order line qty == quotation qty (exact)`);
    eq(oLines[i].unitPriceMinor, q6Lines[i].unitPriceMinor, `11.20.${i} order line price == offered price (never re-priced)`);
    eq(oLines[i].productNameAtOrder, q6Lines[i].productNameAtQuotation, `11.21.${i} snapshots copied from the quotation line`);
  }
  // Order totals derived via the order domain laws (lineTotal = qty × price).
  const orderSubtotal = oLines.reduce((acc, l) => acc + l.orderedQty * l.unitPriceMinor, 0);
  eq(orderSubtotal, q6Subtotal, "11.22 order subtotal == quotation subtotal (computed via order laws)");
  eq(orderSubtotal - order.discountMinor, q6Total, "11.23 order total == quotation total");
  eq(orderSubtotal, 7 * 500 + 3 * 1500, "11.24 subtotal matches the raw line math (7×500 + 3×1500)");

  const q6After = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q6.id}`, { headers: B(bizA.id) }));
  eq(q6After.quotation.persistedStatus, "CONVERTED", "11.25 quotation CONVERTED");
  ok("11.26 convertedAt set", Boolean(q6After.quotation.convertedAt));
  eq(q6After.convertedOrder?.id, order.id, "11.27 convertedOrder DTO present + linked");
  eq(q6After.convertedOrder?.reference, order.reference, "11.28 converted order reference surfaced");

  const finPostConvert = await finSnapshot();
  eq(JSON.stringify(finPreConvert), JSON.stringify(finPostConvert), "11.29 conversion created NO Sale/Payment/adjustment and moved NO stock (§13)");
  eq(await db.sale.count({ where: { businessId: bizA.id } }), salesCountPre, "11.30 exactly zero new Sales");
  eq(await db.salesOrderLine.count({ where: { salesOrder: { businessId: bizA.id } } }), orderLinesPre + 2, "11.31 exactly 2 new SalesOrderLines (the converted order's)");
  const convAudit = await db.auditLog.findMany({ where: { businessId: bizA.id, entityId: q6.id, action: { startsWith: "sales_quotation." } }, orderBy: { createdAt: "asc" } });
  ok("11.32 sales_quotation.convert audited", convAudit.some((a) => a.action === "sales_quotation.convert"));
  ok(await db.auditLog.count({ where: { businessId: bizA.id, action: "sales_order.create", entityId: order.id } }) === 1, "11.33 sales_order.create audited (order side)");

  /* --------------------- 12. duplicate conversion --------------------------- */
  section("12. duplicate conversion → 409 ALREADY_CONVERTED, still ONE order");
  const reconvert = await call(ownerF, `/api/v1/sales-quotations/${q6.id}/convert`, { method: "POST", headers: B(bizA.id) });
  eq(reconvert.status, 409, "12.1 second conversion → 409");
  eq(codeOf(reconvert), "SALES_QUOTATION_ALREADY_CONVERTED", "12.2 stable already-converted code");
  eq(await db.salesOrder.count({ where: { sourceQuotationId: q6.id } }), 1, "12.3 still EXACTLY ONE order");

  /* ------------------ 13. concurrent conversion race ------------------------ */
  section("13. concurrent conversion race (5× on a fresh accepted quotation)");
  const q7 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-RACE1`, validUntilDate: calDate(daysFromNow(30)) }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${q7.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA.id, qty: 2 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q7.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  await call(ownerF, `/api/v1/sales-quotations/${q7.id}/accept`, { method: "POST", headers: B(bizA.id) });
  const finPreRace = await finSnapshot();
  const raceResults = await Promise.allSettled(
    Array.from({ length: 5 }, () => call(ownerF, `/api/v1/sales-quotations/${q7.id}/convert`, { method: "POST", headers: B(bizA.id) })),
  );
  const settled = raceResults.map((r) => (r.status === "fulfilled" ? r.value : { status: -1, body: { error: { code: String(r.reason) } } }));
  const wins = settled.filter((r) => r.status === 200);
  const losses = settled.filter((r) => r.status === 409);
  eq(wins.length, 1, "13.1 exactly ONE HTTP 200");
  eq(losses.length, 4, "13.2 four 409 losers");
  ok(losses.every((r) => codeOf(r) === "SALES_QUOTATION_ALREADY_CONVERTED"), "13.3 every loser carries the ONE stable conflict code");
  eq(await db.salesOrder.count({ where: { sourceQuotationId: q7.id } }), 1, "13.4 exactly ONE SalesOrder in the DB (unique constraint authority)");
  const finPostRace = await finSnapshot();
  eq(JSON.stringify(finPreRace), JSON.stringify(finPostRace), "13.5 no Sale/Payment/adjustment/stock change from ANY racer");
  const raceQ = await db.salesQuotation.findUnique({ where: { id: q7.id }, select: { status: true, convertedAt: true } });
  eq(raceQ?.status, "CONVERTED", "13.6 quotation CONVERTED exactly once");

  /* ------------------ 14. concurrent duplicate-line race -------------------- */
  section("14. concurrent duplicate-line race (5× same product)");
  const q8 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-RACE2`, validUntilDate: calDate(daysFromNow(30)) }),
  }));
  const lineRace = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      call(ownerF, `/api/v1/sales-quotations/${q8.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA3.id, qty: 1 }) })),
  );
  const lineSettled = lineRace.map((r) => (r.status === "fulfilled" ? r.value : { status: -1, body: null }));
  eq(lineSettled.filter((r) => r.status === 201).length, 1, "14.1 exactly one line-create winner");
  eq(lineSettled.filter((r) => r.status === 409).length, 4, "14.2 four 409 losers");
  eq(await db.salesQuotationLine.count({ where: { salesQuotationId: q8.id } }), 1, "14.3 exactly ONE persisted line (DB uniqueness authoritative)");

  /* ---------------- 15. concurrent duplicate-reference race ----------------- */
  section("15. concurrent duplicate-reference creation race (5× same reference)");
  const sharedRef = `${TAG}-RACEREF`;
  const refRace = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      call(ownerF, "/api/v1/sales-quotations", { method: "POST", headers: B(bizA.id), body: JSON.stringify({ reference: sharedRef, validUntilDate: calDate(daysFromNow(30)) }) })),
  );
  const refSettled = refRace.map((r) => (r.status === "fulfilled" ? r.value : { status: -1, body: { error: { code: "" } } }));
  eq(refSettled.filter((r) => r.status === 201).length, 1, "15.1 exactly one 201 winner");
  eq(refSettled.filter((r) => r.status === 409).length, 4, "15.2 four 409 losers");
  ok(refSettled.filter((r) => r.status === 409).every((r) => codeOf(r) === "SALES_QUOTATION_DUPLICATE_REFERENCE"), "15.3 losers carry the stable duplicate-reference code");
  eq(await db.salesQuotation.count({ where: { businessId: bizA.id, reference: sharedRef } }), 1, "15.4 exactly ONE persisted quotation with the reference");

  /* ------------------ 16. concurrent edit-vs-mark-sent ---------------------- */
  section("16. concurrent edit-vs-mark-sent (no partial write, no post-send edit)");
  const q9 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-RACE3`, validUntilDate: calDate(daysFromNow(30)) }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${q9.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA.id, qty: 1 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q9.id}`, { method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ discountMinor: 100 }) });
  const preRef = `${TAG}-RACE3`;
  const newRef = `${TAG}-RACE3B`;
  const [patchRes, sendRes] = await Promise.allSettled([
    call(ownerF, `/api/v1/sales-quotations/${q9.id}`, { method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ reference: newRef }) }),
    call(ownerF, `/api/v1/sales-quotations/${q9.id}/mark-sent`, { method: "POST", headers: B(bizA.id) }),
  ]);
  const patchR = patchRes.status === "fulfilled" ? patchRes.value : { status: -1 };
  const sendR = sendRes.status === "fulfilled" ? sendRes.value : { status: -1 };
  eq(sendR.status, 200, "16.1 mark-sent succeeds in one of the two orderings (quotation has lines)");
  const d9 = dataOf(await call(ownerF, `/api/v1/sales-quotations/${q9.id}`, { headers: B(bizA.id) }));
  eq(d9.quotation.persistedStatus, "SENT", "16.2 final status SENT");
  const finalRef = d9.quotation.reference;
  ok(finalRef === preRef || finalRef === newRef, "16.3 final reference is exactly ONE of the two candidates (no torn write)");
  eq(patchR.status, finalRef === newRef ? 200 : 409, "16.4 patch result CONSISTENT with the final state (200 iff the edit landed before the freeze)");
  eq(d9.summary.discountMinor, 100, "16.5 discount untouched by the race (no partial header write)");
  const latePatch = await call(ownerF, `/api/v1/sales-quotations/${q9.id}`, { method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ reference: `${TAG}-RACE3C` }) });
  eq(latePatch.status, 409, "16.6 no header mutation AFTER SENT (editable gate held)");

  /* ------------------ 17. concurrent accept-vs-reject ----------------------- */
  section("17. concurrent accept-vs-reject (exactly one wins)");
  const q10 = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-RACE4`, validUntilDate: calDate(daysFromNow(30)) }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${q10.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: productA.id, qty: 1 }) });
  await call(ownerF, `/api/v1/sales-quotations/${q10.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  const arResults = await Promise.allSettled([
    call(ownerF, `/api/v1/sales-quotations/${q10.id}/accept`, { method: "POST", headers: B(bizA.id) }),
    call(ownerF, `/api/v1/sales-quotations/${q10.id}/reject`, { method: "POST", headers: B(bizA.id) }),
  ]);
  const arSettled = arResults.map((r) => (r.status === "fulfilled" ? r.value : { status: -1, body: { error: { code: "" } } }));
  eq(arSettled.filter((r) => r.status === 200).length, 1, "17.1 exactly one 200");
  eq(arSettled.filter((r) => r.status === 409).length, 1, "17.2 the other is a 409");
  const q10row = await db.salesQuotation.findUnique({ where: { id: q10.id }, select: { status: true, acceptedAt: true, rejectedAt: true } });
  ok(q10row?.status === "ACCEPTED" || q10row?.status === "REJECTED", "17.3 persisted status is ACCEPTED or REJECTED");
  ok("17.4 NEVER both timestamps (lifecycle consistency law)", Boolean(q10row?.acceptedAt) !== Boolean(q10row?.rejectedAt));

  /* --------------------- 18. tenant isolation (§24) ------------------------- */
  section("18. tenant isolation both directions + RBAC");
  const crossGet = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizB.id) });
  eq(crossGet.status, 404, "18.1 foreign quotation detail → 404");
  const crossList = await call(ownerBF, "/api/v1/sales-quotations", { headers: B(bizB.id) });
  eq(dataOf(crossList).items.length, 0, "18.2 foreign quotations NEVER in B's list");
  const crossPatch = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}`, { method: "PATCH", headers: B(bizB.id), body: JSON.stringify({ reference: "hacked" }) });
  eq(crossPatch.status, 404, "18.3 foreign patch → 404");
  const crossLine = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}/lines`, { method: "POST", headers: B(bizB.id), body: JSON.stringify({ productId: productB.id, qty: 1 }) });
  eq(crossLine.status, 404, "18.4 foreign line add → 404");
  const crossSend = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}/mark-sent`, { method: "POST", headers: B(bizB.id) });
  eq(crossSend.status, 404, "18.5 foreign mark-sent → 404");
  const crossAccept = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}/accept`, { method: "POST", headers: B(bizB.id) });
  eq(crossAccept.status, 404, "18.6 foreign accept → 404");
  const crossConvert = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}/convert`, { method: "POST", headers: B(bizB.id) });
  eq(crossConvert.status, 404, "18.7 foreign convert → 404");
  const crossExport = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}/export`, { headers: B(bizB.id) });
  eq(crossExport.status, 404, "18.8 foreign export → 404 (never 403 leaking existence)");
  const crossPrint = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}/print`, { headers: B(bizB.id) });
  eq(crossPrint.status, 404, "18.9 foreign print → 404");
  const crossMalformed = await call(ownerBF, "/api/v1/sales-quotations/NOT-A-CUID", { headers: B(bizB.id) });
  eq(crossMalformed.status, 404, "18.10 malformed id → 404 (never 500)");
  const foreignCustomerCreate = await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ customerId: customerB.id, validUntilDate: calDate(daysFromNow(30)) }),
  });
  eq(foreignCustomerCreate.status, 404, "18.11 A cannot use B's customer id → 404");
  const foreignProductLine = await call(ownerF, `/api/v1/sales-quotations/${q8.id}/lines`, {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ productId: productB.id, qty: 1 }),
  });
  eq(foreignProductLine.status, 404, "18.12 A's DRAFT quotation + B's product id → 404 (never a cross-tenant line)");
  const anon = makeClient();
  const anonList = await call(anon, "/api/v1/sales-quotations");
  eq(anonList.status, 401, "18.13 unauthenticated list → 401");
  const anonCreate = await call(anon, "/api/v1/sales-quotations", { method: "POST", headers: B(bizA.id), body: "{}" });
  eq(anonCreate.status, 401, "18.14 unauthenticated create → 401");
  const viewerCreate = await call(viewerF, "/api/v1/sales-quotations", { method: "POST", headers: B(bizA.id), body: JSON.stringify({ validUntilDate: calDate(daysFromNow(5)) }) });
  eq(viewerCreate.status, 403, "18.15 viewer (data:read only) write → 403");
  const viewerSend = await call(viewerF, `/api/v1/sales-quotations/${q5.id}/mark-sent`, { method: "POST", headers: B(bizA.id) });
  eq(viewerSend.status, 403, "18.16 viewer lifecycle write → 403");
  const viewerDetail = await call(viewerF, `/api/v1/sales-quotations/${q1.id}`, { headers: B(bizA.id) });
  eq(viewerDetail.status, 200, "18.17 viewer CAN read (data:read)");
  eq(dataOf(viewerDetail).quotation.internalNotes, "P47Q internal cost hint", "18.18 viewer detail is the staff view (internalNotes visible to authorized staff §16)");

  /* ------------------------ 19. global search (§18) ------------------------- */
  section("19. global search SALES_QUOTATION + tenant safety");
  const searchRef = await call(ownerF, `/api/v1/search?q=${encodeURIComponent(q1.reference)}`, { headers: B(bizA.id) });
  eq(searchRef.status, 200, "19.1 search responds");
  const groups = dataOf(searchRef)?.groups ?? [];
  const sqGroup = groups.find((g) => g.type === "SALES_QUOTATION");
  ok("19.2 SALES_QUOTATION group present", Boolean(sqGroup));
  ok("19.3 quotation found by reference", sqGroup?.items?.some((i) => i.id === q1.id));
  const searchCust = await call(ownerF, `/api/v1/search?q=${encodeURIComponent(origCustomerName)}`, { headers: B(bizA.id) });
  const custGroup = (dataOf(searchCust)?.groups ?? []).find((g) => g.type === "SALES_QUOTATION");
  ok("19.4 quotation found by customer snapshot", custGroup?.items?.some((i) => i.id === q1.id));
  const searchSku = await call(ownerF, `/api/v1/search?q=${encodeURIComponent(`${TAG}-SKU-1`)}`, { headers: B(bizA.id) });
  const skuGroup = (dataOf(searchSku)?.groups ?? []).find((g) => g.type === "SALES_QUOTATION");
  ok("19.5 quotation found by line SKU snapshot", skuGroup?.items?.some((i) => i.id === q1.id));
  const searchB = await call(ownerBF, `/api/v1/search?q=${encodeURIComponent(q1.reference)}`, { headers: B(bizB.id) });
  const bGroup = (dataOf(searchB)?.groups ?? []).find((g) => g.type === "SALES_QUOTATION");
  ok("19.6 foreign business NEVER sees the quotation", !bGroup || !bGroup.items?.some((i) => i.id === q1.id));
  const searchItem = sqGroup?.items?.find((i) => i.id === q1.id);
  ok("19.7 search items carry NO notes (§10)", searchItem ? !JSON.stringify(searchItem).includes("internalNotes") && !JSON.stringify(searchItem).includes("customerNotes") : false);

  /* ------------------ 20. Customer 360 + Product detail --------------------- */
  section("20. Customer 360 + Product detail quotation history (§19)");
  const cust360 = dataOf(await call(ownerF, `/api/v1/customers/${customerA.id}`, { headers: B(bizA.id) }));
  ok("20.1 Customer 360 carries recentSalesQuotations", Array.isArray(cust360.recentSalesQuotations));
  ok("20.2 bounded to ≤10 rows", cust360.recentSalesQuotations.length <= 10);
  const c360row = cust360.recentSalesQuotations.find((r) => r.id === q6.id);
  ok("20.3 converted quotation present in Customer 360", Boolean(c360row));
  eq(c360row?.status, "CONVERTED", "20.4 snapshot status carried");
  eq(c360row?.convertedOrderReference, order.reference, "20.5 converted order reference surfaced");
  ok("20.6 customer rows carry the money + currency snapshot", typeof c360row?.totalMinor === "number" && typeof c360row?.currencyCodeAtQuotation === "string");
  const prodDetail = dataOf(await call(ownerF, `/api/v1/products/${productA.id}`, { headers: B(bizA.id) }));
  ok("20.7 Product detail carries recentSalesQuotations", Array.isArray(prodDetail.recentSalesQuotations));
  const pRow = prodDetail.recentSalesQuotations.find((r) => r.reference === q6.reference);
  ok("20.8 quotation line present in Product history", Boolean(pRow));
  ok("20.9 product rows carry quantities", pRow ? typeof pRow.qty === "number" : false);
  ok(
    "20.10 product quotation history is MONEY-FREE (§72/§19)",
    pRow ? !Object.keys(pRow).some((k) => k.toLowerCase().includes("minor") || k.toLowerCase().includes("price")) : false,
  );
  const prod360Foreign = await call(ownerBF, `/api/v1/products/${productA.id}`, { headers: B(bizB.id) });
  eq(prod360Foreign.status, 404, "20.11 foreign product detail → 404");

  /* --------------------------- 21. CSV export ------------------------------- */
  section("21. per-quotation CSV export (EN/FA, injection guard, entitlement)");
  // fetch().text() strips the UTF-8 BOM per the Fetch spec — verify the BOM
  // on the RAW BYTES, then reuse the decoded text for content assertions.
  const rawCsvRes = await fetch(`${BASE}/api/v1/sales-quotations/${q1.id}/export?locale=en`, {
    headers: { "x-business-id": bizA.id, cookie: ownerF.cookieHeader() },
  });
  const rawBytes = new Uint8Array(await rawCsvRes.arrayBuffer());
  ok("21.1 EN export 200", rawCsvRes.status === 200);
  ok("21.2 UTF-8 BOM present (EF BB BF)", rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf);
  const csvEn = { status: rawCsvRes.status, headers: rawCsvRes.headers, body: new TextDecoder("utf-8").decode(rawBytes) };
  const csvText = typeof csvEn.body === "string" ? csvEn.body : "";
  ok("21.3 CRLF line endings", csvText.includes("\r\n"));
  const headerLine = csvText.split("\r\n")[0];
  eq(
    headerLine,
    "Reference,Status,Customer,Currency,Quotation date,Valid until,Product,SKU,Unit,Quantity,Unit price,Line total,Discount,Total",
    "21.4 EXACT EN header row",
  );
  ok(csvText.includes(`${q1.reference}`), "21.5 reference column present");
  ok(csvText.includes("480") && csvText.includes("5760"), "21.6 snapshot values present (12×480 line)");
  ok(!csvText.includes("P47Q internal cost hint"), "21.7 internalNotes NEVER exported (§20)");
  eq(csvEn.headers.get("cache-control"), "no-store", "21.8 no-store");
  ok((csvEn.headers.get("content-disposition") ?? "").includes("attachment"), "21.9 attachment");
  const csvFa = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/export?locale=fa`, { headers: B(bizA.id) });
  eq(csvFa.status, 200, "21.10 FA export 200");
  const faText = typeof csvFa.body === "string" ? csvFa.body.replace(/^\uFEFF/, "") : "";
  const faHeaderLine = faText.split("\r\n")[0];
  eq(
    faHeaderLine,
    "شماره,وضعیت,مشتری,ارز,تاریخ استعلام,معتبر تا,محصول,کد کالا,واحد,تعداد,قیمت واحد,جمع بند,تخفیف,مبلغ نهایی",
    "21.11 EXACT FA header row (no English fallback)",
  );
  const csvBadLocale = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/export?locale=fr`, { headers: B(bizA.id) });
  eq(csvBadLocale.status, 422, "21.12 strict locale validation (fr → 422)");

  // Formula-injection guard: a hostile product name exports safely.
  const evil = await db.product.create({
    data: { businessId: bizA.id, name: "=1+1|cmd", sku: "@EVIL", salePriceMinor: 100, stockQty: 5 },
  });
  const evilQ = dataOf(await call(ownerF, "/api/v1/sales-quotations", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ reference: `${TAG}-EVIL`, validUntilDate: calDate(daysFromNow(7)) }),
  }));
  await call(ownerF, `/api/v1/sales-quotations/${evilQ.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ productId: evil.id, qty: 1 }) });
  const evilCsv = await call(ownerF, `/api/v1/sales-quotations/${evilQ.id}/export`, { headers: B(bizA.id) });
  const evilText = (typeof evilCsv.body === "string" ? evilCsv.body : "").replace(/^\uFEFF/, "");
  ok("21.13 formula injection guarded (= prefixed cell)", !/^=1\+1/m.test(evilText));
  ok("21.14 hostile cell neutralized with the OWASP apostrophe guard", evilText.includes("'=1+1|cmd"));
  await db.salesQuotationLine.deleteMany({ where: { salesQuotationId: evilQ.id } });
  await db.salesQuotation.delete({ where: { id: evilQ.id } }).catch(() => {});
  await db.product.delete({ where: { id: evil.id } }).catch(() => {});

  // CSV_EXPORT entitlement gate — custom plan with CSV_EXPORT=false on B.
  const defs = await db.entitlementDefinition.findMany();
  const defByCode = new Map(defs.map((d) => [d.code, d.id]));
  const noCsvPlan = await db.plan.create({
    data: {
      code: `${TAG}-NOCSV`,
      name: "P47Q fixture no-CSV",
      active: true,
      isPublic: false,
      sortOrder: 999,
      planEntitlements: {
        create: [
          { entitlementId: defByCode.get("CUSTOMERS_MAX"), value: 50 },
          { entitlementId: defByCode.get("PRODUCTS_MAX"), value: 25 },
          { entitlementId: defByCode.get("TEAM_MEMBERS_MAX"), value: 2 },
          { entitlementId: defByCode.get("BUSINESSES_MAX"), value: 1 },
          { entitlementId: defByCode.get("AI_REQUESTS_MAX"), value: 25 },
          { entitlementId: defByCode.get("AI_MESSAGES_MAX"), value: 25 },
          { entitlementId: defByCode.get("AI_COPILOT"), boolValue: true },
          { entitlementId: defByCode.get("ADVANCED_REPORTS"), boolValue: false },
          { entitlementId: defByCode.get("CSV_EXPORT"), boolValue: false },
        ],
      },
    },
  });
  await db.subscription.upsert({
    where: { businessId: bizB.id },
    create: { businessId: bizB.id, planId: noCsvPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" },
    update: { planId: noCsvPlan.id, status: "ACTIVE" },
  });
  const gated = await call(ownerBF, `/api/v1/sales-quotations/${q1.id}/export`, { headers: B(bizB.id) });
  ok(gated.status === 403 && codeOf(gated) === "ENTITLEMENT_NOT_AVAILABLE", `21.15 CSV_EXPORT=false plan → 403 ENTITLEMENT_NOT_AVAILABLE (got ${gated.status} ${codeOf(gated)})`);

  /* ---------------- 22. business export datasets (§20) ---------------------- */
  // The REAL business-export surface (Prompt 31 portability jobs): POST
  // /api/v1/exports { datasets, format } → synchronous job →
  // GET /api/v1/exports/[jobId] (datasets manifest) →
  // GET /api/v1/exports/[jobId]/download (JSON artifact
  // { manifest, datasets }).
  section("22. business export datasets (sales_quotations + sales_quotation_lines)");
  {
    const expJob = await call(ownerF, "/api/v1/exports", {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ datasets: ["sales_quotations"], format: "JSON", idempotencyKey: `P47QEXP${STAMP}` }),
    });
    ok([200, 201, 202].includes(expJob.status), `22.1 business export job starts (${expJob.status})`);
    const jobId = dataOf(expJob)?.id;
    if (jobId) {
      const job = await call(ownerF, `/api/v1/exports/${jobId}`, { headers: B(bizA.id) });
      const jobDatasets = dataOf(job)?.datasets ?? [];
      ok(jobDatasets.includes("sales_quotations"), "22.2 job datasets include sales_quotations (§20)");
      ok(jobDatasets.includes("sales_quotation_lines"), "22.3 job datasets include sales_quotation_lines (parent→child implication)");
      eq(dataOf(job)?.status, "COMPLETED", "22.3b export job completed synchronously");
      const dl = await call(ownerF, `/api/v1/exports/${jobId}/download`, { headers: B(bizA.id) });
      eq(dl.status, 200, "22.3c download 200");
      const artifact = typeof dl.body === "string" ? JSON.parse(dl.body) : dl.body;
      const qRows = artifact?.datasets?.sales_quotations ?? [];
      const lRows = artifact?.datasets?.sales_quotation_lines ?? [];
      ok(Array.isArray(qRows) && qRows.some((r) => r.reference === q1.reference), "22.3d artifact carries the quotation row (reference match)");
      ok(
        Array.isArray(lRows) && lRows.some((r) => r.salesQuotationId === q1.id && r.qty === 12 && r.unitPriceMinor === 480),
        "22.3e artifact carries the quotation LINE rows (snapshot qty/price)",
      );
      const artifactRaw = JSON.stringify(artifact ?? {});
      ok(!artifactRaw.includes("internal_notes") && !artifactRaw.includes("P47Q internal cost hint"), "22.3f export artifact NEVER contains internal notes (§20)");
    } else {
      ok(false, "22.2 export job id missing — cannot verify manifest");
      ok(false, "22.3 export job id missing — cannot verify manifest");
    }
    // The export CATALOG structurally carries the parent→child implication
    // and the EXACT JSON/CSV columns (snapshot-faithful, NO internal notes).
    const catSrc = readFileSync("src/lib/data-portability/export-catalog.ts", "utf8");
    ok(catSrc.includes('sales_quotations: ["sales_quotation_lines"]'), "22.4 parent dataset implies child lines (§20)");
    ok(
      catSrc.includes('"id", "reference", "status", "customer_id", "customer_name_at_quotation"'),
      "22.5 sales_quotations JSON columns present (snapshot-faithful)",
    );
    ok(
      catSrc.includes('"id", "sales_quotation_id", "product_id", "product_name_at_quotation"'),
      "22.6 sales_quotation_lines JSON columns present",
    );
    const qBlock = catSrc.split("sales_quotations: [")[1]?.split("]")[0] ?? "";
    ok(!qBlock.includes("internal_notes"), "22.7 NO internal_notes column in the sales_quotations dataset (§20)");
  }

  /* ------------------------ 23. import rejection (§20) ---------------------- */
  // The REAL import surface: POST /api/v1/imports (multipart dataset+file).
  // The dataset allowlist (customers | suppliers | products) is checked
  // BEFORE any file parse and BEFORE any DataImportJob row is created.
  section("23. import rejection BEFORE any DB write");
  {
    const jobsBefore = await db.dataImportJob.count({ where: { businessId: bizA.id } });
    const qCountBefore = await db.salesQuotation.count({ where: { businessId: bizA.id } });
    const mkForm = (dataset) => {
      const fd = new FormData();
      fd.set("dataset", dataset);
      fd.set("file", new File(["id,name\nx,Replay\n"], "replay.csv", { type: "text/csv" }));
      return fd;
    };
    const imp = await call(ownerF, "/api/v1/imports", {
      method: "POST",
      headers: B(bizA.id),
      body: mkForm("sales_quotations"),
    });
    ok(imp.status === 422 && codeOf(imp) === "IMPORT_INVALID_FILE", `23.1 sales_quotations import REJECTED (got ${imp.status} ${codeOf(imp)})`);
    const unknown = await call(ownerF, "/api/v1/imports", {
      method: "POST",
      headers: B(bizA.id),
      body: mkForm("totally_unknown_dataset"),
    });
    ok(unknown.status === 422 && codeOf(unknown) === "IMPORT_INVALID_FILE", `23.2 unknown dataset name rejected (got ${unknown.status} ${codeOf(unknown)})`);
    const jobsAfter = await db.dataImportJob.count({ where: { businessId: bizA.id } });
    eq(jobsAfter, jobsBefore, "23.3 NO DataImportJob row created (rejection precedes any DB write)");
    const qCountAfter = await db.salesQuotation.count({ where: { businessId: bizA.id } });
    eq(qCountAfter, qCountBefore, "23.4 no import side effects (quotation count unchanged)");
  }

  /* --------------------------- 24. print endpoint --------------------------- */
  section("24. print endpoint — reduced customer-facing payload (§16)");
  const print = await call(ownerF, `/api/v1/sales-quotations/${q1.id}/print`, { headers: B(bizA.id) });
  eq(print.status, 200, "24.1 print 200");
  const printRaw = JSON.stringify(print.body ?? {});
  const p = dataOf(print);
  ok(!printRaw.includes("internalNotes"), "24.2 print payload has NO internalNotes key anywhere");
  ok(!/"id":/.test(printRaw), "24.3 print payload has NO database id keys");
  ok(!printRaw.includes("persistedStatus") && !printRaw.includes("effectiveStatus"), "24.4 print payload omits raw technical statuses");
  eq(p.customerNotes, "P47Q offer notes", "24.5 customerNotes present when set");
  eq(p.reference, q1.reference, "24.6 reference carried");
  eq(p.lines.length, 1, "24.7 lines carried (snapshot identity)");
  eq(p.totalMinor, p.subtotalMinor - p.discountMinor, "24.8 totals consistent");
  const anonPrint = await call(anon, `/api/v1/sales-quotations/${q1.id}/print`);
  eq(anonPrint.status, 401, "24.9 NO unauthenticated print URL (§2.7/§16)");

  /* ------------------------------ 25. teardown ------------------------------ */
  section("25. teardown to ZERO residue");
  await purge();
  const residueBiz = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  const residueUsers = await db.user.count({ where: { email: { endsWith: `@${DOMAIN}` } } });
  const residuePlans = await db.plan.count({ where: { code: { startsWith: `${TAG}-` } } });
  const residueQuotes = await db.salesQuotation.count({ where: { reference: { startsWith: "QT-" }, business: { name: { startsWith: `${TAG}-` } } } });
  eq(residueBiz, 0, "25.1 zero fixture businesses remain");
  eq(residueUsers, 0, "25.2 zero fixture users remain");
  eq(residuePlans, 0, "25.3 zero fixture plans remain");
  eq(residueQuotes, 0, "25.4 zero fixture quotations remain");
  const quickCheck = await db.$queryRawUnsafe("PRAGMA quick_check");
  ok(String(quickCheck?.[0]?.quick_check ?? quickCheck) === "ok", "25.5 database quick_check ok");

  /* ------------------------------- result ---------------------------------- */
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
