/**
 * scripts/r147-qa-drill-fixture.mjs — R147 QA fixture (persona-scoped).
 *
 * Gives the R136 QA persona a NAMED rank-1 debtor and a NAMED rank-1
 * creditor so the outstanding drill chips can be exercised live:
 *   - one UNPAID sale for a new customer (the receivables leader);
 *   - one UNPAID expense for "Silk Road Wholesale" (lifts it past the
 *     unassigned $320 mass → the payables leader WITH a party id).
 * Everything rides the r136-qa- persona → swept by r104-user-sweep.mjs.
 */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const business = await db.business.findFirst({
  where: { name: { startsWith: "R136 QA Shop" } },
  orderBy: { createdAt: "desc" },
});
if (!business) throw new Error("no R136 QA persona business");
console.log("business:", business.id, business.name);

// 1) the debtor — an unpaid sale for a new customer (revenue $129.99).
const existingCustomer = await db.customer.findFirst({
  where: { businessId: business.id, name: "QA Drill Customer" },
});
const customer = existingCustomer
  ? existingCustomer
  : await db.customer.create({
      data: {
        businessId: business.id,
        name: "QA Drill Customer",
        email: `qa-drill-${Date.now()}@test.local`,
      },
    });
const today = new Date();
const saleNumber = Number(`${Date.now()}`.slice(-6));
const sale = await db.sale.create({
  data: {
    businessId: business.id,
    customerId: customer.id,
    number: saleNumber,
    issueDate: today,
    dueDate: new Date(today.getTime() + 14 * 864e5),
    status: "UNPAID",
    subtotalMinor: 12999,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 12999,
    paidMinor: 0,
    note: "R147 drill fixture — unpaid sale",
  },
});
console.log("debtor:", customer.name, sale.number, sale.totalMinor);

// 2) the creditor — an unpaid expense lifting Silk Road Wholesale to rank 1.
const supplier = await db.supplier.findFirst({
  where: { businessId: business.id, name: "Silk Road Wholesale" },
});
if (!supplier) throw new Error("Silk Road Wholesale supplier missing");
const expense = await db.expense.create({
  data: {
    businessId: business.id,
    supplierId: supplier.id,
    category: "Inventory Purchase",
    spentAt: today,
    status: "UNPAID",
    amountMinor: 50000,
    paidMinor: 0,
    note: "R147 drill fixture — unpaid bill",
  },
});
console.log("creditor:", supplier.name, expense.id, expense.amountMinor);

await db.$disconnect();
console.log("FIXTURE OK");
