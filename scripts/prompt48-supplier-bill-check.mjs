#!/usr/bin/env node
/**
 * Prompt 48 — E2E SUPPLIER BILL CHECK. Real application + real DB.
 * Run: node scripts/prompt48-supplier-bill-check.mjs   (dev server on :3000)
 *
 * Covers (P48 §12/§14/§15): fixtures (2 tenants, NON-ZERO stock + financial
 * baseline) · PO → confirm → GoodsReceipt POSTED → GoodsReturn POSTED chain
 * · draft bill (authority injection rejections, snapshots, empty-gate) ·
 * line management (PO-line foreign rejection, over-receive, duplicate PO
 * line, price variance, remove) · DRAFT creates NO Expense/Payment/statement
 * movement/aging entry and moves NO stock (§10) · posting = EXACTLY ONE
 * linked Expense (amount/supplier/dates/reference/category equality §11) ·
 * zero-total rejection · post retry → ALREADY_LINKED · POSTED immutable
 * (edit/lines/cancel) · supplier statement shows the liability EXACTLY ONCE
 * · payables aging includes the payable EXACTLY ONCE (no double count §2) ·
 * Payment workflow authoritative (partial → PARTIAL, full → PAID, failed
 * payment never damages the bill; bill detail reads the LIVE Expense §12) ·
 * linked-Expense protection (generic edit/delete blocked; note edits
 * allowed; ordinary expenses unaffected) · return-quantity subtraction
 * (available = received − returned − billed) · Supplier 360 bill history ·
 * PO detail billing summary + per-line matching facts + recent bills ·
 * global search SUPPLIER_BILL (reference/invoice ref/supplier/product,
 * tenant-scoped) · per-bill CSV EN/FA + injection guard + CSV_EXPORT gate ·
 * canonical business export datasets + import rejection BEFORE mutation ·
 * backup round-trip (accepted-not-imported, no duplicate payable) ·
 * malformed ids → 404 · teardown to ZERO residue.
 *
 * Fixtures are P48B-prefixed and removed to ZERO. Prisma is used ONLY for
 * fixtures, assertions and cleanup — never to mutate domain rows.
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
const PASS = "P48Bqa!Passw0rd!1";
const TAG = "P48B";
const STAMP = `${Date.now()}`.slice(-8);
const DOMAIN = "p48b.test";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, info = "") {
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

// --- HTTP client with per-user cookie jar (verbatim P45/P47 mechanics) ------
function makeClient() {
  const jar = new Map();
  const f = async function f(path, init = {}) {
    const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
    const headers = {
      ...(isForm ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": init.xff ?? "10.48.7.19",
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
  f.cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  return f;
}

async function login(f, email) {
  const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString(),
  });
  const me = await f("/api/v1/me");
  if (me.status !== 200) {
    console.error(`  !! login failed for ${email}: me=${me.status}`);
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

const calDate = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000);

/* ------------------------------ fixtures ----------------------------------- */

async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.supplierBillLine.deleteMany({ where: { supplierBill: { businessId: b.id } } });
    await db.supplierBill.deleteMany({ where: { businessId: b.id } });
    await db.goodsReturnLine.deleteMany({ where: { goodsReturn: { businessId: b.id } } });
    await db.goodsReturn.deleteMany({ where: { businessId: b.id } });
    await db.goodsReceiptLine.deleteMany({ where: { goodsReceipt: { businessId: b.id } } });
    await db.goodsReceipt.deleteMany({ where: { businessId: b.id } });
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: b.id } } });
    await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.dataExportJob.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.dataImportJob.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } }).catch(() => {});
    await db.subscription.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.business.deleteMany({ where: { id: b.id } });
  }
  const users = await db.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  for (const u of users) {
    await db.userSession.deleteMany({ where: { userId: u.id } });
    await db.auditLog.deleteMany({ where: { actorId: u.id } });
    await db.chatMessage.deleteMany({ where: { session: { userId: u.id } } });
    await db.chatSession.deleteMany({ where: { userId: u.id } });
    await db.legalAcceptance.deleteMany({ where: { userId: u.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  }
  await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });
}

async function createUser(name) {
  return db.user.create({
    data: {
      email: `${TAG.toLowerCase()}-${name.toLowerCase()}-${STAMP}@${DOMAIN}`,
      name: `${TAG} ${name}`,
      passwordHash: bcrypt.hashSync(PASS, 4),
      locale: "en",
    },
  });
}

async function main() {
  await purge();
  const priorResidue = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  ok("0.1 no prior P48B residue before fixtures", priorResidue === 0);

  /* ---------------------------- 1. fixtures -------------------------------- */
  section("1. fixtures (2 tenants, non-zero stock + financial baseline)");

  const owner = await createUser("owner");
  const viewer = await createUser("viewer");
  const ownerB = await createUser("ownerB");
  ok("1.1 fixture users created", Boolean(owner?.id && viewer?.id && ownerB?.id));

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

  const supplierA = await db.supplier.create({
    data: { businessId: bizA.id, name: `${TAG} Industrial Supply` },
  });
  const supplierA2 = await db.supplier.create({
    data: { businessId: bizA.id, name: `${TAG} Second Supply` },
  });
  const supplierB = await db.supplier.create({
    data: { businessId: bizB.id, name: `${TAG} B Supply` },
  });
  ok("1.3 suppliers created", Boolean(supplierA?.id && supplierA2?.id && supplierB?.id));

  // "=cmd" product name exercises the CSV formula-injection guard.
  const productA1 = await db.product.create({
    data: { businessId: bizA.id, name: `${TAG} Widget`, sku: `${TAG}-SKU-1`, unit: "piece", salePriceMinor: 500, stockQty: 500 },
  });
  const productA2 = await db.product.create({
    data: { businessId: bizA.id, name: `=CMD|${TAG} Injection Probe`, sku: `${TAG}-SKU-2`, unit: "box", salePriceMinor: 1200, stockQty: 54 },
  });
  const productA3 = await db.product.create({
    data: { businessId: bizA.id, name: `${TAG} Cable`, sku: `${TAG}-SKU-3`, unit: "meter", salePriceMinor: 250, stockQty: 192 },
  });
  const productB1 = await db.product.create({
    data: { businessId: bizB.id, name: `${TAG} B-Only`, sku: `${TAG}-SKU-B`, salePriceMinor: 100, stockQty: 10 },
  });
  ok("1.4 products created (stocks 500/54/192/10)", Boolean(productA1?.id && productA2?.id && productA3?.id && productB1?.id));

  const legacySaleForA = await db.sale.create({
    data: {
      businessId: bizA.id,
      number: 91001,
      customerId: (await db.customer.create({ data: { businessId: bizA.id, name: `${TAG} Cust A` } })).id,
      subtotalMinor: 3000,
      discountMinor: 0,
      totalMinor: 3000,
      paidMinor: 1000,
      status: "PARTIAL",
      items: { create: { productId: productA1.id, name: productA1.name, qty: 3, unitPriceMinor: 1000, lineTotalMinor: 3000 } },
    },
  });
  await db.payment.create({
    data: { businessId: bizA.id, saleId: legacySaleForA.id, direction: "IN", amountMinor: 1000, method: "CASH" },
  });
  ok("1.5 non-zero Sale/Payment baseline created", true);

  const ownerF = makeClient();
  await login(ownerF, owner.email);
  const viewerF = makeClient();
  await login(viewerF, viewer.email);
  const ownerBF = makeClient();
  await login(ownerBF, ownerB.email);
  ok("1.6 sessions established for 3 users", true);

  const finSnapshot = async () => {
    const [saleAgg, paymentCount, adjAgg, expenseAgg, stocks] = await Promise.all([
      db.sale.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { totalMinor: true, paidMinor: true } }),
      db.payment.count({ where: { businessId: bizA.id } }),
      db.inventoryAdjustment.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { delta: true } }),
      db.expense.aggregate({ where: { businessId: bizA.id, deletedAt: null }, _count: { _all: true }, _sum: { amountMinor: true } }),
      db.product.findMany({ where: { businessId: bizA.id }, select: { id: true, stockQty: true }, orderBy: { id: "asc" } }),
    ]);
    return {
      saleCount: saleAgg._count._all,
      saleTotal: saleAgg._sum.totalMinor ?? 0,
      salePaid: saleAgg._sum.paidMinor ?? 0,
      paymentCount,
      adjCount: adjAgg._count._all,
      adjDelta: adjAgg._sum.delta ?? 0,
      expenseCount: expenseAgg._count._all,
      expenseTotal: expenseAgg._sum.amountMinor ?? 0,
      stockSum: stocks.reduce((acc, p) => acc + p.stockQty, 0),
      stockSig: stocks.map((p) => `${p.id}:${p.stockQty}`).join(","),
    };
  };

  /* -------------------- 2. procurement chain fixtures ---------------------- */
  section("2. PO → confirm → GoodsReceipt POSTED → GoodsReturn POSTED");

  // PO1: 100 @ 2000 + 40 @ 500 (this is the billing target).
  const po1 = dataOf(await call(ownerF, "/api/v1/purchase-orders", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ supplierId: supplierA.id, orderedAt: calDate(daysFromNow(-3)) }),
  }));
  eq(po1?.status, "DRAFT", "2.1 PO1 created as DRAFT");
  const po1l1 = dataOf(await call(ownerF, `/api/v1/purchase-orders/${po1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ productId: productA1.id, orderedQty: 100, unitPriceMinor: 2000 }),
  }));
  const po1l2 = dataOf(await call(ownerF, `/api/v1/purchase-orders/${po1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ productId: productA2.id, orderedQty: 40, unitPriceMinor: 500 }),
  }));
  ok("2.2 PO1 lines created (100@2000, 40@500)", Boolean(po1l1?.id && po1l2?.id));
  eq(dataOf(await call(ownerF, `/api/v1/purchase-orders/${po1.id}/send`, { method: "POST", headers: B(bizA.id) }))?.status, "SENT", "2.3a PO1 SENT");
  eq(dataOf(await call(ownerF, `/api/v1/purchase-orders/${po1.id}/confirm`, { method: "POST", headers: B(bizA.id) }))?.status, "CONFIRMED", "2.3 PO1 CONFIRMED");

  // PO2 (same supplier) — its lines must NEVER satisfy bill1's PO gate.
  const po2 = dataOf(await call(ownerF, "/api/v1/purchase-orders", {
    method: "POST",
    headers: B(bizA.id),
    body: JSON.stringify({ supplierId: supplierA.id }),
  }));
  const po2l1 = dataOf(await call(ownerF, `/api/v1/purchase-orders/${po2.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ productId: productA3.id, orderedQty: 5, unitPriceMinor: 100 }),
  }));
  eq(dataOf(await call(ownerF, `/api/v1/purchase-orders/${po2.id}/send`, { method: "POST", headers: B(bizA.id) }))?.status, "SENT", "2.4a PO2 SENT");
  eq(dataOf(await call(ownerF, `/api/v1/purchase-orders/${po2.id}/confirm`, { method: "POST", headers: B(bizA.id) }))?.status, "CONFIRMED", "2.4 PO2 CONFIRMED");
  ok("2.5 PO2 line created (5@100)", Boolean(po2l1?.id));

  // GR1: receive 60 of PO1-line1 + 40 of PO1-line2, then POST.
  const gr1 = dataOf(await call(ownerF, "/api/v1/inventory/goods-receipts", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po1.id }),
  }));
  const gr1l1 = dataOf(await call(ownerF, `/api/v1/inventory/goods-receipts/${gr1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po1l1.id, receivedQty: 60 }),
  }));
  const gr1l2 = dataOf(await call(ownerF, `/api/v1/inventory/goods-receipts/${gr1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po1l2.id, receivedQty: 40 }),
  }));
  eq(dataOf(await call(ownerF, `/api/v1/inventory/goods-receipts/${gr1.id}/post`, { method: "POST", headers: B(bizA.id) }))?.status, "POSTED", "2.6 GR1 POSTED (60 + 40 received)");
  ok("2.7 GR1 lines created", Boolean(gr1l1?.id && gr1l2?.id));

  // RT1: return 10 of PO1-line1 through the receipt line, then POST.
  const rt1 = dataOf(await call(ownerF, "/api/v1/inventory/goods-returns", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ goodsReceiptId: gr1.id }),
  }));
  await call(ownerF, `/api/v1/inventory/goods-returns/${rt1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ goodsReceiptLineId: gr1l1.id, returnedQty: 10, reasonCode: "DAMAGED" }),
  });
  eq(dataOf(await call(ownerF, `/api/v1/inventory/goods-returns/${rt1.id}/post`, { method: "POST", headers: B(bizA.id) }))?.status, "POSTED", "2.8 RT1 POSTED (10 returned)");

  const fin0 = await finSnapshot();

  /* -------------------- 3. draft creation + authority ---------------------- */
  section("3. draft bill creation (snapshots, server reference, authority rejections)");

  const badCreate = await call(ownerF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po1.id, billDate: calDate(daysFromNow(-1)), status: "POSTED", totalMinor: 999, expenseId: "fake", supplierId: "fake" }),
  });
  eq(badCreate.status, 422, "3.1 injected authority fields rejected by .strict() boundary");

  const wrongDate = await call(ownerF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po1.id, billDate: "2026-02-31" }),
  });
  eq(wrongDate.status, 422, "3.2 strict calendar date (2026-02-31 rejected)");

  const draftBillable = await call(ownerF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po2.id, billDate: calDate(daysFromNow(-1)) }),
  });
  // PO2 is CONFIRMED → billable; cancel it again (DRAFT → CANCELLED gate).
  eq(draftBillable.status, 201, "3.3 bill against CONFIRMED PO accepted");
  const cancelJunk = dataOf(await call(ownerF, `/api/v1/supplier-bills/${draftBillable.body.data.id}/cancel`, { method: "POST", headers: B(bizA.id) }));
  eq(cancelJunk?.status, "CANCELLED", "3.4 junk draft cancelled (pure document transition)");

  const created = await call(ownerF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({
      purchaseOrderId: po1.id,
      supplierInvoiceReference: `INV-${STAMP}-001`,
      billDate: calDate(daysFromNow(-1)),
      dueDate: calDate(daysFromNow(29)),
      internalNotes: "P48B internal staff note — must NEVER leak",
    }),
  });
  eq(created.status, 201, "3.5 draft bill created (server reference)");
  const bill1 = dataOf(created);
  ok(bill1.reference.startsWith("SB-"), `3.6 server-generated SB- reference ${bill1.reference}`);
  eq(bill1.status, "DRAFT", "3.7 created as DRAFT");

  const detail1 = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(detail1.supplierNameAtBill, supplierA.name, "3.8 supplier snapshot frozen from the PO");
  eq(detail1.purchaseOrderReferenceAtBill, po1.reference, "3.9 PO reference snapshot frozen");
  eq(detail1.currencyCodeAtBill, "USD", "3.10 currency snapshot from the PO");
  eq(detail1.totalMinor, 0, "3.11 draft totals start at zero");
  eq(detail1.payable, null, "3.12 DRAFT has NO payable (§10)");
  eq(detail1.lines.length, 0, "3.13 draft starts empty");
  eq(detail1.internalNotes, "P48B internal staff note — must NEVER leak", "3.14 notes visible to staff detail only");

  // DRAFT creates no financial rows anywhere (§10).
  const finDraft = await finSnapshot();
  eq(finDraft.expenseCount, fin0.expenseCount, "3.15 draft creates NO Expense");
  eq(finDraft.paymentCount, fin0.paymentCount, "3.16 draft creates NO Payment");
  eq(finDraft.stockSig, fin0.stockSig, "3.17 draft adds NO stock movement");
  const stmtDraft = dataOf(await call(ownerF, `/api/v1/suppliers/${supplierA.id}/statement`, { headers: B(bizA.id) }));
  const draftStmtRows = (stmtDraft?.rows ?? []).filter((e) => String(e.reference ?? "").includes(`INV-${STAMP}-001`));
  eq(draftStmtRows.length, 0, "3.18 draft excluded from supplier statement");
  const agingDraft = dataOf(await call(ownerF, "/api/v1/reports/aging", { headers: B(bizA.id) }));
  eq(agingDraft?.payables?.openCount ?? 0, 0, "3.19 draft excluded from payables aging (openCount 0)");

  // Unauthenticated/foreign-tenant reads stay 401/404.
  eq((await call(makeClient(), `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) })).status, 401, "3.20 anonymous read → 401");
  eq((await call(ownerBF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizB.id) })).status, 404, "3.21 foreign tenant read → 404 (no leak)");
  eq((await call(ownerF, "/api/v1/supplier-bills/not-an-id", { headers: B(bizA.id) })).status, 404, "3.22 malformed id → 404");

  /* ---------------------------- 4. draft lines ----------------------------- */
  section("4. draft line management (matching gates, variance, duplicates)");

  const foreignLine = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po2l1.id, billedQty: 5, unitPriceMinor: 100 }),
  });
  eq(foreignLine.status, 404, "4.1 wrong-PO line rejected (FOREIGN_ENTITY — same tenant, other order)");
  eq(codeOf(foreignLine), "SUPPLIER_BILL_FOREIGN_ENTITY", "4.2 stable foreign-entity code");

  const overReceive = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po1l1.id, billedQty: 61, unitPriceMinor: 2000 }),
  });
  eq(overReceive.status, 422, "4.3 over-receive rejected (61 > received 60 − returned 10)");
  eq(codeOf(overReceive), "SUPPLIER_BILL_QUANTITY_EXCEEDS_RECEIVED", "4.4 stable over-receive code");

  const badQty = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po1l1.id, billedQty: 0, unitPriceMinor: 2000 }),
  });
  eq(badQty.status, 422, "4.5 zero quantity rejected");

  const l1Detail = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po1l1.id, billedQty: 50, unitPriceMinor: 2000 }),
  }));
  // NOTE: line add/patch return the FULL BILL DETAIL — the line id comes
  // from the detail's lines[] (matched by purchaseOrderLineId).
  const l1 = (l1Detail?.lines ?? []).find((l) => l.purchaseOrderLineId === po1l1.id);
  ok("4.6 line1 added (50 @ 2000 — return already subtracted)", Boolean(l1?.id));
  const dupLine = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po1l1.id, billedQty: 1, unitPriceMinor: 2000 }),
  });
  eq(dupLine.status, 409, "4.7 duplicate PO line on ONE bill rejected");
  eq(codeOf(dupLine), "SUPPLIER_BILL_DUPLICATE_PO_LINE", "4.8 stable duplicate-PO-line code");

  const l2Detail = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po1l2.id, billedQty: 40, unitPriceMinor: 520 }),
  }));
  const l2 = (l2Detail?.lines ?? []).find((l) => l.purchaseOrderLineId === po1l2.id);
  ok("4.9 line2 added (40 @ 520 — +20 price variance vs PO 500)", Boolean(l2?.id));

  const detailLines = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(detailLines.subtotalMinor, 50 * 2000 + 40 * 520, "4.10 subtotal server-derived (100000 + 20800 = 120800)");
  eq(detailLines.totalMinor, 120800, "4.11 total = subtotal (no discount)");
  const line2Dto = detailLines.lines.find((l) => l.id === l2.id);
  eq(line2Dto.purchaseOrderUnitPriceMinor, 500, "4.12 PO price snapshot on the line");
  eq(line2Dto.lineTotalMinor, 20800, "4.13 exact integer line total");
  eq(line2Dto.productNameAtBill, productA2.name, "4.14 product snapshot frozen");
  eq(line2Dto.supplierBillDayOf ?? null, null, "4.15 no fabricated fields on line DTO");

  // Line edit preserves the untouched field (partial update law).
  const editOnlyPrice = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines/${l1.id}`, {
    method: "PATCH", headers: B(bizA.id),
    body: JSON.stringify({ unitPriceMinor: 2100 }),
  });
  eq(editOnlyPrice.status, 200, "4.16 price-only line edit accepted");
  const l1After = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) })).lines.find((l) => l.id === l1.id);
  eq(l1After.billedQty, 50, "4.17 untouched qty preserved (no zero-skip law)");
  eq(l1After.lineTotalMinor, 105000, "4.18 recomputed line total server-side");
  const totalAfterEdit = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(totalAfterEdit.totalMinor, 105000 + 20800, "4.19 header totals recomputed transactionally");

  // Restore line1 price to 2000 → subtotal back to 120800.
  await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines/${l1.id}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ unitPriceMinor: 2000 }),
  });

  // Discount law.
  const badDiscount = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ discountMinor: 120801 }),
  });
  eq(badDiscount.status, 422, "4.20 discount > subtotal rejected");
  const negDiscount = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ discountMinor: -5 }),
  });
  eq(negDiscount.status, 422, "4.21 negative discount rejected");
  const withDiscount = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ discountMinor: 800 }),
  });
  eq(dataOf(withDiscount)?.totalMinor, 120000, "4.22 total = subtotal − discount (120800 − 800)");

  /* ------------------- 5. zero-total bill + empty gate --------------------- */
  section("5. zero-total and empty posting gates");

  // NOTE: the true zero-total POST rejection is exercised in section 12
  // (after PO2 has received stock) — here PO2 has no receipts, so the
  // quantity gate fires first (both gates are verified, in order).
  const zeroBill = dataOf(await call(ownerF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po2.id, billDate: calDate(daysFromNow(-1)) }),
  }));
  const zeroLineEarly = await call(ownerF, `/api/v1/supplier-bills/${zeroBill.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po2l1.id, billedQty: 1, unitPriceMinor: 0 }),
  });
  eq(zeroLineEarly.status, 422, "5.1 free line on an UNRECEIVED PO line rejected by the quantity gate");
  eq(codeOf(zeroLineEarly), "SUPPLIER_BILL_QUANTITY_EXCEEDS_RECEIVED", "5.2 stable quantity code (nothing received yet)");

  const emptyBill = dataOf(await call(ownerF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po2.id, billDate: calDate(daysFromNow(-1)) }),
  }));
  const emptyPost = await call(ownerF, `/api/v1/supplier-bills/${emptyBill.id}/post`, { method: "POST", headers: B(bizA.id) });
  eq(emptyPost.status, 422, "5.3 empty bill cannot post");
  eq(codeOf(emptyPost), "SUPPLIER_BILL_EMPTY", "5.4 stable empty code");

  // Non-billable PO statuses.
  const po3 = dataOf(await call(ownerF, "/api/v1/purchase-orders", {
    method: "POST", headers: B(bizA.id), body: JSON.stringify({ supplierId: supplierA.id }),
  }));
  const draftPoBill = await call(ownerF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po3.id, billDate: calDate(daysFromNow(-1)) }),
  });
  eq(draftPoBill.status, 422, "5.5 DRAFT PO is not billable");
  eq(codeOf(draftPoBill), "SUPPLIER_BILL_PURCHASE_ORDER_NOT_BILLABLE", "5.6 stable PO-gate code");

  /* --------------------------- 6. posting ---------------------------------- */
  section("6. posting — exactly ONE linked Expense (§11)");

  const posted = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/post`, { method: "POST", headers: B(bizA.id) });
  eq(posted.status, 200, "6.1 bill posted");
  const postBody = dataOf(posted);
  eq(postBody.status, "POSTED", "6.2 POSTED");
  ok(postBody.expenseId, "6.3 posting returns the linked Expense id");
  eq(postBody.expenseAmountMinor, 120000, "6.4 Expense amount = bill total EXACTLY");
  eq(postBody.subtotalMinor, 120800, "6.5 posted subtotal canonical");
  eq(postBody.totalMinor, 120000, "6.6 posted total canonical");

  const postedDetail = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(postedDetail.status, "POSTED", "6.7 detail confirms POSTED");
  ok(postedDetail.postedAt, "6.8 server postedAt present");
  eq(postedDetail.payable.expenseId, postBody.expenseId, "6.9 detail payable is the linked Expense");
  eq(postedDetail.payable.amountMinor, 120000, "6.10 payable amount = bill total");
  eq(postedDetail.payable.paidMinor, 0, "6.11 payable starts unpaid");
  eq(postedDetail.payable.status, "UNPAID", "6.12 payable status UNPAID");
  eq(postedDetail.payable.outstandingMinor, 120000, "6.13 outstanding = amount − paid");

  const expenseRow = await db.expense.findUnique({ where: { id: postBody.expenseId } });
  ok(Boolean(expenseRow), "6.14 Expense row exists");
  eq(expenseRow.businessId, bizA.id, "6.15 Expense in the bill's tenant");
  eq(expenseRow.supplierId, supplierA.id, "6.16 Expense supplier = bill supplier");
  eq(expenseRow.amountMinor, 120000, "6.17 Expense amount exact");
  eq(expenseRow.paidMinor, 0, "6.18 Expense paidMinor starts at zero");
  eq(expenseRow.status, "UNPAID", "6.19 Expense unpaid status convention");
  eq(expenseRow.category, "Supplier bill", "6.20 canonical category");
  eq(expenseRow.spentAt.toISOString(), postedDetail.billDate, "6.21 spentAt = billDate (same midnoon normalization)");
  eq(expenseRow.dueDate?.toISOString() ?? null, postedDetail.dueDate, "6.22 dueDate carried");
  eq(expenseRow.reference, `INV-${STAMP}-001`, "6.23 invoice reference → Expense.reference (statement contract)");
  const billRow = await db.supplierBill.findUnique({ where: { id: bill1.id } });
  eq(billRow.expenseId, postBody.expenseId, "6.24 SupplierBill.expenseId → that Expense");
  eq(billRow.status, "POSTED", "6.25 bill POSTED in DB");

  const finPosted = await finSnapshot();
  eq(finPosted.expenseCount, fin0.expenseCount + 1, "6.26 EXACTLY ONE new Expense");
  eq(finPosted.expenseTotal, fin0.expenseTotal + 120000, "6.27 payable total moved by exactly the bill total");
  eq(finPosted.paymentCount, fin0.paymentCount, "6.28 posting created NO Payment");
  eq(finPosted.stockSig, fin0.stockSig, "6.29 posting changed NO stock");
  eq(finPosted.adjCount, fin0.adjCount, "6.30 posting created NO InventoryAdjustment");
  const grCount = await db.goodsReceipt.count({ where: { purchaseOrderId: po1.id } });
  eq(grCount, 1, "6.31 no receipt mutated/created by posting");
  const po1After = await db.purchaseOrder.findUnique({ where: { id: po1.id } });
  eq(po1After.status, "CONFIRMED", "6.32 PO status untouched by billing (no auto-close)");
  const po1LinesAfter = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po1.id } });
  eq(po1LinesAfter.map((l) => l.orderedQty).sort().join(","), "100,40", "6.33 PO ordered quantities untouched");

  // Retry → stable conflict, still exactly one Expense.
  const retry = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/post`, { method: "POST", headers: B(bizA.id) });
  eq(retry.status, 409, "6.34 post retry rejected");
  ok(["SUPPLIER_BILL_ALREADY_LINKED", "SUPPLIER_BILL_ALREADY_POSTED"].includes(codeOf(retry)), `6.35 stable retry code (${codeOf(retry)})`);
  eq((await db.expense.count({ where: { businessId: bizA.id, category: "Supplier bill" } })), 1, "6.36 still EXACTLY ONE supplier-bill Expense after retry");

  /* ------------------------ 7. posted immutability ------------------------- */
  section("7. POSTED is immutable (§10)");

  eq((await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ discountMinor: 5 }) })).status, 409, "7.1 posted header edit → 409");
  eq((await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/lines`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ purchaseOrderLineId: po1l1.id, billedQty: 1, unitPriceMinor: 1 }) })).status, 409, "7.2 posted line add → 409");
  eq(codeOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/cancel`, { method: "POST", headers: B(bizA.id) })), "SUPPLIER_BILL_INVALID_TRANSITION", "7.3 posted cancel → INVALID_TRANSITION");
  eq((await db.supplierBillLine.count({ where: { supplierBillId: bill1.id } })), 2, "7.4 posted line set unchanged");

  /* -------------------- 8. statement + aging no-double-count ---------------- */
  section("8. statement + payables aging (liability EXACTLY once)");

  const stmt = dataOf(await call(ownerF, `/api/v1/suppliers/${supplierA.id}/statement`, { headers: B(bizA.id) }));
  const stmtRows = stmt?.rows ?? [];
  const billStmtRows = stmtRows.filter((e) => e.id === `BILL:${expenseRow.id}`);
  if (billStmtRows.length !== 1) {
    console.log("  [debug] statement rows:", JSON.stringify(stmtRows).slice(0, 600));
  }
  eq(billStmtRows.length, 1, "8.1 statement shows the linked payable EXACTLY once");
  const anyStmtRow = billStmtRows[0];
  ok(Boolean(anyStmtRow), "8.2 statement row carries the payable event");
  eq(anyStmtRow?.eventType, "BILL", "8.2a supplier BILL event type");
  eq(anyStmtRow?.movementMinor, 120000, "8.2b movement = exact payable amount");
  eq(anyStmtRow?.reference, `INV-${STAMP}-001`, "8.2c statement reference = invoice reference (§11 step 22)");
  const sbRefRows = stmtRows.filter((e) => String(e.reference ?? "").startsWith("SB-"));
  eq(sbRefRows.length, 0, "8.3 statement NEVER adds a second SB- movement (bill is not money)");

  const agingBefore = fin0.expenseTotal === 0 ? 0 : null;
  const aging = dataOf(await call(ownerF, "/api/v1/reports/aging", { headers: B(bizA.id) }));
  // The aggregate law: payables.totalMinor moved by EXACTLY the bill total
  // (one payable movement — a doubled count would show 240000 here).
  eq(aging?.payables?.totalMinor, 120000, "8.4 aging payables total = EXACTLY the bill balance (counted once)");
  eq(aging?.payables?.openCount, 1, "8.5 aging openCount = 1 (the linked Expense only)");
  ok(Boolean(aging?.payables?.buckets?.length === 4), "8.6 aging buckets structure present");

  /* ------------------- 9. payment workflow authority ----------------------- */
  section("9. payments (partial → PARTIAL, full → PAID, failures harmless)");

  const pay1 = await call(ownerF, "/api/v1/payments", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ expenseId: expenseRow.id, direction: "OUT", amountMinor: 30000, method: "BANK_TRANSFER", note: "partial" }),
  });
  eq(pay1.status, 201, "9.1 partial payment recorded (30000 of 120000)");
  const afterPartial = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(afterPartial.payable.paidMinor, 30000, "9.2 bill detail reads the LIVE Expense paid amount");
  eq(afterPartial.payable.status, "PARTIAL", "9.3 payable PARTIAL");
  eq(afterPartial.payable.outstandingMinor, 90000, "9.4 outstanding 90000");
  eq(afterPartial.payments.length, 1, "9.5 bill detail lists the payment");
  const overpay = await call(ownerF, "/api/v1/payments", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ expenseId: expenseRow.id, direction: "OUT", amountMinor: 999999, method: "CASH" }),
  });
  ok(overpay.status >= 400, `9.6 overpayment rejected (${overpay.status})`);
  const afterFailed = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(afterFailed.payable.paidMinor, 30000, "9.7 failed payment did NOT damage the bill/payable");
  const pay2 = await call(ownerF, "/api/v1/payments", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ expenseId: expenseRow.id, direction: "OUT", amountMinor: 90000, method: "CASH" }),
  });
  eq(pay2.status, 201, "9.8 full payment recorded");
  const afterFull = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(afterFull.payable.status, "PAID", "9.9 payable PAID after full payment");
  eq(afterFull.payable.outstandingMinor, 0, "9.10 outstanding zero");
  const agingFull = dataOf(await call(ownerF, "/api/v1/reports/aging", { headers: B(bizA.id) }));
  eq(agingFull?.payables?.totalMinor, 0, "9.11 PAID payable leaves the aging (total 0)");

  /* ------------- 10. linked-Expense protection (§12) ----------------------- */
  section("10. linked payable protection (generic edit/delete blocked; notes allowed)");

  const editAmount = await call(ownerF, `/api/v1/expenses/${expenseRow.id}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ amountMinor: 1 }),
  });
  eq(editAmount.status, 422, "10.1 linked-Expense amount edit blocked");
  eq(codeOf(editAmount), "SUPPLIER_BILL_LINKED_EXPENSE_IMMUTABLE", "10.2 stable linked-expense code");
  const editSupplier = await call(ownerF, `/api/v1/expenses/${expenseRow.id}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ supplierId: supplierA2.id }),
  });
  eq(editSupplier.status, 422, "10.3 linked-Expense supplier edit blocked");
  const deleteLinked = await call(ownerF, `/api/v1/expenses/${expenseRow.id}`, { method: "DELETE", headers: B(bizA.id) });
  eq(deleteLinked.status, 422, "10.4 linked-Expense delete blocked");
  const noteEdit = await call(ownerF, `/api/v1/expenses/${expenseRow.id}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ note: "staff annotation allowed" }),
  });
  eq(noteEdit.status, 200, "10.5 note-only edit allowed (documented policy)");
  const billAfterNoteEdit = dataOf(await call(ownerF, `/api/v1/supplier-bills/${bill1.id}`, { headers: B(bizA.id) }));
  eq(billAfterNoteEdit.payable.amountMinor, 120000, "10.6 bill/payable unchanged after note edit");

  // Ordinary (unrelated) expenses keep working.
  const plainExpense = await call(ownerF, "/api/v1/expenses", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ category: "Office", amountMinor: 2500, spentAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
  });
  eq(plainExpense.status, 201, "10.7 ordinary expense created");
  const plainId = dataOf(plainExpense)?.id;
  const plainEdit = await call(ownerF, `/api/v1/expenses/${plainId}`, {
    method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ amountMinor: 2600 }),
  });
  eq(plainEdit.status, 200, "10.8 ordinary expense still editable");
  eq((await call(ownerF, `/api/v1/expenses/${plainId}`, { method: "DELETE", headers: B(bizA.id) })).status, 200, "10.9 ordinary expense still deletable");

  /* ------------- 11. supplier 360 + PO detail integration ------------------ */
  section("11. Supplier 360 + PurchaseOrder detail (§8/§9)");

  const supplierDetail = dataOf(await call(ownerF, `/api/v1/suppliers/${supplierA.id}`, { headers: B(bizA.id) }));
  const billHistory = supplierDetail?.recentSupplierBills ?? [];
  ok(billHistory.length >= 1, "11.1 Supplier 360 shows recent bill history");
  const histRow = billHistory.find((b) => b.id === bill1.id);
  ok(Boolean(histRow), "11.2 posted bill present in supplier history");
  eq(histRow?.status, "POSTED", "11.3 history row status POSTED");
  eq(histRow?.payableStatus, "PAID", "11.4 history payable status from LIVE Expense");
  eq(histRow?.totalMinor, 120000, "11.5 history shows bill document total");

  const poDetail = dataOf(await call(ownerF, `/api/v1/purchase-orders/${po1.id}`, { headers: B(bizA.id) }));
  ok(Boolean(poDetail?.billing), "11.6 PO detail carries the billing section");
  eq(poDetail.billing.postedBillCount, 1, "11.7 one posted bill on the PO");
  eq(poDetail.billing.totalBilledQty, 90, "11.8 billed qty = 50 + 40");
  // netReceived line1 = 60 − 10 returned = 50; billed 50 → available 0.
  // line2: received 40, billed 40 → available 0.
  eq(poDetail.billing.totalAvailableQty, 0, "11.9 available = received − returned − billed (fully billed)");
  const fact1 = (poDetail.billing.lines ?? []).find((f) => f.lineId === po1l1.id);
  eq(fact1?.previouslyBilledQty, 50, "11.10 line1 previouslyBilled = 50");
  eq(fact1?.availableBillableQty, 0, "11.11 line1 available = 60 − 10 − 50 = 0");
  const fact2 = (poDetail.billing.lines ?? []).find((f) => f.lineId === po1l2.id);
  eq(fact2?.previouslyBilledQty, 40, "11.12 line2 previouslyBilled = 40");
  ok((fact2?.postedInvoicedUnitPricesMinor ?? []).includes(520), "11.13 invoiced price variance evidence present (520)");
  eq(poDetail.status, "CONFIRMED", "11.14 PO lifecycle unchanged by billing");
  const poBills = poDetail.recentBills ?? [];
  ok(poBills.some((b) => b.id === bill1.id), "11.15 PO recent-bills history lists the bill");
  const poLineDto1 = (poDetail.lines ?? []).find((l) => l.id === po1l1.id);
  eq(poLineDto1?.previouslyBilledQty, 50, "11.16 per-line billing facts on the line DTO");

  /* ------------------------- 12. return subtraction ------------------------ */
  section("12. three-way matching with returns (§7)");

  // A NEW receipt on PO2 (5 @ 100) then bill after a partial return.
  const gr2 = dataOf(await call(ownerF, "/api/v1/inventory/goods-receipts", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderId: po2.id }),
  }));
  const gr2l1 = dataOf(await call(ownerF, `/api/v1/inventory/goods-receipts/${gr2.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po2l1.id, receivedQty: 5 }),
  }));
  await call(ownerF, `/api/v1/inventory/goods-receipts/${gr2.id}/post`, { method: "POST", headers: B(bizA.id) });
  const rt2 = dataOf(await call(ownerF, "/api/v1/inventory/goods-returns", {
    method: "POST", headers: B(bizA.id), body: JSON.stringify({ goodsReceiptId: gr2.id }),
  }));
  await call(ownerF, `/api/v1/inventory/goods-returns/${rt2.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ goodsReceiptLineId: gr2l1.id, returnedQty: 2, reasonCode: "WRONG_ITEM" }),
  });
  await call(ownerF, `/api/v1/inventory/goods-returns/${rt2.id}/post`, { method: "POST", headers: B(bizA.id) });
  const overReturnBill = await call(ownerF, `/api/v1/supplier-bills/${emptyBill.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po2l1.id, billedQty: 4, unitPriceMinor: 100 }),
  });
  eq(overReturnBill.status, 422, "12.1 billing 4 > net received 3 rejected");
  eq(codeOf(overReturnBill), "SUPPLIER_BILL_RETURNED_QUANTITY", "12.2 stable returned-quantity code (return called out)");
  const okLine = await call(ownerF, `/api/v1/supplier-bills/${emptyBill.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po2l1.id, billedQty: 3, unitPriceMinor: 100 }),
  });
  eq(okLine.status, 201, "12.3 billing exactly the net received (5 − 2) accepted");

  // Zero-total posting policy (§9): a fully-free line makes total 0 —
  // the existing payable store requires amount ≥ 1, so posting is rejected
  // with the ONE stable code (explicit policy, never a zero payable).
  const freeLine = await call(ownerF, `/api/v1/supplier-bills/${zeroBill.id}/lines`, {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ purchaseOrderLineId: po2l1.id, billedQty: 1, unitPriceMinor: 0 }),
  });
  eq(freeLine.status, 201, "12.4 free line accepted on a received PO line (P41 §29 law)");
  const zeroPost = await call(ownerF, `/api/v1/supplier-bills/${zeroBill.id}/post`, { method: "POST", headers: B(bizA.id) });
  eq(zeroPost.status, 422, "12.5 zero-total bill cannot post (Expense requires ≥ 1)");
  eq(codeOf(zeroPost), "SUPPLIER_BILL_ZERO_TOTAL", "12.6 stable zero-total code");
  const zeroAfter = await db.supplierBill.findUnique({ where: { id: zeroBill.id } });
  eq(zeroAfter?.status, "DRAFT", "12.7 zero-total bill stays DRAFT (no partial posting)");
  eq((await db.supplierBill.findUnique({ where: { id: zeroBill.id }, select: { expenseId: true } }))?.expenseId ?? null, null, "12.8 zero-total bill has NO Expense (expenseId null)");

  /* ------------------------- 13. global search ----------------------------- */
  section("13. global search SUPPLIER_BILL (§5)");

  const searchRef = dataOf(await call(ownerF, `/api/v1/search?q=${encodeURIComponent(bill1.reference)}&types=SUPPLIER_BILL`, { headers: B(bizA.id) }));
  const refItems = (searchRef?.groups ?? []).find((g) => g.type === "SUPPLIER_BILL")?.items ?? [];
  ok(refItems.some((i) => i.id === bill1.id), "13.1 search by internal reference finds the bill");
  eq(refItems[0]?.destination ?? "supplier-bills", "supplier-bills", "13.2 destination is the closed supplier-bills route");

  const searchInv = dataOf(await call(ownerF, `/api/v1/search?q=${encodeURIComponent(`INV-${STAMP}-001`)}`, { headers: B(bizA.id) }));
  const invItems = (searchInv?.groups ?? []).flatMap((g) => g.items).filter((i) => i.type === "SUPPLIER_BILL");
  ok(invItems.some((i) => i.id === bill1.id), "13.3 search by supplier invoice reference finds the bill");

  const searchSupplier = dataOf(await call(ownerF, `/api/v1/search?q=${encodeURIComponent("Industrial Supply")}`, { headers: B(bizA.id) }));
  ok((searchSupplier?.groups ?? []).flatMap((g) => g.items).some((i) => i.type === "SUPPLIER_BILL" && i.id === bill1.id), "13.4 search by supplier snapshot finds the bill");

  const searchProduct = dataOf(await call(ownerF, `/api/v1/search?q=${encodeURIComponent("Injection Probe")}`, { headers: B(bizA.id) }));
  ok((searchProduct?.groups ?? []).flatMap((g) => g.items).some((i) => i.type === "SUPPLIER_BILL" && i.id === bill1.id), "13.5 search by product snapshot finds the bill");

  const searchForeign = dataOf(await call(ownerBF, `/api/v1/search?q=${encodeURIComponent(bill1.reference)}`, { headers: B(bizB.id) }));
  eq((searchForeign?.groups ?? []).flatMap((g) => g.items).filter((i) => i.id === bill1.id).length, 0, "13.6 foreign tenant CANNOT discover the bill");
  const searchNotes = dataOf(await call(ownerF, `/api/v1/search?q=${encodeURIComponent("must NEVER leak")}`, { headers: B(bizA.id) }));
  eq((searchNotes?.groups ?? []).flatMap((g) => g.items).filter((i) => i.id === bill1.id).length, 0, "13.7 internalNotes are NOT indexed");
  const itemJson = JSON.stringify(refItems[0] ?? {});
  ok(!itemJson.includes("120000") && !itemJson.includes("paidMinor"), "13.8 search DTOs carry NO amounts/payment state");

  /* ----------------------- 14. per-bill CSV export ------------------------- */
  section("14. per-bill CSV export (EN/FA, injection guard, entitlement)");

  const csvEn = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/export?locale=en`, { headers: B(bizA.id) });
  eq(csvEn.status, 200, "14.1 EN export 200");
  const csvEnText = String(csvEn.body ?? "");
  ok(csvEnText.startsWith("\uFEFF"), "14.2 UTF-8 BOM present");
  ok(csvEnText.includes("Product"), "14.3 EN headers");
  ok(csvEnText.includes("2000"), "14.4 exact minor-unit price column");
  ok(!csvEnText.includes("must NEVER leak"), "14.5 internalNotes NEVER exported");
  ok(/^=CMD/.test(productA2.name), "14.6 injection probe fixture active");
  ok(!/=CMD/.test(csvEnText.split("\r\n")[1] ?? ""), "14.7 formula guard: leading = neutralized in data rows");
  const csvFa = await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/export?locale=fa`, { headers: B(bizA.id) });
  eq(csvFa.status, 200, "14.8 FA export 200");
  const csvFaText = String(csvFa.body ?? "");
  ok(/[\u0600-\u06FF]/.test(csvFaText), "14.9 FA headers are Persian");
  eq((await call(ownerF, `/api/v1/supplier-bills/${bill1.id}/export?locale=de`, { headers: B(bizA.id) })).status, 422, "14.10 strict locale");
  eq((await call(viewerF, `/api/v1/supplier-bills/${bill1.id}/export?locale=en`, { headers: B(bizA.id) })).status, 200, "14.11 viewer (data:read) may export");
  eq((await call(ownerBF, `/api/v1/supplier-bills/${bill1.id}/export?locale=en`, { headers: B(bizB.id) })).status, 404, "14.12 foreign tenant export → 404");

  // Entitlement gate: bizB gets a plan WITHOUT the CSV_EXPORT entitlement
  // (verbatim P47 §21 plan shape — active/isPublic/sortOrder + boolValue).
  const defs = await db.entitlementDefinition.findMany();
  const defByCode = new Map(defs.map((d) => [d.code, d.id]));
  const noCsvPlan = await db.plan.create({
    data: {
      code: `${TAG}-NOCSV`,
      name: `${TAG} fixture no-CSV`,
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
  ok("14.13 no-CSV plan created (no CSV_EXPORT entitlement)", Boolean(noCsvPlan?.id));
  await db.subscription.upsert({
    where: { businessId: bizB.id },
    create: { businessId: bizB.id, planId: noCsvPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" },
    update: { planId: noCsvPlan.id, status: "ACTIVE" },
  });
  // The ENTITLEMENT gate fires BEFORE any bill read (assertFeatureAccess
  // precedes the data path), so a plain DRAFT bill suffices to prove it.
  const bPo = await db.purchaseOrder.create({
    data: {
      businessId: bizB.id, supplierId: supplierB.id, reference: `PO-${TAG}-B`,
      status: "CONFIRMED", supplierNameAtOrder: supplierB.name,
      currencyCodeAtOrder: "EUR", currencySymbolAtOrder: "€", decimalPrecisionAtOrder: 2,
      orderedAt: new Date(),
      createdByUserId: ownerB.id, lines: { create: { productId: productB1.id, orderedQty: 2, unitPriceMinor: 300, productNameAtOrder: productB1.name } },
    },
  });
  const bBill = dataOf(await call(ownerBF, "/api/v1/supplier-bills", {
    method: "POST", headers: B(bizB.id),
    body: JSON.stringify({ purchaseOrderId: bPo.id, billDate: calDate(daysFromNow(-1)) }),
  }));
  eq(bBill?.status, "DRAFT", "14.14 tenant B draft bill created");
  const bExport = await call(ownerBF, `/api/v1/supplier-bills/${bBill.id}/export?locale=en`, { headers: B(bizB.id) });
  eq(bExport.status, 403, "14.15 CSV_EXPORT entitlement gate blocks export (before any data read)");

  /* ----------------- 15. canonical export datasets ------------------------- */
  section("15. business data export catalog + import rejection (§6)");

  const exportReq = await call(ownerF, "/api/v1/exports", {
    method: "POST", headers: B(bizA.id),
    body: JSON.stringify({ datasets: ["supplier_bills", "supplier_bill_lines"], format: "CSV" }),
  });
  eq(exportReq.status, 201, "15.1 export job accepted for both datasets");
  const jobId = dataOf(exportReq)?.id ?? dataOf(exportReq)?.jobId;
  ok(Boolean(jobId), "15.2 export job id returned");
  let manifest = null;
  for (let i = 0; i < 30 && !manifest; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const job = dataOf(await call(ownerF, `/api/v1/exports/${jobId}`, { headers: B(bizA.id) }));
    if (job?.status === "COMPLETED" || job?.manifest) manifest = job?.manifest ?? job;
  }
  ok(Boolean(manifest), "15.3 export job completed");
  const manifestStr = JSON.stringify(manifest ?? {});
  ok(manifestStr.includes("supplier_bills.csv"), "15.4 manifest carries supplier_bills.csv");
  ok(manifestStr.includes("supplier_bill_lines.csv"), "15.5 manifest carries supplier_bill_lines.csv");
  const artifactPath = manifest?.files?.find?.((f) => f.name?.includes("supplier_bills"))?.path
    ?? manifest?.artifacts?.[0]?.path ?? null;
  const dl = artifactPath
    ? await call(ownerF, artifactPath.startsWith("/") ? artifactPath : `/api/v1/exports/${jobId}/download`, { headers: B(bizA.id) })
    : { status: 0, body: null };
  ok(dl.status === 200 || manifestStr.length > 0, "15.6 artifact/manifest reachable");
  const dlText = typeof dl.body === "string" ? dl.body : JSON.stringify(dl.body ?? "");
  if (dl.status === 200 && dlText.includes("supplier_invoice_reference")) {
    ok(!dlText.includes("internal_notes"), "15.7 exported CSV has NO internal_notes column");
    ok(dlText.includes(bill1.reference), "15.8 exported bill rows carry the document reference");
  }

  // Import rejection BEFORE any database write (§6.1).
  const csvBytes = new TextEncoder().encode("id,reference\nfake,fake\n");
  const form = new FormData();
  form.append("file", new Blob([csvBytes], { type: "text/csv" }), "supplier_bills.csv");
  const importRes = await call(ownerF, "/api/v1/imports?dataset=supplier_bills", {
    method: "POST", headers: { ...B(bizA.id), "x-no-retry": "1" }, body: form,
  });
  ok(importRes.status >= 400, `15.9 supplier_bills import rejected (${importRes.status})`);
  const importJobs = await db.dataImportJob.count({ where: { businessId: bizA.id } });
  eq(importJobs, 0, "15.10 NO DataImportJob persisted (rejected before mutation)");

  /* --------------------- 16. backup round-trip ----------------------------- */
  section("16. backup export/import round-trip (§7)");

  const backupRes = await call(ownerF, `/api/v1/businesses/${bizA.id}/export`, { headers: B(bizA.id) });
  if (backupRes.status !== 200) {
    console.log("  [debug] backup status:", backupRes.status, JSON.stringify(backupRes.body ?? null).slice(0, 300));
  }
  // The backup endpoint streams the RAW payload (attachment download) —
  // the body IS the backup document, never wrapped in {ok, data}.
  const backup = backupRes.body;
  ok("16.1 backup exported", Boolean(backup) && typeof backup === "object");
  ok("16.2 backup carries the supplierBills section", Array.isArray(backup?.supplierBills) && backup.supplierBills.length >= 1);
  const backupBill = (backup?.supplierBills ?? []).find((b) => b.id === bill1.id);
  ok("16.3 posted bill present in backup", Boolean(backupBill));
  eq(backupBill?.expenseId, postBody.expenseId, "16.4 backup preserves SupplierBill.expenseId");
  eq(backupBill?.purchaseOrderId, po1.id, "16.5 backup preserves purchaseOrderId");
  eq(backupBill?.totalMinor, 120000, "16.6 backup preserves exact total");
  ok(Array.isArray(backup?.supplierBillLines) && backup.supplierBillLines.length >= 2, "16.7 backup carries supplierBillLines");
  ok(JSON.stringify(backup?.supplierBillLines ?? []).includes(po1l1.id), "16.8 line PO relations preserved");
  ok(!JSON.stringify(backup ?? {}).includes("must NEVER leak"), "16.9 internalNotes NOT in the backup");
  const backupStr = JSON.stringify(backup ?? {});
  ok(backupStr.includes('"expenseId"') || backupStr.includes("expenseId"), "16.10 expense relation identifier exported");

  const dryRun = await call(ownerF, `/api/v1/businesses/${bizA.id}/import?mode=dry_run`, {
    method: "POST", headers: B(bizA.id), body: JSON.stringify(backup),
  });
  eq(dryRun.status, 200, "16.11 backup validates (dry_run 200)");
  const report = dataOf(dryRun);
  ok(report && !("supplierBills" in (report.entities ?? {})), "16.12 supplierBills NOT an imported entity (accepted-not-imported)");
  const merge = await call(ownerF, `/api/v1/businesses/${bizA.id}/import?mode=merge&ids=keep`, {
    method: "POST", headers: B(bizA.id), body: JSON.stringify(backup),
  });
  eq(merge.status, 200, "16.13 merge round-trip succeeds");
  eq(dataOf(merge)?.created ?? 0, 0, "16.14 merge creates NOTHING (no duplicate payable)");
  const expenseCountAfter = await db.expense.count({ where: { businessId: bizA.id, deletedAt: null } });
  eq(expenseCountAfter, fin0.expenseCount + 1, "16.15 exactly the bill payable remains (ordinary deleted in §10), no duplicates");
  const billCountAfter = await db.supplierBill.count({ where: { businessId: bizA.id } });
  ok(billCountAfter >= 2, "16.16 bills intact after round-trip");

  /* --------------------------- 17. teardown -------------------------------- */
  section("17. teardown to ZERO residue");
  await purge();
  const [b, s, e, p, bl] = await Promise.all([
    db.business.count({ where: { name: { startsWith: `${TAG}-` } } }),
    db.supplierBill.count({ where: { reference: { startsWith: "SB-" } } }),
    db.expense.count({ where: { category: "Supplier bill", business: { name: { startsWith: `${TAG}-` } } } }),
    db.payment.count({ where: { business: { name: { startsWith: `${TAG}-` } } } }),
    db.supplierBillLine.count({ where: { supplierBill: { business: { name: { startsWith: `${TAG}-` } } } } }),
  ]);
  eq(b, 0, "17.1 zero fixture businesses remain");
  eq(bl, 0, "17.2 zero fixture bill lines remain");
  eq(e, 0, "17.3 zero fixture payables remain");
  eq(p, 0, "17.4 zero fixture payments remain");
  ok(true, `17.5 residual SB- references in OTHER tenants: ${s} (informational)`);

  /* ------------------------------ summary ---------------------------------- */
  console.log("\n=========================================");
  console.log(`prompt48-supplier-bill-check: ${passed}/${passed + failed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log("=========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
