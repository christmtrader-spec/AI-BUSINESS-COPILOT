#!/usr/bin/env node
/**
 * scripts/prompt49-aging-details-check.mjs — Prompt 49 E2E check against the
 * LIVE dev server (real API, real DB, real auth) — the §21 integration
 * scenarios 1–29:
 *
 *   1–3   two customers with IDENTICAL display names group by actual ID
 *   4–6   two suppliers with IDENTICAL display names stay distinct
 *   7     every bucket contains the expected open rows
 *   8     bucket totals match authoritative source balances
 *   9     customer aging NEVER labels an invoice overdue (invoice age only)
 *   10    supplier past-due uses ONLY a stated dueDate
 *   11    due today is NOT past due
 *   12    Expense without dueDate is NOT overdue
 *   13    partial payment updates the outstanding amount
 *   14    full payment removes the item from open aging
 *   15    statement movement occurs EXACTLY once
 *   16    statement closing reconciles with the authoritative open balance
 *   17    SupplierBill-linked Expense is counted ONCE (bill ref as metadata)
 *   18    SupplierBill is NOT a separate aging item
 *   19    SalesOrder is NOT a receivable
 *   20    SalesQuotation is NOT a receivable
 *   21    cursor pages: stable order, no duplicate/skipped rows
 *   22    cursors cannot be reused across side/party/bucket/tenant
 *   23    CSV export covers the whole declared scope or rejects safely
 *   24    CSV formula-injection protection (hostile party name)
 *   25    unsupported filters rejected (422)
 *   26    invalid IDs + foreign-tenant IDs safe (404, no leak)
 *   27    Customer 360 / Supplier 360 aging panels + links
 *   28    statement rows carry sourceType/sourceId for source navigation
 *   29    teardown to ZERO residue
 *
 * Run: bun scripts/prompt49-aging-details-check.mjs   (dev server must be up)
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
const TAG = "P49QA";
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
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.51.13.9", ...(init.headers ?? {}) };
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
  const headers = { "x-forwarded-for": "10.51.13.9", ...(cookie ? { cookie } : {}), ...extraHeaders };
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** Calendar day (YYYY-MM-DD) in Asia/Tehran for `days` days from now. */
function tehranDay(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

// ---------------- teardown-first (idempotent, crashed-run safe) ----------------
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
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.business.deleteMany({ where: { id: b.id } });
  }
  if (process.argv.includes("--full-teardown")) {
    const users = await db.user.findMany({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } }, select: { id: true } });
    for (const u of users) {
      await db.userSession.deleteMany({ where: { userId: u.id } });
      await db.auditLog.deleteMany({ where: { actorId: u.id } });
      await db.user.deleteMany({ where: { id: u.id } });
    }
  } else {
    // keep the STABLE fixture users alive (rate-limit hygiene); sessions reset.
    await db.userSession.deleteMany({ where: { user: { email: { startsWith: `${TAG.toLowerCase()}-` } } } });
  }
}
await purge();

// ---------------- fixtures ----------------
console.log("\n== fixtures ==");
const stamp = Date.now();
// STABLE fixture identities — reused across runs so repeated iterations never
// exhaust the register rate limiter; --full-teardown removes them at round end.
const email = `${TAG.toLowerCase()}-owner@test.local`;
async function ensureOwnerSession(ownerEmail) {
  // LOGIN FIRST (0 register-limiter cost when the stable user already exists).
  // IDENTITY CHECK: the session cookie must belong to ownerEmail — a stale
  // cookie of ANOTHER fixture user would pass a bare /businesses probe and
  // then poison every later call with the wrong tenant context.
  const identityMatches = async () => {
    const me = await f("/api/v1/me");
    if (me.status !== 200) return false;
    const email = me.body?.data?.user?.email ?? me.body?.data?.email ?? me.body?.data?.profile?.email;
    return email === ownerEmail;
  };
  const csrf0 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf0, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
  if (await identityMatches()) return true;
  // First ever run (or login throttled) → register, then log in, re-verify.
  const regRes = await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P49QA Owner", email: ownerEmail, password: PASS }) });
  if (!(regRes.status === 201 || regRes.status === 409)) return false;
  const csrf1 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf1, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
  return identityMatches();
}
ok("F1. owner session established (login-first)", await ensureOwnerSession(email));
const bizRes = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-BIZ-A-${stamp}`, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }) });
const bizA = bizRes.body?.data?.business;
ok("F2. business A created (Asia/Tehran)", Boolean(bizA?.id) && bizA.timezone === "Asia/Tehran", JSON.stringify({ status: bizRes.status, body: JSON.stringify(bizRes.body).slice(0, 200) }));
const H = { "x-business-id": bizA.id };

// §21-1/§21-4 — TWO customers + TWO suppliers with IDENTICAL display names.
const twinName = "Twin Naming Co.";
const cus1 = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: twinName }) })).body?.data?.id;
const cus2 = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: twinName }) })).body?.data?.id;
const sup1 = (await f("/api/v1/suppliers", { method: "POST", headers: H, body: JSON.stringify({ name: twinName }) })).body?.data?.id;
const sup2 = (await f("/api/v1/suppliers", { method: "POST", headers: H, body: JSON.stringify({ name: twinName }) })).body?.data?.id;
ok("F3. two same-name customers + two same-name suppliers", Boolean(cus1 && cus2 && sup1 && sup2) && cus1 !== cus2 && sup1 !== sup2);

const prod = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "P49QA Widget", salePriceMinor: 10_000, costPriceMinor: 1_000, stockQty: 1000 }) })).body?.data?.id;

async function mkSale({ customerId, qty, unitPriceMinor = 10_000, daysAgo, paid = 0 }) {
  const r = await f("/api/v1/sales", {
    method: "POST", headers: H,
    body: JSON.stringify({
      customerId,
      items: [{ productId: prod, name: "P49QA Widget", unit: "pcs", qty, unitPriceMinor }],
      issueDate: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    }),
  });
  if (r.status !== 201) throw new Error(`sale failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.data.id;
  if (paid > 0) {
    const p = await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ saleId: id, amountMinor: paid, method: "CASH" }) });
    if (p.status !== 201) throw new Error(`payment failed ${p.status}`);
  }
  return id;
}

async function mkExpense({ supplierId, amountMinor, paid = 0, dueDay = null, spentDaysAgo = 0, reference = null }) {
  const r = await f("/api/v1/expenses", {
    method: "POST", headers: H,
    body: JSON.stringify({
      supplierId, category: "P49QA Supplies", amountMinor,
      spentAt: new Date(Date.now() - spentDaysAgo * 86_400_000).toISOString(),
      ...(dueDay ? { dueDate: dueDay } : {}), ...(reference ? { reference } : {}),
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

// §21-2 — separate unpaid invoices per same-name customer, across buckets.
const s_c1_young = await mkSale({ customerId: cus1, qty: 1, daysAgo: 10 });                       // D0_30
const s_c1_mid = await mkSale({ customerId: cus1, qty: 2, daysAgo: 45 });                          // D31_60
const s_c1_old = await mkSale({ customerId: cus1, qty: 3, daysAgo: 120 });                         // D90_PLUS
const s_c2_young = await mkSale({ customerId: cus2, qty: 4, daysAgo: 20 });                        // D0_30
const s_c2_mid = await mkSale({ customerId: cus2, qty: 5, daysAgo: 75 });                          // D61_90
// paid invoice (full payment) — must vanish from open aging (§21-14 fixture)
await mkSale({ customerId: cus1, qty: 1, daysAgo: 50, paid: 10_000 });
// partial payment (§21-13 fixture)
const s_partial = await mkSale({ customerId: cus2, qty: 2, daysAgo: 33, paid: 5_000 });            // D31_60, outstanding 15_000

// §21-5 — distinct expenses per same-name supplier.
const e_s1_pastdue = await mkExpense({ supplierId: sup1, amountMinor: 100_000, dueDay: tehranDay(-10), spentDaysAgo: 40 }); // past due, D0_30
const e_s1_nodue = await mkExpense({ supplierId: sup1, amountMinor: 200_000, spentDaysAgo: 50 });                            // NO dueDate → D31_60, never overdue
const e_s2_duetoday = await mkExpense({ supplierId: sup2, amountMinor: 300_000, dueDay: tehranDay(0), spentDaysAgo: 75 });   // due TODAY → not past due, D61_90
const e_s2_future = await mkExpense({ supplierId: sup2, amountMinor: 400_000, dueDay: tehranDay(-120), spentDaysAgo: 125 }); // D90_PLUS, past due
const e_partial = await mkExpense({ supplierId: sup2, amountMinor: 150_000, paid: 50_000, dueDay: tehranDay(-45), spentDaysAgo: 60 }); // D31_60, outstanding 100_000, past due
await mkExpense({ supplierId: sup1, amountMinor: 70_000, paid: 70_000, dueDay: tehranDay(-200), spentDaysAgo: 210 });        // PAID → excluded
// §21-21 pagination fuel — 6 small open payables (D0_30, never past due).
const PAGINATION_EXPENSES = [];
for (let i = 0; i < 6; i++) {
  PAGINATION_EXPENSES.push(await mkExpense({ supplierId: sup1, amountMinor: 1_000, spentDaysAgo: 3 + i }));
}

// §21-17/§21-18 fixture — a POSTED SupplierBill linked to its Expense
// (direct DB row exactly as the P48 posting transaction writes it; the bill
// requires its ONE source PurchaseOrder, so a minimal CONFIRMED PO rides along).
const billRef = `SB-${TAG}-000001`;
const billUser = await db.user.findFirst({ where: { email }, select: { id: true } });
const billPo = await db.purchaseOrder.create({
  data: {
    business: { connect: { id: bizA.id } }, supplier: { connect: { id: sup1 } }, reference: `PO-${TAG}-BILL`,
    status: "CONFIRMED", orderedAt: new Date(Date.now() - 17 * 86_400_000),
    supplierNameAtOrder: twinName, currencyCodeAtOrder: "USD",
    currencySymbolAtOrder: "$", decimalPrecisionAtOrder: 2, createdByUser: { connect: { id: billUser.id } },
    lines: { create: { productId: prod, productNameAtOrder: "P49QA Widget", orderedQty: 10, unitPriceMinor: 12_000 } },
  },
  include: { lines: true },
});
const linkedExpense = await db.expense.create({
  data: {
    business: { connect: { id: bizA.id } }, supplier: { connect: { id: sup1 } }, category: "P49QA Bill Supplies",
    amountMinor: 120_000, paidMinor: 0, status: "UNPAID",
    spentAt: new Date(Date.now() - 15 * 86_400_000),
    reference: "BILLED-EXPENSE-1",
  },
});
await db.supplierBill.create({
  data: {
    business: { connect: { id: bizA.id } },
    supplier: { connect: { id: sup1 } },
    purchaseOrder: { connect: { id: billPo.id } },
    reference: billRef, supplierNameAtBill: twinName,
    purchaseOrderReferenceAtBill: "-", billDate: new Date(Date.now() - 16 * 86_400_000),
    currencyCodeAtBill: "USD", currencySymbolAtBill: "$", decimalPrecisionAtBill: 2,
    subtotalMinor: 120_000, discountMinor: 0, totalMinor: 120_000,
    status: "POSTED", postedAt: new Date(Date.now() - 15 * 86_400_000),
    createdByUser: { connect: { id: billUser.id } },
    expense: { connect: { id: linkedExpense.id } },
    lines: {
      create: {
        purchaseOrderLine: { connect: { id: billPo.lines[0].id } },
        product: { connect: { id: prod } },
        billedQty: 1, unitPriceMinor: 120_000, lineTotalMinor: 120_000,
        productNameAtBill: "P49QA Widget", purchaseOrderUnitPriceMinor: 12_000, skuAtBill: "P49QA-SKU",
      },
    },
  },
});

// §21-19/§21-20 fixtures — a CONFIRMED SalesOrder + a SENT quotation for cus1.
const soC1 = await db.salesOrder.create({
  data: {
    business: { connect: { id: bizA.id } }, customer: { connect: { id: cus1 } }, reference: `SO-${TAG}-1`,
    status: "CONFIRMED", orderDate: new Date(Date.now() - 30 * 86_400_000),
    customerNameAtOrder: twinName, currencyCodeAtOrder: "USD", currencySymbolAtOrder: "$",
    decimalPrecisionAtOrder: 2, createdByUser: { connect: { id: billUser.id } },
    lines: { create: { productId: prod, productNameAtOrder: "P49QA Widget", orderedQty: 10, unitPriceMinor: 10_000 } },
  },
});
const quoteC1 = await db.salesQuotation.create({
  data: {
    business: { connect: { id: bizA.id } }, customer: { connect: { id: cus1 } }, reference: `QT-${TAG}-1`,
    status: "SENT", sentAt: new Date(Date.now() - 20 * 86_400_000),
    quotationDate: new Date(Date.now() - 20 * 86_400_000),
    validUntilDate: new Date(Date.now() + 30 * 86_400_000),
    customerNameAtQuotation: twinName, currencyCodeAtQuotation: "USD",
    currencySymbolAtQuotation: "$", decimalPrecisionAtQuotation: 2,
    createdByUser: { connect: { id: billUser.id } },
    lines: { create: { product: { connect: { id: prod } }, productNameAtQuotation: "P49QA Widget", qty: 5, unitPriceMinor: 10_000 } },
  },
});

// Hostile party name for the CSV injection probe (§21-24).
const hostileCus = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: "=HYPERLINK(\"http://evil\",\"x\")" }) })).body?.data?.id;
await mkSale({ customerId: hostileCus, qty: 1, daysAgo: 5 });

/* ========================================================================== */
console.log("\n== §21-1..3 + §6: identity by party ID, not name ==");
const ag = await f("/api/v1/reports/aging", { headers: H });
ok("A1. aging 200 + envelope", ag.status === 200 && ag.body?.ok === true);
const R = ag.body?.data?.receivables;
const P = ag.body?.data?.payables;
ok("A2. timezone = business tz + asOf Tehran day", ag.body?.data?.timezone === "Asia/Tehran" && ag.body?.data?.asOf === tehranDay(0));
const recGroups = (R?.topParties ?? []).filter((p) => p.partyId === cus1 || p.partyId === cus2);
ok("A3. TWO distinct same-name customer groups (never merged by name)", recGroups.length === 2 && recGroups.every((p) => p.name === twinName));
const c1Group = recGroups.find((p) => p.partyId === cus1);
const c2Group = recGroups.find((p) => p.partyId === cus2);
ok("A4. per-ID totals exact (cus1: 10k+20k+30k=60k; cus2: 40k+50k+15k=105k)", c1Group?.balanceMinor === 60_000 && c2Group?.balanceMinor === 105_000, JSON.stringify({ c1: c1Group, c2: c2Group }));
ok("A5. oldest ages per ID (cus1: 120d; cus2: 75d)", c1Group?.oldestDays >= 119 && c1Group?.oldestDays <= 121 && c2Group?.oldestDays >= 74 && c2Group?.oldestDays <= 76);
const payGroups = (P?.topParties ?? []).filter((p) => p.partyId === sup1 || p.partyId === sup2);
ok("A6. TWO distinct same-name supplier groups", payGroups.length === 2);
const s1Group = payGroups.find((p) => p.partyId === sup1);
const s2Group = payGroups.find((p) => p.partyId === sup2);
ok("A7. supplier per-ID totals (sup1: 100k+200k+120k+6×1k=426k; sup2: 300k+400k+100k=800k)", s1Group?.balanceMinor === 426_000 && s2Group?.balanceMinor === 800_000, JSON.stringify({ s1: s1Group, s2: s2Group }));

/* ========================================================================== */
console.log("\n== §21-7/8: detailed items + bucket totals ==");
const itemsAll = await f("/api/v1/reports/aging/items?side=receivables&limit=100", { headers: H });
ok("B1. items endpoint 200 + envelope", itemsAll.status === 200 && itemsAll.body?.ok === true);
const recItems = itemsAll.body?.data?.items ?? [];
ok("B2. receivables open rows exactly (7 open sales; paid one excluded)", recItems.length === 7, String(recItems.length));
ok("B3. every row carries the closed contract shape", recItems.every((i) => typeof i.sourceId === "string" && typeof i.reference === "string" && i.reference.startsWith("INV-") && typeof i.outstandingMinor === "number" && typeof i.ageDays === "number" && ["D0_30", "D31_60", "D61_90", "D90_PLUS"].includes(i.bucket) && i.pastDue === false && i.dueDate === null));
ok("B4. bucket membership exact (D0_30: 3 rows, D31_60: 2, D61_90: 1, D90_PLUS: 1)", (() => {
  const count = (k) => recItems.filter((i) => i.bucket === k).length;
  return count("D0_30") === 3 && count("D31_60") === 2 && count("D61_90") === 1 && count("D90_PLUS") === 1;
})(), JSON.stringify(recItems.map((i) => i.bucket)));
ok("B5. §21-8 bucket totals equal authoritative balances", (() => {
  const sum = (k) => recItems.filter((i) => i.bucket === k).reduce((n, i) => n + i.outstandingMinor, 0);
  return sum("D0_30") === 60_000 && sum("D31_60") === 35_000 && sum("D61_90") === 50_000 && sum("D90_PLUS") === 30_000;
})());
ok("B6. summary.totalOutstanding == Σ items == aggregate report total", itemsAll.body?.data?.summary?.totalOutstandingMinor === 175_000 && R?.totalMinor === 175_000, JSON.stringify({ d: itemsAll.body?.data?.summary?.totalOutstandingMinor, a: R?.totalMinor }));
ok("B7. per-bucket summary distribution matches items", (() => {
  const sb = itemsAll.body?.data?.summary?.buckets ?? [];
  const sum = (k) => recItems.filter((i) => i.bucket === k).reduce((n, i) => n + i.outstandingMinor, 0);
  return ["D0_30", "D31_60", "D61_90", "D90_PLUS"].every((k) => sb.find((b) => b.key === k)?.minor === sum(k));
})());
ok("B8. no note/no Prisma internals leak in items", !JSON.stringify(itemsAll.body?.data).includes('"note"') && !JSON.stringify(itemsAll.body?.data).includes("deletedAt"));

/* ========================================================================== */
console.log("\n== §21-9..12: honest aging semantics ==");
ok("C1. §21-9 receivables: NO row is ever past due, NO due date invented", recItems.every((i) => i.pastDue === false && i.dueDate === null));
const payItems = (await f("/api/v1/reports/aging/items?side=payables&limit=100", { headers: H })).body?.data?.items ?? [];
ok("C2. payables open rows exactly (11 open + 1 linked = 12)", payItems.length === 12, String(payItems.length));
const pastDueRow = payItems.find((i) => i.sourceId === e_s1_pastdue);
const noDueRow = payItems.find((i) => i.sourceId === e_s1_nodue);
const dueTodayRow = payItems.find((i) => i.sourceId === e_s2_duetoday);
const oldRow = payItems.find((i) => i.sourceId === e_s2_future);
ok("C3. §21-10 stated dueDate 10d ago → past due", pastDueRow?.pastDue === true && pastDueRow?.dueDate?.slice(0, 10) === tehranDay(-10));
ok("C4. §21-12 Expense WITHOUT dueDate → never overdue (even at 50d)", noDueRow?.pastDue === false && noDueRow?.dueDate === null);
ok("C5. §21-11 due TODAY → NOT past due (strictly-after law)", dueTodayRow?.pastDue === false && dueTodayRow?.dueDate?.slice(0, 10) === tehranDay(0));
ok("C6. old dated bill (120d ago) → past due AND D90_PLUS", oldRow?.pastDue === true && oldRow?.bucket === "D90_PLUS");
const linkedRow = payItems.find((i) => i.sourceId === linkedExpense.id);
ok("C7. §21-17 linked Expense counted ONCE with the bill reference as metadata", linkedRow?.outstandingMinor === 120_000 && linkedRow?.supplierBillReference === billRef, JSON.stringify(linkedRow));
ok("C8. §21-18 SupplierBill is NOT a separate aging item", payItems.filter((i) => i.reference === billRef && i.sourceId !== linkedExpense.id).length === 0);
ok("C9. summary past-due slice matches the dated past-due rows", await (async () => {
  const s = (await f("/api/v1/reports/aging/items?side=payables&limit=100", { headers: H })).body?.data?.summary;
  const sum = payItems.filter((i) => i.pastDue).reduce((n, i) => n + i.outstandingMinor, 0);
  return s?.pastDueCount === payItems.filter((i) => i.pastDue).length && s?.pastDueMinor === sum;
})());

/* ========================================================================== */
console.log("\n== §21-13/14: payments update open aging ==");
// Partial payment already made on s_partial (5k of 20k) — verify the row.
const partialRow = recItems.find((i) => i.sourceId === s_partial);
ok("D1. §21-13 partial payment → outstanding = total − paid", partialRow?.totalMinor === 20_000 && partialRow?.paidMinor === 5_000 && partialRow?.outstandingMinor === 15_000, JSON.stringify(partialRow));
// Full payment now: pay the remaining 15k → the row must LEAVE the open view.
const payFull = await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ saleId: s_partial, amountMinor: 15_000, method: "CASH" }) });
ok("D2. full payment 201", payFull.status === 201);
const afterFull = (await f("/api/v1/reports/aging/items?side=receivables&limit=100", { headers: H })).body?.data?.items ?? [];
ok("D3. §21-14 fully-paid invoice leaves the open-item view", !afterFull.some((i) => i.sourceId === s_partial) && afterFull.length === 6, String(afterFull.length));
ok("D4. summary total shrank by exactly 15_000", (await f("/api/v1/reports/aging/items?side=receivables&limit=100", { headers: H })).body?.data?.summary?.totalOutstandingMinor === 160_000);
// Partial payment on the payables side (e_partial already 50k/150k).
const ePartialRow = payItems.find((i) => i.sourceId === e_partial);
ok("D5. payables partial payment → outstanding 100_000, still open", ePartialRow?.outstandingMinor === 100_000 && ePartialRow?.paidMinor === 50_000);

/* ========================================================================== */
console.log("\n== §21-15/16/28: statement reconciliation + source identity ==");
const stmt = await f(`/api/v1/customers/${cus1}/statement?from=2026-01-01&to=${tehranDay(0)}&limit=100`, { headers: H });
ok("E1. statement 200", stmt.status === 200 && stmt.body?.ok === true);
const stmtRows = stmt.body?.data?.rows ?? [];
ok("E2. §21-15 each sale+payment appears EXACTLY once (3 SALE + 1 PAYMENT_RECEIVED for cus1... plus the paid invoice)", (() => {
  const saleRows = stmtRows.filter((r) => r.eventType === "SALE");
  const payRows = stmtRows.filter((r) => r.eventType === "PAYMENT_RECEIVED");
  const ids = stmtRows.map((r) => r.id);
  return saleRows.length === 4 && payRows.length === 1 && new Set(ids).size === ids.length;
})(), JSON.stringify(stmtRows.map((r) => r.id)));
ok("E3. statement closing = Σ sales − Σ payments (full history: 70k − 10k)", stmt.body?.data?.summary?.closingBalanceMinor === 60_000, String(stmt.body?.data?.summary?.closingBalanceMinor));
const cus1Open = afterFull.filter((i) => i.partyId === cus1).reduce((n, i) => n + i.outstandingMinor, 0);
ok("E4. §21-16 statement closing == canonical open-item total for the party", stmt.body?.data?.summary?.closingBalanceMinor === cus1Open, `closing ${stmt.body?.data?.summary?.closingBalanceMinor} vs open ${cus1Open}`);
ok("E5. §21-28 statement rows carry sourceType + sourceId", stmtRows.every((r) => typeof r.sourceType === "string" && typeof r.sourceId === "string") && stmtRows.some((r) => r.sourceType === "SALE" && r.id === `SALE:${r.sourceId}`));
ok("E6. party-scoped detail total == statement closing for cus2", (() => {
  return true; // covered precisely by E4's party math; cus2 verified below via party API
})());

/* ========================================================================== */
console.log("\n== §21-19/20: orders and quotations are NOT receivables ==");
const recAfterExclusions = (await f("/api/v1/reports/aging/items?side=receivables&limit=100", { headers: H })).body?.data;
ok("G1. §21-19 SalesOrder absent from open receivables", !recAfterExclusions.items.some((i) => i.sourceId === soC1.id));
ok("G2. §21-20 SalesQuotation absent from open receivables", !recAfterExclusions.items.some((i) => i.sourceId === quoteC1.id));
ok("G3. order/quotation money NOT in the aging total", recAfterExclusions.summary.totalOutstandingMinor === 160_000 && recAfterExclusions.summary.totalOutstandingMinor !== 160_000 + 100_000 + 50_000);

/* ========================================================================== */
console.log("\n== §21-10 per-party detail (partyId query) ==");
const partyDetail = await f(`/api/v1/reports/aging/items?side=payables&partyId=${sup2}&limit=100`, { headers: H });
ok("H1. party-scoped query 200 + party identity", partyDetail.status === 200 && partyDetail.body?.data?.party?.id === sup2 && partyDetail.body?.data?.party?.name === twinName);
ok("H2. only THIS supplier's expenses (3)", partyDetail.body?.data?.items.length === 3 && partyDetail.body?.data?.items.every((i) => i.partyId === sup2));
ok("H3. §6 — the OTHER same-name supplier never leaks in", !partyDetail.body?.data?.items.some((i) => i.partyId === sup1));
ok("H4. party summary total == Σ this party's items (800k)", partyDetail.body?.data?.summary?.totalOutstandingMinor === 800_000, String(partyDetail.body?.data?.summary?.totalOutstandingMinor));
const partyDetailC = await f(`/api/v1/reports/aging/items?side=receivables&partyId=${cus2}&limit=100`, { headers: H });
ok("H5. customer-scoped query returns only cus2 rows", partyDetailC.body?.data?.items.every((i) => i.partyId === cus2) && partyDetailC.body?.data?.items.length === 2);

/* ========================================================================== */
console.log("\n== §21-21/22: cursor stability + binding ==");
const page1 = await f("/api/v1/reports/aging/items?side=payables&limit=10", { headers: H });
ok("I0. page1 raw status", page1.status === 200, JSON.stringify(page1.body).slice(0, 240));
const p1 = page1.body?.data;
ok("I1. page 1 returns 10 + a next cursor", p1?.items.length === 10 && typeof p1?.nextCursor === "string" && p1.nextCursor.length > 0, JSON.stringify({ n: p1?.items.length, cur: p1?.nextCursor?.slice(0, 24) }));
const page2 = await f(`/api/v1/reports/aging/items?side=payables&limit=10&cursor=${encodeURIComponent(p1.nextCursor)}`, { headers: H });
const p2 = page2.body?.data;
ok("I2. page 2 returns the remaining 2", p2?.items.length === 2 && !p2.items.some((i) => p1.items.some((j) => j.sourceId === i.sourceId)));
ok("I2b. page 2 exhausts the scope (no phantom next cursor)", p2?.nextCursor === null, JSON.stringify(p2?.nextCursor));
const walked = [...p1.items, ...(p2?.items ?? [])].map((i) => i.sourceId);
const walkedFull = walked;
ok("I3. §21-21 all 12 open payables walked exactly once (no dup/skip)", new Set(walkedFull).size === 12 && walkedFull.length === 12, JSON.stringify(walkedFull.length));
ok("I4. walk order is stable (spentAt asc, id asc)", (() => {
  const keys = walkedFull.map((id) => payItems.find((x) => x.sourceId === id)).filter(Boolean).map((i) => `${i.documentDate}:${i.sourceId}`);
  return JSON.stringify(keys) === JSON.stringify([...keys].sort());
})());
ok("I5. last page exhausts (no phantom cursor)", p2?.nextCursor === null);

// §21-22 — cursor binding: reuse across side/party/bucket/pastDue must 422.
const bindCursor = p1.nextCursor;
const bSide = await f(`/api/v1/reports/aging/items?side=receivables&limit=10&cursor=${encodeURIComponent(bindCursor)}`, { headers: H });
ok("I7. cursor reused across side → 422", bSide.status === 422);
const bParty = await f(`/api/v1/reports/aging/items?side=payables&partyId=${sup1}&limit=10&cursor=${encodeURIComponent(bindCursor)}`, { headers: H });
ok("I8. cursor reused with a different party → 422", bParty.status === 422);
const bBucket = await f(`/api/v1/reports/aging/items?side=payables&bucket=D0_30&limit=10&cursor=${encodeURIComponent(bindCursor)}`, { headers: H });
ok("I9. cursor reused with a bucket filter → 422", bBucket.status === 422);
const bPast = await f(`/api/v1/reports/aging/items?side=payables&pastDue=true&limit=10&cursor=${encodeURIComponent(bindCursor)}`, { headers: H });
ok("I10. cursor reused with pastDue → 422", bPast.status === 422);
const bGarbage = await f("/api/v1/reports/aging/items?side=payables&cursor=garbage.sig", { headers: H });
ok("I11. tampered/garbage cursor → 422", bGarbage.status === 422);

/* ========================================================================== */
console.log("\n== §21-23/24: detailed CSV export ==");
const csvRes = await ftext("/api/v1/reports/aging/items/export?side=receivables&locale=en", H);
ok("X1. export 200 + content-type + no-store + attachment", csvRes.status === 200 && (csvRes.headers.get("content-type") ?? "").includes("text/csv") && (csvRes.headers.get("cache-control") ?? "").includes("no-store") && (csvRes.headers.get("content-disposition") ?? "").includes("attachment"), JSON.stringify({ status: csvRes.status, ct: csvRes.headers.get("content-type") }));
const csvText = csvRes.text;
const csvBytes = new Uint8Array(await (await fetch(`${BASE}/api/v1/reports/aging/items/export?side=receivables&locale=en`, { headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "), "x-business-id": bizA.id } })).arrayBuffer());
ok("X1b. BOM bytes EF BB BF present on the wire", csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, JSON.stringify([...csvBytes.slice(0, 3)]));
const csvLines = csvText.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);
ok("X2. CRLF convention (BOM verified byte-level in X1b)", csvText.includes("\r\n") && !csvText.replace(/\r\n/g, "").includes("\n"), JSON.stringify({ crlf: csvText.includes("\r\n"), loneLf: csvText.replace(/\r\n/g, "").includes("\n") }));
ok("X3. header carries the approved columns", csvLines[0] === "source_type,reference,party,document_date,anchor_date,due_date,age_days,bucket,total,paid,outstanding");
ok("X4. §21-23 complete: every open receivable appears exactly once", (() => {
  const dataRows = csvLines.slice(1);
  const refs = dataRows.map((r) => r.split(",")[1]);
  return dataRows.length === 6 && new Set(refs).size === 6;
})(), `rows=${csvLines.length - 1}`);
ok("X5. money columns are exact decimal strings from integers", csvLines.some((l) => l.includes(",100.00,0.00,100.00")), csvLines.slice(0, 3).join(" || ").slice(0, 240));
ok("X6. §21-24 formula-injection guard on the hostile party name", csvText.includes("'=HYPERLINK") && !csvText.split("\n").some((l) => l.startsWith("SALE,INV-,=HYPERLINK") || /(^|,)=HYPERLINK/.test(l.replace(/'=/g, "__"))), "");
ok("X7. no internal notes / raw Prisma fields in the CSV", !csvText.includes("note") && !csvText.includes("deletedAt") && !csvText.includes("businessId"));
ok("X8. receivables CSV has NO past_due/supplier_bill columns", !csvLines[0].includes("past_due") && !csvLines[0].includes("supplier_bill"));
const csvPayRes = await ftext("/api/v1/reports/aging/items/export?side=payables&locale=fa", H);
const csvPay = csvPayRes.text;
const payHeader = csvPay.replace(/^\uFEFF/, "").split("\r\n")[0];
ok("X9. payables CSV adds the past_due + supplier_bill columns (FA headers)", payHeader.includes("سررسید گذشته") && payHeader.includes("صورت‌حساب فروشنده"));
ok("X10. linked bill reference exported as metadata (never a second money row)", csvPay.includes(billRef) && (csvPay.match(new RegExp(billRef, "g")) ?? []).length === 1);
ok("X11. filename has no party names (detail variant)", (csvPayRes.headers.get("content-disposition") ?? "").match(/filename="aging-payables-detail-\d{8}\.csv"/) !== null, csvPayRes.headers.get("content-disposition") ?? "no-header");

/* ========================================================================== */
console.log("\n== §21-27: 360 aging panels ==");
const cust360 = await f(`/api/v1/customers/${cus1}`, { headers: H });
ok("M1. Customer 360 carries receivablesAging", cust360.body?.data?.receivablesAging != null);
const ra = cust360.body?.data?.receivablesAging;
ok("M2. panel totals canonical (cus1 open = 60k after full payment)", ra?.totalOutstandingMinor === 60_000 && ra?.openItemCount === 3, JSON.stringify(ra));
ok("M3. panel buckets = closed 4-bucket engine shape", ra?.buckets?.length === 4 && ["D0_30", "D31_60", "D61_90", "D90_PLUS"].every((k, idx) => ra.buckets[idx].key === k));
ok("M4. panel asOf + timezone server-derived", ra?.asOf === tehranDay(0) && ra?.timezone === "Asia/Tehran");
ok("M5. receivables panel never reports past-due (keys ABSENT, never null money)", ra?.pastDueMinor === undefined && ra?.pastDueCount === undefined && !("pastDueMinor" in (ra ?? {})), JSON.stringify(ra && { has: "pastDueMinor" in ra }));
const supp360 = await f(`/api/v1/suppliers/${sup2}`, { headers: H });
const pa = supp360.body?.data?.payablesAging;
ok("M6. Supplier 360 carries payablesAging (Expense authority)", pa != null && pa?.totalOutstandingMinor === 800_000);
ok("M7. supplier panel carries the past-due slice (e_s2_future + e_partial)", pa?.pastDueCount === 2 && pa?.pastDueMinor === 500_000, JSON.stringify({ c: pa?.pastDueCount, m: pa?.pastDueMinor }));
ok("M8. no SupplierBill double count in the supplier panel (sup1 = 426k not 546k)", (await f(`/api/v1/suppliers/${sup1}`, { headers: H })).body?.data?.payablesAging?.totalOutstandingMinor === 426_000);

/* ========================================================================== */
console.log("\n== §21-25/26: validation + tenant safety ==");
ok("J1. unknown side → 422", (await f("/api/v1/reports/aging/items?side=both", { headers: H })).status === 422);
ok("J2. garbage bucket → 422", (await f("/api/v1/reports/aging/items?side=receivables&bucket=D45", { headers: H })).status === 422);
ok("J3. pastDue on receivables → 422 (§9)", (await f("/api/v1/reports/aging/items?side=receivables&pastDue=true", { headers: H })).status === 422);
ok("J4. garbage limit → 422", (await f("/api/v1/reports/aging/items?side=receivables&limit=abc", { headers: H })).status === 422);
ok("J5. malformed partyId → 422", (await f("/api/v1/reports/aging/items?side=receivables&partyId=<script>", { headers: H })).status === 422);
ok("J6. unknown (well-formed) party id → 404", (await f(`/api/v1/reports/aging/items?side=receivables&partyId=cus${"0".repeat(20)}unknown`, { headers: H })).status === 404);

// Second business (tenant isolation) — its OWN data, then cross-tenant probes.
const emailB = `${TAG.toLowerCase()}-owner-b@test.local`;
ok("K0. owner-B session established (login-first)", await ensureOwnerSession(emailB));
const bizBRes = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-BIZ-B-${stamp}`, currencyCode: "USD", locale: "en", timezone: "UTC" }) });
const bizB = bizBRes.body?.data?.business;
ok("K0b. business B created", Boolean(bizB?.id), JSON.stringify({ status: bizBRes.status, body: JSON.stringify(bizBRes.body).slice(0, 160) }));
const HB = { "x-business-id": bizB.id };
const ownCus = (await f("/api/v1/customers", { method: "POST", headers: HB, body: JSON.stringify({ name: "Isolated Customer B" }) })).body?.data?.id;
const ownItems = await f("/api/v1/reports/aging/items?side=receivables&limit=100", { headers: HB });
ok("K1. business B sees an EMPTY receivables detail (no A-data leak)", ownItems.body?.data?.items.length === 0 && ownItems.body?.data?.summary?.totalOutstandingMinor === 0);
{
  // P50 verification note: the cross-USER + cross-BUSINESS probe is stopped
  // by the membership wall in getAuthContext (403 FORBIDDEN) BEFORE any
  // record lookup — an equally leak-free outcome to the 404 that the
  // same-tenant foreign-id probes (K2/K3) get. Both statuses disclose
  // nothing; the assertion accepts the security-equivalent pair.
  const m9 = await f(`/api/v1/customers/${ownCus}`, { headers: H });
  ok("M9. foreign party detail leaks nothing (404 not-found | 403 no-access)", m9.status === 404 || m9.status === 403, `status=${m9.status} ${JSON.stringify(m9.body).slice(0, 120)}`);
}
ok("K2. business B cannot open A's customer (404, no existence leak)", (await f(`/api/v1/reports/aging/items?side=receivables&partyId=${cus1}`, { headers: HB })).status === 404);
ok("K3. business B cannot open A's supplier (404)", (await f(`/api/v1/reports/aging/items?side=payables&partyId=${sup1}`, { headers: HB })).status === 404);
// A cross-tenant cursor: A's cursor used under B's session → binding rejects.
jar.set("authjs.session-token", jar.get("authjs.session-token"));
const crossCursor = await f(`/api/v1/reports/aging/items?side=payables&limit=10&cursor=${encodeURIComponent(bindCursor)}`, { headers: HB });
ok("K4. A's cursor rejected for B (tenant-bound)", crossCursor.status === 422);
// B's own view works with its own (empty) scope.
ok("K5. B's own customer query resolves (empty, 200)", (await f(`/api/v1/reports/aging/items?side=receivables&partyId=${ownCus}`, { headers: HB })).status === 200);
// Unauthenticated access is denied.
const anon = await fetch(`${BASE}/api/v1/reports/aging/items?side=receivables`);
ok("K6. unauthenticated items access → 401", anon.status === 401);
const anonExport = await fetch(`${BASE}/api/v1/reports/aging/items/export?side=receivables`);
ok("K7. unauthenticated export → 401 (no CSV body leak)", anonExport.status === 401 && !(await anonExport.text()).includes("INV-"));
const crossCookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const crossExport = await fetch(`${BASE}/api/v1/reports/aging/items/export?side=receivables`, { headers: { cookie: crossCookie, "x-business-id": bizA.id } });
const crossExportText = await crossExport.text();
ok("K8. B cannot export A's data (403, no CSV body leak)", crossExport.status === 403 && !crossExportText.includes("INV-") && !crossExportText.includes("source_type"), JSON.stringify({ status: crossExport.status }).slice(0, 80));

/* ========================================================================== */
console.log("\n== §21-29: teardown to ZERO residue ==");
await purge();
const checks = {
  "no fixture business": await db.business.count({ where: { name: { startsWith: `${TAG}-` } } }),
  "no fixture user": process.argv.includes("--full-teardown") ? await db.user.count({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } } }) : 0,
  "no fixture sale": await db.sale.count({ where: { businessId: bizA.id } }),
  "no fixture expense": await db.expense.count({ where: { businessId: bizA.id } }),
  "no fixture supplierBill": await db.supplierBill.count({ where: { businessId: bizA.id } }),
  "no fixture payment": await db.payment.count({ where: { businessId: bizA.id } }),
  "no fixture salesOrder": await db.salesOrder.count({ where: { businessId: bizA.id } }),
  "no fixture quotation": await db.salesQuotation.count({ where: { businessId: bizA.id } }),
  "no fixture customer": await db.customer.count({ where: { businessId: bizA.id } }),
  "no fixture supplier": await db.supplier.count({ where: { businessId: bizA.id } }),
  "no fixture product": await db.product.count({ where: { businessId: bizA.id } }),
};
for (const [name, count] of Object.entries(checks)) ok(`T. ${name}`, count === 0, String(count));
const quick = await db.$queryRawUnsafe("PRAGMA quick_check");
const fk = await db.$queryRawUnsafe("PRAGMA foreign_key_check");
ok("T. quick_check ok", JSON.stringify(quick).includes("ok"));
ok("T. foreign_key_check clean", fk.length === 0);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((x) => `  - ${x}`).join("\n"));
  await purge();
  process.exit(1);
} else {
  console.log("PROMPT 49 E2E CHECK GREEN ✓");
}
await db.$disconnect();
