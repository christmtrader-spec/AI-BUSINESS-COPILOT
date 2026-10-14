#!/usr/bin/env node
/**
 * scripts/prompt49-aging-details-browser-fixture.mjs — Prompt 49 browser-QA
 * fixture (real dev server + real API, browser-consumable demo data).
 *
 * Creates ONE P49QB-prefixed business with:
 *   - two customers (distinct names) with open invoices across ALL FOUR
 *     aging buckets, one partially paid;
 *   - two suppliers with open expenses: stated past-due due date, a due-
 *     TODAY bill (never overdue §9), a no-due-date bill, and a future bill;
 *   - one PAID invoice + one PAID expense (excluded from open views);
 *   - a hostile-party-name customer (=HYPERLINK) is NOT created here —
 *     injection safety is covered by the E2E suite, the QA UI shows honest
 *     business-like names only.
 *
 * Idempotent: safe to re-run (purges its own prefix first).
 * Teardown: `--teardown` removes EVERYTHING including the fixture users.
 *
 * Run: bun scripts/prompt49-aging-details-browser-fixture.mjs [--teardown]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
const TAG = "P49QB";

const OWNER_EMAIL = `${TAG.toLowerCase()}-owner@test.local`;
const PASS = "testpass123";

async function purge({ withUsers }) {
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.subscription.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.business.deleteMany({ where: { id: b.id } });
  }
  if (withUsers) {
    const users = await db.user.findMany({ where: { email: OWNER_EMAIL }, select: { id: true } });
    for (const u of users) {
      await db.userSession.deleteMany({ where: { userId: u.id } });
      await db.auditLog.deleteMany({ where: { actorId: u.id } });
      await db.user.deleteMany({ where: { id: u.id } });
    }
  }
}

if (process.argv.includes("--teardown")) {
  await purge({ withUsers: true });
  const left = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  const users = await db.user.count({ where: { email: OWNER_EMAIL } });
  console.log(`P49QB TEARDOWN: businesses=${left} users=${users} (expect 0/0)`);
  await db.$disconnect();
  process.exit(left === 0 && users === 0 ? 0 : 1);
}

await purge({ withUsers: false });

const bcrypt = (await import("bcryptjs")).default;
let user = await db.user.findUnique({ where: { email: OWNER_EMAIL } });
if (!user) {
  user = await db.user.create({
    data: { email: OWNER_EMAIL, name: "P49QB Owner", passwordHash: bcrypt.hashSync(PASS, 4), locale: "en" },
  });
}
const biz = await db.business.create({
  data: {
    name: `${TAG}-Aging-QA-${Date.now()}`,
    slug: `${TAG.toLowerCase()}-aging-qa-${Date.now()}`,
    ownerId: user.id,
    currencyCode: "USD",
    currencySymbol: "$",
    decimalPrecision: 2,
    timezone: "Asia/Tehran",
    members: { create: { userId: user.id, role: "OWNER" } },
  },
});

// The FREE default plan carries CSV_EXPORT (verified) — attach it so the
// platform-wide "subscriptions == businesses" invariant holds for the fixture.
const freePlan = await db.plan.findFirst({ where: { code: "FREE" }, select: { id: true } });
if (freePlan) {
  const sub = await db.subscription.create({ data: { businessId: biz.id, planId: freePlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
  // p20 B3 billing auditability — EVERY subscription creation is auditable.
  await db.subscriptionEvent.create({
    data: {
      businessId: biz.id, subscriptionId: sub.id, type: "CREATED",
      toStatus: "ACTIVE", toPlanCode: freePlan.code,
      dataJson: JSON.stringify({ source: "p49-browser-fixture" }), actorId: user.id,
    },
  });
}
const customerA = await db.customer.create({ data: { businessId: biz.id, name: "Aurora Retail Group" } });
const customerB = await db.customer.create({ data: { businessId: biz.id, name: "Bluepeak Distribution" } });
const supplierA = await db.supplier.create({ data: { businessId: biz.id, name: "Cedarline Wholesale" } });
const supplierB = await db.supplier.create({ data: { businessId: biz.id, name: "Duskview Logistics" } });
const product = await db.product.create({
  data: { businessId: biz.id, name: "QA Widget", sku: "P49QB-W1", salePriceMinor: 10_000, costPriceMinor: 2_000, stockQty: 500 },
});

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const tehranDay = (days) => {
  const d = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
};

let saleNumber = 1;
async function sale({ customerId, qty, days, paid = 0 }) {
  const s = await db.sale.create({
    data: {
      businessId: biz.id, customerId, number: saleNumber++,
      subtotalMinor: qty * 10_000, discountMinor: 0, totalMinor: qty * 10_000,
      paidMinor: paid, status: paid === 0 ? "UNPAID" : "PARTIAL",
      issueDate: daysAgo(days),
      items: { create: { productId: product.id, name: "QA Widget", unit: "pcs", qty, unitPriceMinor: 10_000, lineTotalMinor: qty * 10_000 } },
    },
  });
  if (paid > 0) {
    await db.payment.create({ data: { businessId: biz.id, saleId: s.id, direction: "IN", method: "CASH", amountMinor: paid, paidAt: daysAgo(1) } });
  }
  return s.id;
}
async function expense({ supplierId, amountMinor, days, dueDay = null, paid = 0, reference = null }) {
  const e = await db.expense.create({
    data: {
      businessId: biz.id, supplierId, category: "QA Supplies",
      amountMinor, paidMinor: paid, status: paid === 0 ? "UNPAID" : "PARTIAL",
      spentAt: daysAgo(days),
      ...(dueDay ? { dueDate: new Date(`${dueDay}T12:00:00.000Z`) } : {}),
      ...(reference ? { reference } : {}),
    },
  });
  if (paid > 0) {
    await db.payment.create({ data: { businessId: biz.id, expenseId: e.id, direction: "OUT", method: "CASH", amountMinor: paid, paidAt: daysAgo(1) } });
  }
  return e.id;
}

// Receivables: every bucket populated, one partial payment.
await sale({ customerId: customerA.id, qty: 1, days: 8 });            // D0_30  100.00
await sale({ customerId: customerB.id, qty: 2, days: 22 });           // D0_30  200.00
await sale({ customerId: customerA.id, qty: 3, days: 45 });           // D31_60 300.00
await sale({ customerId: customerB.id, qty: 1, days: 33, paid: 5_000 }); // D31_60 50.00 outstanding
await sale({ customerId: customerA.id, qty: 2, days: 70 });           // D61_90 200.00
await sale({ customerId: customerB.id, qty: 4, days: 130 });          // D90_PLUS 400.00
await sale({ customerId: customerA.id, qty: 1, days: 60, paid: 10_000 }); // PAID → excluded

// Payables: past-due / due-today / no-due-date / future / partial.
await expense({ supplierId: supplierA.id, amountMinor: 150_000, days: 40, dueDay: tehranDay(-12) });          // D0_30 anchor=past-due due
await expense({ supplierId: supplierA.id, amountMinor: 250_000, days: 80, dueDay: tehranDay(0) });            // D61_90 due TODAY → not overdue
await expense({ supplierId: supplierB.id, amountMinor: 350_000, days: 120 });                                 // D90_PLUS no dueDate → never overdue
await expense({ supplierId: supplierB.id, amountMinor: 120_000, days: 50, dueDay: tehranDay(-47), paid: 20_000, reference: "BILL-DV-221" }); // D31_60 past-due partial
await expense({ supplierId: supplierB.id, amountMinor: 90_000, days: 5, dueDay: tehranDay(25) });             // D0_30 future due
await expense({ supplierId: supplierA.id, amountMinor: 60_000, days: 100, paid: 60_000 });                    // PAID → excluded

console.log(JSON.stringify({
  ok: true,
  ownerEmail: OWNER_EMAIL,
  password: PASS,
  businessId: biz.id,
  businessName: biz.name,
  customerIdA: customerA.id,
  supplierIdA: supplierA.id,
  deepLinks: {
    agingDetailsReceivables: `#/reports/aging-details?side=receivables`,
    agingDetailsPayables: `#/reports/aging-details?side=payables`,
    customerAging: `#/reports/aging-details?side=receivables&party=${customerA.id}`,
    supplierAging: `#/reports/aging-details?side=payables&party=${supplierA.id}`,
    payablesPastDue: `#/reports/aging-details?side=payables&pastDue=1`,
    bucketD90: `#/reports/aging-details?side=receivables&bucket=D90_PLUS`,
  },
}, null, 2));
await db.$disconnect();
