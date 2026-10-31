#!/usr/bin/env node
/**
 * r156-qa-seed.mjs — R156 browser-QA fixture (STARTER plan + MULTI-MONTH data).
 *
 * WHY A NEW PERSONA: the sandbox DB reverted — every QA persona is gone.
 * The perf panel needs ADVANCED_REPORTS (FREE is false) AND, for the R156
 * month-rows drill, month groupings with ≥2 DISTINCT months (the r136 seed
 * only ever had current-month data — its month table had a single row).
 *
 * THE R131 LESSON IS LAW: the sweep pattern is registered in the SAME round
 * (r104-user-sweep.mjs gains `r156-qa%@test.local` + "R156 QA Shop" in this
 * commit) — the fixture is never unsweepable.
 *
 * FIXED identity (unlike r136's per-run stamp): re-running reuses the SAME
 * persona and tops up data only when missing — the QA journeys can hardcode
 * the login.
 *
 * Transactional rows (sales/expenses) go through PRISMA-direct here, the
 * r136 precedent — this fixture runs BEFORE the dev server boots its QA
 * session and must never consume rate limits; the UI journeys remain the
 * API's proof surface.
 *
 * Run: bun scripts/r156-qa-seed.mjs   (idempotent)
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const EMAIL = "r156-qa@test.local";
const PW = "R156-QA-2026!";
const BIZ = "R156 QA Shop";

let passed = 0;
let failed = 0;
const ok = (name, cond, info = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
};

async function main() {
  // ---- persona + business (fixed identity, upsert semantics) ----------------
  let user = await db.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    user = await db.user.create({
      data: {
        email: EMAIL,
        name: "R156 QA Persona",
        passwordHash: hashSync(PW, 10),
        emailVerifiedAt: new Date(),
      },
    });
  }
  ok("persona present", !!user?.id, EMAIL);

  let business = await db.business.findFirst({
    where: { name: BIZ, ownerId: user.id },
  });
  if (!business) {
    business = await db.business.create({
      data: {
        name: BIZ,
        slug: `r156-qa-shop-${user.id.slice(-8).toLowerCase()}`,
        currencyCode: "EUR",
        timezone: "UTC",
        decimalPrecision: 2,
        ownerId: user.id,
      },
    });
    await db.businessMember.create({
      data: { businessId: business.id, userId: user.id, role: "OWNER" },
    });
  }
  ok("business present", !!business?.id, BIZ);

  // STARTER subscription (ADVANCED_REPORTS true) — the perf panel's gate.
  const subs = await db.subscription.count({ where: { businessId: business.id, status: "ACTIVE" } });
  if (subs === 0) {
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
  }
  ok("ACTIVE subscription present", true, "STARTER (ADVANCED_REPORTS)");

  // ---- data (top-up only when missing) ---------------------------------------
  const saleCount = await db.sale.count({ where: { businessId: business.id } });
  if (saleCount >= 6) {
    console.log(`— business already carries ${saleCount} sales; data seed SKIPPED (idempotent)`);
  } else {
    const p1 = await db.product.create({
      data: { businessId: business.id, name: "Qashqai Weaver Bag", salePriceMinor: 9500, costPriceMinor: 4200, stockQty: 14, lowStockAt: 5, isActive: true },
    });
    const p2 = await db.product.create({
      data: { businessId: business.id, name: "Isfahan Silk Tile", salePriceMinor: 45000, costPriceMinor: 21000, stockQty: 8, lowStockAt: 5, isActive: true },
    });
    const p3 = await db.product.create({
      data: { businessId: business.id, name: "Turquoise Inlay Box", salePriceMinor: 12800, costPriceMinor: 5400, stockQty: 6, lowStockAt: 5, isActive: true },
    });

    // Six sales across THREE months (the month table needs ≥2 rows; the day
    // table needs its own spread). paid-in-full PAID sales, r136 shape.
    const mkSale = async (number, item, qty, unit, iso) => {
      const total = qty * unit;
      return db.sale.create({
        data: {
          businessId: business.id,
          number,
          subtotalMinor: total,
          totalMinor: total,
          paidMinor: total,
          status: "PAID",
          issueDate: new Date(iso),
          items: {
            create: [{ productId: item.id, name: item.name, qty, unitPriceMinor: unit, lineTotalMinor: total }],
          },
        },
      });
    };
    await mkSale(1, p2, 1, 45000, "2026-10-05T10:00:00.000Z");
    await mkSale(2, p1, 2, 9500, "2026-10-12T11:30:00.000Z");
    await mkSale(3, p2, 2, 45000, "2026-10-20T16:45:00.000Z");
    await mkSale(4, p3, 3, 12800, "2026-09-03T09:15:00.000Z");
    await mkSale(5, p1, 5, 9500, "2026-09-18T14:00:00.000Z");
    await mkSale(6, p2, 1, 47500, "2026-08-09T13:20:00.000Z");

    // Expenses: the R155 Materials facet row + three months of spread.
    await db.expense.create({ data: { businessId: business.id, category: "Materials", amountMinor: 32000, spentAt: new Date("2026-10-07T09:00:00.000Z") } });
    await db.expense.create({ data: { businessId: business.id, category: "Shipping", amountMinor: 8500, spentAt: new Date("2026-10-15T12:00:00.000Z") } });
    await db.expense.create({ data: { businessId: business.id, category: "Materials", amountMinor: 15000, spentAt: new Date("2026-09-11T10:30:00.000Z") } });
    await db.expense.create({ data: { businessId: business.id, category: "Rent", amountMinor: 70000, spentAt: new Date("2026-08-21T08:45:00.000Z") } });

    ok("seeded 6 sales across 2026-08/09/10", true);
    ok("seeded 4 expenses (Materials×2, Shipping, Rent)", true);
  }

  console.log(`\nfixture: ${passed} passed, ${failed} failed`);
  console.log(`persona : ${EMAIL} / ${PW} — business "${BIZ}" (${business.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
