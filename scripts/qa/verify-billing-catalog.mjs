#!/usr/bin/env bun
/**
 * scripts/qa/verify-billing-catalog.mjs — catalog integrity guard.
 *
 * WHY: the billing catalog (Plan / EntitlementDefinition / PlanEntitlement /
 * PlanPrice) is seeded ONLY by the explicit seed scripts (§118 "Do not rely
 * on application startup") — it is NOT part of any migration. Any
 * `db:reset` / `migrate reset` / destructive `db:push` therefore wipes it,
 * and the app fail-CLOSES: business creation hits BUSINESSES_MAX limit 0
 * and the pricing page renders empty ("no place to upgrade").
 *
 * This guard fails loudly (exit 1) when the catalog is missing, printing
 * the exact repair commands. Run it after ANY database reset/rebuild, and
 * before/after QA sessions that touch the schema.
 *
 * Usage: bun scripts/qa/verify-billing-catalog.mjs
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const [plans, entitlements, planEntitlements, priceBooks, planPrices, businesses] = await Promise.all([
  db.plan.count(),
  db.entitlementDefinition.count(),
  db.planEntitlement.count(),
  db.priceBook.count(),
  db.planPrice.count(),
  db.business.count(),
]);

console.log(
  `[catalog-guard] Plan=${plans} EntitlementDefinition=${entitlements} ` +
    `PlanEntitlement=${planEntitlements} PriceBook=${priceBooks} PlanPrice=${planPrices} Business=${businesses}`
);

const problems = [];
if (plans === 0) problems.push("Plan table is EMPTY — the billing catalog is missing.");
if (entitlements === 0) problems.push("EntitlementDefinition table is EMPTY — limiters cannot resolve.");
if (planEntitlements === 0) problems.push("PlanEntitlement table is EMPTY — all plans have no limits/flags.");
if (plans > 0 && planPrices === 0)
  problems.push("PlanPrice is EMPTY — the pricing page has nothing to sell (no place to upgrade).");

// FREE plan must define BUSINESSES_MAX ≥ 1, otherwise even the FIRST business
// creation is blocked (limiter fails closed → owned 0 ≥ limit 0).
// P51-R1-FINAL: the guard now validates the BUSINESSES_MAX rows of EVERY
// plan against the runtime contract enforced by
// src/lib/billing/service.ts::assertWithinBusinessesLimitTx:
//   - the row's entitlement type must be LIMIT (a BOOLEAN-typed row is
//     malformed and would fail closed at runtime with BILLING_UNAVAILABLE);
//   - value null  = UNLIMITED (legitimate, e.g. ENTERPRISE — never rejected);
//   - value ≥ 1 integer = usable limit;
//   - value 0 / negative / malformed = catalog corruption → actionable fail.
if (plans > 0 && planEntitlements > 0) {
  const plansWithRows = await db.plan.findMany({
    select: {
      code: true,
      active: true,
      planEntitlements: {
        select: { value: true, entitlement: { select: { code: true, type: true } } },
      },
    },
  });

  const beOf = (p) => p.planEntitlements.find((pe) => pe.entitlement.code === "BUSINESSES_MAX");

  const free = plansWithRows.find((p) => p.code === "FREE");
  if (!free) {
    problems.push("FREE plan row is missing.");
  } else {
    const be = beOf(free);
    if (!be || (be.value ?? 0) < 1) {
      problems.push("FREE plan does not grant BUSINESSES_MAX ≥ 1 — first business creation is blocked.");
    }
  }

  for (const p of plansWithRows) {
    const be = beOf(p);
    if (!be) continue; // no BUSINESSES_MAX row on a plan is tolerated (runtime: contributes nothing)
    if (be.entitlement.type !== "LIMIT") {
      problems.push(
        `Plan ${p.code}: BUSINESSES_MAX entitlement type is "${be.entitlement.type}" (must be LIMIT) — runtime fails closed with BILLING_UNAVAILABLE.`,
      );
      continue;
    }
    if (be.value !== null && (!Number.isInteger(be.value) || be.value < 1)) {
      problems.push(
        `Plan ${p.code}: BUSINESSES_MAX value is ${JSON.stringify(be.value)} — zero/negative/malformed limits are invalid ` +
          `(null = unlimited, integer ≥ 1 = limit). Runtime fails closed with BILLING_UNAVAILABLE.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("[catalog-guard] FAIL — billing catalog is broken/incomplete:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("[catalog-guard] Repair with:");
  console.error("  bun scripts/seed-billing.ts     # plans + entitlements (idempotent)");
  console.error("  bun scripts/seed-pricing.ts     # EUR baseline prices (idempotent)");
  process.exit(1);
}

console.log("[catalog-guard] OK — billing catalog present and FREE plan can create ≥ 1 business.");
await db.$disconnect();
