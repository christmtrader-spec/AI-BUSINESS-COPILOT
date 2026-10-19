/**
 * Billing catalog SELF-HEAL — permanent fix for the recurring environmental
 * wipe of the billing catalog (the sandbox DB snapshot reverts restore a
 * state where User rows survive but Plan / EntitlementDefinition /
 * PlanEntitlement / PriceBook / PlanPrice are empty). Every such wipe made
 * business creation — and every entitlement gate — fail with the controlled
 * 503 BILLING_UNAVAILABLE: honest, but a dead end for the user, and it came
 * back every time the environment reverted.
 *
 * This module closes that loop permanently (user request: «این ارور را برای
 * همیشه درست کن»):
 *
 *   INSPECT — one cheap aggregate health check (all canonical plans present
 *             and complete? baseline price book present and priced?).
 *   HEAL    — re-seed the CANONICAL catalog from the single source of truth
 *             (src/lib/billing/catalog.ts) + the baseline price book
 *             (src/lib/payments/pricing-seed-data.ts) with the exact
 *             idempotent create-missing-only semantics of
 *             scripts/seed-billing.ts and scripts/seed-pricing.ts — existing
 *             rows are NEVER overwritten and nothing is ever deleted.
 *   AUDIT   — every actual repair writes a `billing.catalog_self_heal`
 *             audit row (businessId null — platform-level operation).
 *
 * Reconciliation with the P51-R1-FINAL fail-closed law (§68/§93):
 *   - MISSING / INCOMPLETE catalog (wipe damage) → self-heal, then the
 *     normal validation path runs against healthy canonical data.
 *   - PRESENT but MALFORMED values (FREE BUSINESSES_MAX = 0 / negative /
 *     BOOLEAN-typed rows, …) are deliberately NOT auto-repaired: the
 *     upserts create missing rows only, so value-level corruption still
 *     reaches the honest BILLING_UNAVAILABLE guards in service.ts.
 *     No fabricated limits, no silent value rewrites — ever.
 *
 * Concurrency: a single in-flight promise per process deduplicates
 * concurrent callers (startup instrumentation + business-create route +
 * entitlement-read retry); the seed itself is idempotent, so even a
 * cross-process race converges to the same canonical state.
 */

import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ENTITLEMENTS, PLANS } from "./catalog";
import { BASELINE_PRICE_BOOKS, type PriceBookSeed } from "@/lib/payments/pricing-seed-data";

export type BillingCatalogHealth = {
  healthy: boolean;
  plansMissing: string[];
  plansIncomplete: string[];
  entitlementDefinitionsCount: number;
  planEntitlementsCount: number;
  baselinePriceBooksMissing: string[];
};

function summarize(h: BillingCatalogHealth) {
  return {
    healthy: h.healthy,
    plansMissing: h.plansMissing,
    plansIncomplete: h.plansIncomplete,
    entitlementDefinitionsCount: h.entitlementDefinitionsCount,
    planEntitlementsCount: h.planEntitlementsCount,
    baselinePriceBooksMissing: h.baselinePriceBooksMissing,
  };
}

/** Cheap read-only catalog health probe (safe to call on every request). */
export async function inspectBillingCatalog(): Promise<BillingCatalogHealth> {
  const plans = await db.plan.findMany({
    select: { code: true, _count: { select: { planEntitlements: true } } },
  });
  const byCode = new Map(plans.map((p) => [p.code, p]));
  const plansMissing: string[] = [];
  const plansIncomplete: string[] = [];
  for (const spec of PLANS) {
    const row = byCode.get(spec.code);
    if (!row) {
      plansMissing.push(spec.code);
      continue;
    }
    if (row._count.planEntitlements !== ENTITLEMENTS.length) {
      plansIncomplete.push(spec.code);
    }
  }

  const books = await db.priceBook.findMany({
    select: { code: true, version: true, _count: { select: { prices: true } } },
  });
  const bookKey = (code: string, version: string) => `${code}/${version}`;
  const present = new Map(books.map((b) => [bookKey(b.code, b.version), b]));
  const baselinePriceBooksMissing: string[] = [];
  for (const seed of BASELINE_PRICE_BOOKS) {
    const row = present.get(bookKey(seed.code, seed.version));
    // 3 purchasable plans × 2 periods; retired prices (active=false) are
    // history and never count toward completeness.
    if (!row || row._count.prices < seed.prices.length * 2) {
      baselinePriceBooksMissing.push(bookKey(seed.code, seed.version));
    }
  }

  const [entitlementDefinitionsCount, planEntitlementsCount] = await Promise.all([
    db.entitlementDefinition.count(),
    db.planEntitlement.count(),
  ]);

  const healthy =
    plansMissing.length === 0 &&
    plansIncomplete.length === 0 &&
    baselinePriceBooksMissing.length === 0;

  return {
    healthy,
    plansMissing,
    plansIncomplete,
    entitlementDefinitionsCount,
    planEntitlementsCount,
    baselinePriceBooksMissing,
  };
}

/** Baseline price book seed — mirrors scripts/seed-pricing.ts §28 exactly:
 *  create missing books/prices with deterministic ids, NEVER overwrite an
 *  existing amount (a mismatch is reported, a price change is a NEW version). */
async function ensureBaselinePriceBook(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  seed: PriceBookSeed,
): Promise<void> {
  const existing = await tx.priceBook.findUnique({
    where: { code_version: { code: seed.code, version: seed.version } },
    include: { prices: true },
  });

  let book = existing;
  if (!book) {
    book = await tx.priceBook.create({
      data: {
        id: seed.id,
        code: seed.code,
        version: seed.version,
        currency: seed.currency,
        active: true, // the baseline book is the active catalog (seed-pricing default)
        description: seed.description,
      },
      include: { prices: true },
    });
  }

  for (const p of seed.prices) {
    for (const [period, amount] of [
      ["MONTHLY", p.monthlyMinor],
      ["YEARLY", p.yearlyMinor],
    ] as const) {
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(`baseline price ${seed.code}/${p.planCode}/${period} is not a positive integer`);
      }
      const row = book.prices.find((r) => r.planCode === p.planCode && r.billingPeriod === period);
      if (!row) {
        await tx.planPrice.create({
          data: {
            priceBookId: book.id,
            planCode: p.planCode,
            billingPeriod: period,
            amountMinor: amount,
            active: true,
          },
        });
      } else if (row.amountMinor !== amount) {
        // §28/§36 — never overwrite a stored amount; report and move on.
        console.warn(
          JSON.stringify({
            event: "billing.self_heal.price_mismatch_left_untouched",
            level: "warn",
            service: "ai-business-copilot",
            detail: `${p.planCode}/${period}: stored ${row.amountMinor} ≠ baseline ${amount}`,
          }),
        );
      }
    }
  }
}

/** Idempotent canonical catalog seed — the transactional core of the heal.
 *  Mirrors scripts/seed-billing.ts (upsert create-missing-only) plus the
 *  baseline price books, inside ONE Serializable transaction. */
async function seedCanonicalCatalog(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
): Promise<void> {
  for (const spec of ENTITLEMENTS) {
    await tx.entitlementDefinition.upsert({
      where: { code: spec.code },
      create: {
        code: spec.code,
        type: spec.type,
        unit: spec.unit,
        description: spec.description,
      },
      update: {}, // existing definitions keep their stored description/unit
    });
  }

  for (const plan of PLANS) {
    const row = await tx.plan.upsert({
      where: { code: plan.code },
      create: {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        sortOrder: plan.sortOrder,
        isPublic: plan.isPublic,
        active: true,
      },
      update: {}, // never overwrite a seeded plan
    });

    for (const spec of ENTITLEMENTS) {
      const entitlement = await tx.entitlementDefinition.findUnique({
        where: { code: spec.code },
      });
      if (!entitlement) {
        throw new Error(`EntitlementDefinition ${spec.code} missing after seed`);
      }
      const value = plan.entitlements[spec.code];
      const data =
        spec.type === "LIMIT"
          ? { value: value as number | null, boolValue: false }
          : { value: null, boolValue: value as boolean };
      await tx.planEntitlement.upsert({
        where: { planId_entitlementId: { planId: row.id, entitlementId: entitlement.id } },
        create: { planId: row.id, entitlementId: entitlement.id, ...data },
        update: {}, // idempotent: existing mapping stays
      });
    }
  }

  for (const seed of BASELINE_PRICE_BOOKS) {
    await ensureBaselinePriceBook(tx, seed);
  }
}

let inFlight: Promise<BillingCatalogHealth> | null = null;

/**
 * Ensure the billing catalog is present and complete — heal (idempotent
 * canonical re-seed) when it is not. Returns the post-call health. Throws
 * only when the heal itself failed AND the catalog is still broken; callers
 * that must never block on the heal can catch and let the fail-closed
 * guards produce the honest controlled error.
 */
export async function ensureBillingCatalog(source: string): Promise<BillingCatalogHealth> {
  if (inFlight) return inFlight;
  inFlight = runHeal(source).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runHeal(source: string): Promise<BillingCatalogHealth> {
  const before = await inspectBillingCatalog();
  if (before.healthy) return before;

  console.warn(
    JSON.stringify({
      event: "billing.catalog_self_heal_start",
      level: "warn",
      service: "ai-business-copilot",
      source,
      before: summarize(before),
    }),
  );

  await db.$transaction(
    async (tx) => {
      await seedCanonicalCatalog(tx);
    },
    { isolationLevel: "Serializable", timeout: 30_000, maxWait: 5_000 },
  );

  const after = await inspectBillingCatalog();
  await audit({
    businessId: null,
    action: "billing.catalog_self_heal",
    entityType: "Plan",
    entityId: null,
    before: summarize(before),
    after: summarize(after),
  });

  if (!after.healthy) {
    throw new Error(
      `billing catalog self-heal did not restore a complete catalog (missing=${after.plansMissing.join(",") || "none"}, incomplete=${after.plansIncomplete.join(",") || "none"}, books=${after.baselinePriceBooksMissing.join(",") || "none"})`,
    );
  }

  console.warn(
    JSON.stringify({
      event: "billing.catalog_self_healed",
      level: "warn",
      service: "ai-business-copilot",
      source,
      plans: PLANS.length,
      entitlements: ENTITLEMENTS.length,
    }),
  );
  return after;
}

/**
 * Read-retry helper: heal ONLY when the catalog is actually missing or
 * incomplete, and report whether it ended healthy. Never throws — the
 * caller proceeds with its original error when this returns false.
 */
export async function tryHealBillingCatalog(source: string): Promise<boolean> {
  try {
    const before = await inspectBillingCatalog();
    if (before.healthy) return false; // healthy catalog → the error is unrelated
    const after = await ensureBillingCatalog(source);
    return after.healthy;
  } catch {
    return false;
  }
}
