/**
 * r136-qa-seed.mjs — R136 browser-QA fixture (STARTER plan + rich data).
 *
 * Seeds ONE self-contained persona so the R136 browser QA can exercise the
 * entitlement-gated surfaces (the perf panel / leader strip need
 * ADVANCED_REPORTS — FREE is false) and the attention line (a genuinely
 * low stock row) without touching Sara's deterministic smoke business.
 *
 * THE R131 LESSON IS LAW: the sweep pattern is registered in the SAME
 * round (r104-user-sweep.mjs gained `r136-qa-%@test.local` +
 * `R136 QA Shop` in this commit) — the fixture is never unsweepable.
 *
 * Run: bun scripts/r136-qa-seed.mjs   (idempotent per stamp)
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const STAMP = Date.now();
const EMAIL = `r136-qa-${STAMP}@test.local`;
const PW = "R136-QA-2026!";
const BIZ = `R136 QA Shop ${STAMP}`;

const hashPassword = (p) => hashSync(p, 10);

async function main() {
  const user = await db.user.create({
    data: {
      email: EMAIL,
      name: "R136 QA Persona",
      passwordHash: hashPassword(PW),
      emailVerifiedAt: new Date(),
    },
  });

  const business = await db.business.create({
    data: {
      name: BIZ,
      slug: `r136-qa-${STAMP}`,
      currencyCode: "EUR",
      timezone: "UTC",
      decimalPrecision: 2,
      ownerId: user.id,
    },
  });

  await db.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });

  // STARTER subscription (ADVANCED_REPORTS true) — the perf panel's gate.
  const starter = await db.plan.findFirst({ where: { code: "STARTER" } });
  if (!starter) throw new Error("STARTER plan missing — run the billing seed");
  await db.subscription.create({
    data: {
      businessId: business.id,
      planId: starter.id,
      status: "ACTIVE",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });

  // Products: one genuinely LOW (stockQty <= lowStockAt) for the attention
  // line; two healthy with distinct values for the leader strip.
  const p1 = await db.product.create({
    data: { businessId: business.id, name: "Lapis Coaster Set", salePriceMinor: 2400, costPriceMinor: 900, stockQty: 2, lowStockAt: 5, isActive: true },
  });
  const p2 = await db.product.create({
    data: { businessId: business.id, name: "Persian Rug Mini", salePriceMinor: 18500, costPriceMinor: 8000, stockQty: 12, lowStockAt: 5, isActive: true },
  });
  const p3 = await db.product.create({
    data: { businessId: business.id, name: "Brass Candle Holder", salePriceMinor: 6200, costPriceMinor: 2500, stockQty: 7, lowStockAt: 5, isActive: true },
  });

  const c1 = await db.customer.create({
    data: { businessId: business.id, name: "Ayla Boutique", email: "ayla@r136qa.local" },
  });
  const c2 = await db.customer.create({
    data: { businessId: business.id, name: "Cyrus Gallery", email: "cyrus@r136qa.local" },
  });

  const s1 = await db.supplier.create({
    data: { businessId: business.id, name: "Silk Road Wholesale" },
  });

  // Sales THIS month (the perf window default) — p2 leads net value.
  const mkSale = async (number, customer, item, qty, unit, daysAgo) => {
    const total = qty * unit;
    return db.sale.create({
      data: {
        businessId: business.id,
        number,
        customerId: customer.id,
        subtotalMinor: total,
        totalMinor: total,
        paidMinor: total,
        status: "PAID",
        issueDate: new Date(Date.now() - daysAgo * 86_400_000),
        items: {
          create: [{ productId: item.id, name: item.name, qty, unitPriceMinor: unit, lineTotalMinor: total }],
        },
      },
    });
  };
  await mkSale(1, c1, p2, 2, 18500, 2);
  await mkSale(2, c2, p3, 1, 6200, 5);
  await mkSale(3, c1, p1, 1, 2400, 9);

  // Expenses: one category-dominant + one supplier-attributed.
  await db.expense.create({
    data: { businessId: business.id, category: "Materials", amountMinor: 32000, spentAt: new Date(Date.now() - 3 * 86_400_000), note: "Silk + dye batch" },
  });
  const e2 = await db.expense.create({
    data: { businessId: business.id, category: "Shipping", amountMinor: 8500, spentAt: new Date(Date.now() - 6 * 86_400_000), supplierId: s1.id, note: "Freight" },
  });

  // R142 — Payment rows (the cashflow perf sub-view's source of truth:
  // "one payment row = one cash movement"). Without these the cashflow
  // grouping honestly reports zero — a seed gap, not a code bug. Two IN
  // (customer receipts at payment dates inside the window) + one OUT
  // (supplier payment for the freight expense).
  const sales = await db.sale.findMany({ where: { businessId: business.id }, orderBy: { number: "asc" } });
  await db.payment.create({
    data: { businessId: business.id, saleId: sales[0].id, direction: "IN", amountMinor: 37000, method: "BANK_TRANSFER", paidAt: new Date(Date.now() - 2 * 86_400_000), note: "Invoice 1 receipt" },
  });
  await db.payment.create({
    data: { businessId: business.id, saleId: sales[1].id, direction: "IN", amountMinor: 6200, method: "CASH", paidAt: new Date(Date.now() - 4 * 86_400_000), note: "Invoice 2 receipt" },
  });
  await db.payment.create({
    data: { businessId: business.id, expenseId: e2.id, direction: "OUT", amountMinor: 8500, method: "BANK_TRANSFER", paidAt: new Date(Date.now() - 5 * 86_400_000), note: "Freight paid" },
  });

  console.log(
    JSON.stringify({ email: EMAIL, password: PW, businessId: business.id, businessName: BIZ }, null, 2),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
