#!/usr/bin/env node
/**
 * scripts/prompt50-reports-browser-fixture.mjs — Prompt 50 browser-QA
 * fixture (mirrors the P47/P48/P49 browser-fixture convention).
 *
 * Seeds a STABLE visual fixture for real-browser QA of the Reports module:
 *   - owner p50qa-owner@test.local (login-first, kept between runs)
 *   - business P50QA-VISUAL (Asia/Tehran, USD) on STARTER
 *     (ADVANCED_REPORTS + CSV_EXPORT visible)
 *   - ~40 days of sales across twin/same-name products + renamed product
 *     + unlinked lines + a document-discount invoice
 *   - same-name customers/suppliers, 8 expense categories,
 *     IN/OUT payments incl. a future-dated trio (excluded from reports)
 *   - a past month with 30 invoices (month-detail preview + complete CSV)
 *   - wipes ALL previous fixture financial rows first (idempotent)
 *
 * Run: bun scripts/prompt50-reports-browser-fixture.mjs
 * Teardown: bun scripts/prompt50-reports-browser-fixture.mjs --teardown
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
const TAG = "P50QA-VISUAL";
const BIZ_NAME = `${TAG}`;
const jar = new Map();

async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.53.13.9", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function wipeFinancialRows(businessId) {
  await db.payment.deleteMany({ where: { businessId } });
  await db.saleItem.deleteMany({ where: { sale: { businessId } } });
  await db.sale.deleteMany({ where: { businessId } });
  await db.expense.deleteMany({ where: { businessId } });
  await db.salesOrderLine.deleteMany({ where: { salesOrder: { businessId } } }).catch(() => {});
  await db.salesOrder.deleteMany({ where: { businessId } }).catch(() => {});
  await db.salesQuotationLine.deleteMany({ where: { salesQuotation: { businessId } } }).catch(() => {});
  await db.salesQuotation.deleteMany({ where: { businessId } }).catch(() => {});
  await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId } } }).catch(() => {});
  await db.purchaseOrder.deleteMany({ where: { businessId } }).catch(() => {});
  await db.supplierBillLine.deleteMany({ where: { supplierBill: { businessId } } }).catch(() => {});
  await db.supplierBill.deleteMany({ where: { businessId } }).catch(() => {});
  await db.customer.deleteMany({ where: { businessId } });
  await db.supplier.deleteMany({ where: { businessId } });
  await db.product.deleteMany({ where: { businessId } });
  await db.inventoryAdjustment.deleteMany({ where: { businessId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { businessId } }).catch(() => {});
}

const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

if (process.argv.includes("--teardown")) {
  const bizs = await db.business.findMany({ where: { name: BIZ_NAME }, select: { id: true } });
  for (const b of bizs) {
    await wipeFinancialRows(b.id);
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } }).catch(() => {});
    await db.subscription.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.business.delete({ where: { id: b.id } });
  }
  console.log("teardown complete: visual fixture removed");
  await db.$disconnect();
  process.exit(0);
}

// ---- owner session ----
const email = "p50qa-owner@test.local";
async function ensureOwnerSession() {
  const csrf0 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf0, email, password: PASS, redirect: "false", json: "true" }).toString() });
  const me = await f("/api/v1/me");
  if (me.status === 200) return true;
  const reg = await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P50QA Owner", email, password: PASS }) });
  if (!(reg.status === 201 || reg.status === 409)) throw new Error(`register failed ${reg.status}`);
  const csrf1 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf1, email, password: PASS, redirect: "false", json: "true" }).toString() });
  return (await f("/api/v1/me")).status === 200;
}
if (!(await ensureOwnerSession())) throw new Error("owner session failed");

// ---- business (adopt a spare P50QA business, reuse, or create) + STARTER ----
let biz = await db.business.findFirst({ where: { name: BIZ_NAME } });
if (!biz) {
  // The check suite keeps BIZ-A/BIZ-B alive (limiter hygiene). Adopt the
  // newest spare (BIZ-B) instead of creating: FREE BUSINESSES_MAX is 1 and
  // the owner already carries the suite's businesses. The check suite
  // recreates BIZ-B on its next run (self-healing).
  const spare = await db.business.findFirst({
    where: { name: { startsWith: "P50QA-BIZ-B" } },
    orderBy: { createdAt: "desc" },
  });
  if (spare) {
    biz = await db.business.update({ where: { id: spare.id }, data: { name: BIZ_NAME, timezone: "Asia/Tehran", locale: "en", currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2 } });
  }
}
if (biz) {
  // STARTER on EVERY run (adopted businesses keep their old plan).
  const starter = await db.plan.findUnique({ where: { code: "STARTER" } });
  if (starter) {
    await db.subscription.upsert({
      where: { businessId: biz.id },
      create: { businessId: biz.id, planId: starter.id, status: "ACTIVE", billingPeriod: "MONTHLY" },
      update: { planId: starter.id },
    });
  }
}
if (!biz) {
  const starter = await db.plan.findUnique({ where: { code: "STARTER" } });
  const res = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: BIZ_NAME, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }) });
  if (res.status !== 201) throw new Error(`business create failed ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  biz = res.body.data.business;
  if (starter) {
    await db.subscription.upsert({
      where: { businessId: biz.id },
      create: { businessId: biz.id, planId: starter.id, status: "ACTIVE", billingPeriod: "MONTHLY" },
      update: { planId: starter.id },
    });
  }
}
await wipeFinancialRows(biz.id);
const H = { "x-business-id": biz.id };

// ---- master data ----
const cus1 = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: "Same Name Co." }) })).body.data.id;
const cus2 = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: "Same Name Co." }) })).body.data.id;
const cus3 = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: "Meridian Trading LLC" }) })).body.data.id;
const sup1 = (await f("/api/v1/suppliers", { method: "POST", headers: H, body: JSON.stringify({ name: "Same Supplier Ltd" }) })).body.data.id;
const prodTwinA = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "Twin Widget", sku: "TW-A", salePriceMinor: 10_000, costPriceMinor: 4_000, stockQty: 400, lowStockAt: 20 }) })).body.data.id;
const prodTwinB = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "Twin Widget", sku: "TW-B", salePriceMinor: 20_000, costPriceMinor: 8_000, stockQty: 250, lowStockAt: 20 }) })).body.data.id;
const prodRename = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "Legacy Kit", sku: "LK-1", salePriceMinor: 5_000, costPriceMinor: 2_000, stockQty: 900, lowStockAt: 15 }) })).body.data.id;
const prodLow = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "Low Stock Sensor", sku: "LS-9", salePriceMinor: 45_000, costPriceMinor: 30_000, stockQty: 3, lowStockAt: 10 }) })).body.data.id;

async function mkSale({ customerId, items, daysAgo, discountMinor = 0, paid = 0 }) {
  const r = await f("/api/v1/sales", { method: "POST", headers: H, body: JSON.stringify({ customerId, items, discountMinor, issueDate: iso(-daysAgo) }) });
  if (r.status !== 201) throw new Error(`sale failed ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const id = r.body.data.id;
  if (paid > 0) {
    await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ saleId: id, amountMinor: paid, method: "CASH" }) });
  }
  return id;
}
async function mkExpense({ supplierId, category, amountMinor, daysAgo, paid = 0 }) {
  const r = await f("/api/v1/expenses", { method: "POST", headers: H, body: JSON.stringify({ supplierId, category, amountMinor, spentAt: iso(-daysAgo) }) });
  const id = r.body.data.id;
  if (paid > 0) await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ expenseId: id, amountMinor: paid, method: "BANK_TRANSFER" }) });
  return id;
}

// ---- 30-invoice past month (preview + complete CSV demo) ----
const monthDate = new Date(Date.now() - 70 * 86_400_000);
const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit" }).formatToParts(monthDate);
const MONTH = `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
const [my, mm] = MONTH.split("-").map(Number);
for (let i = 1; i <= 30; i++) {
  await f("/api/v1/sales", {
    method: "POST", headers: H,
    body: JSON.stringify({
      customerId: i % 3 === 0 ? cus3 : i % 2 === 0 ? cus2 : cus1,
      items: [{ productId: prodRename, name: i % 4 === 0 ? "Legacy Kit" : "Renamed Later", qty: 1, unitPriceMinor: 1_000 + i }],
      issueDate: new Date(Date.UTC(my, mm - 1, ((i - 1) % 28) + 1, 9, 0, 0)).toISOString(),
    }),
  });
}
// rename AFTER the month sales so some snapshots show the old name
await f(`/api/v1/products/${prodRename}`, { method: "PATCH", headers: H, body: JSON.stringify({ name: "Prestige Kit" }) });

// ---- current-window sales ----
await mkSale({ customerId: cus1, daysAgo: 1, items: [{ productId: prodTwinA, name: "Twin Widget", unit: "pcs", qty: 3, unitPriceMinor: 10_000 }], paid: 15_000 });
await mkSale({ customerId: cus2, daysAgo: 2, items: [{ productId: prodTwinB, name: "Twin Widget", unit: "pcs", qty: 1, unitPriceMinor: 20_000 }] });
await mkSale({ customerId: cus3, daysAgo: 3, items: [{ productId: prodRename, name: "Prestige Kit", unit: "pcs", qty: 5, unitPriceMinor: 5_000 }], paid: 25_000 });
await mkSale({ customerId: cus1, daysAgo: 4, discountMinor: 10_000, items: [
  { name: "DiscountLineA", qty: 1, unitPriceMinor: 10_000 },
  { name: "DiscountLineB", qty: 1, unitPriceMinor: 20_000 },
  { name: "DiscountLineC", qty: 1, unitPriceMinor: 70_000 },
] });
await mkSale({ customerId: null, daysAgo: 5, items: [{ name: "Custom Legacy Line", qty: 2, unitPriceMinor: 7_000 }] });
await mkSale({ customerId: cus3, daysAgo: 12, items: [{ productId: prodTwinA, name: "Twin Widget", unit: "pcs", qty: 8, unitPriceMinor: 10_000 }], paid: 80_000 });
await mkSale({ customerId: cus1, daysAgo: 45, items: [{ productId: prodLow, name: "Low Stock Sensor", unit: "pcs", qty: 2, unitPriceMinor: 45_000 }] });
// future-dated (must NEVER appear in reports)
await mkSale({ customerId: cus3, daysAgo: -3, items: [{ name: "Future Line", qty: 1, unitPriceMinor: 88_000 }] });

// ---- expenses (8 categories, some paid) ----
await mkExpense({ supplierId: sup1, category: "Rent", amountMinor: 180_000, daysAgo: 2, paid: 180_000 });
await mkExpense({ supplierId: sup1, category: "Utilities", amountMinor: 62_000, daysAgo: 4, paid: 30_000 });
await mkExpense({ supplierId: sup1, category: "Marketing", amountMinor: 45_000, daysAgo: 6 });
await mkExpense({ supplierId: sup1, category: "Office Supplies", amountMinor: 21_500, daysAgo: 8, paid: 21_500 });
await mkExpense({ supplierId: sup1, category: "Software", amountMinor: 39_000, daysAgo: 10 });
await mkExpense({ supplierId: sup1, category: "Logistics", amountMinor: 27_300, daysAgo: 13, paid: 10_000 });
await mkExpense({ supplierId: sup1, category: "Insurance", amountMinor: 12_000, daysAgo: 16 });
await mkExpense({ supplierId: sup1, category: "Maintenance", amountMinor: 8_900, daysAgo: 20 });
await mkExpense({ supplierId: sup1, category: "Future Cat", amountMinor: 55_000, daysAgo: -2 });

// ---- summary ----
const counts = {
  sales: await db.sale.count({ where: { businessId: biz.id } }),
  expenses: await db.expense.count({ where: { businessId: biz.id } }),
  payments: await db.payment.count({ where: { businessId: biz.id } }),
  products: await db.product.count({ where: { businessId: biz.id } }),
  customers: await db.customer.count({ where: { businessId: biz.id } }),
};
console.log("visual fixture ready:", JSON.stringify({ businessId: biz.id, plan: "STARTER", month: MONTH, ...counts }));
await db.$disconnect();
