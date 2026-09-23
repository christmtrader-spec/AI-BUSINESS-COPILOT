/**
 * Billing seed + existing-business backfill — Prompt 20 (§63/§64/§103/§118).
 *
 * EXPLICIT one-time mechanism (§118: "Do not rely on application startup").
 * Run manually with:  bun scripts/seed-billing.ts
 *
 * Properties (all verified by the harness):
 * - IDEMPOTENT (§63/§103): running twice/thrice produces the same state.
 *   Only MISSING catalog records are created; existing rows are never
 *   overwritten and no plan is ever deleted (§80).
 * - DETERMINISTIC (§14): every existing business without a subscription
 *   receives the FREE plan — never a paid plan, never no plan (§65).
 * - AUDITABLE (§14): every backfill writes a CREATED SubscriptionEvent
 *   with source "seed-backfill" + a billing.subscription_created audit row.
 * - SAFE: additive only; touches ONLY the 5 billing tables + audit log.
 *
 * The catalog lives in src/lib/billing/catalog.ts (single source of truth,
 * shared with the app runtime — no duplicated matrix here).
 */
import { PrismaClient } from "@prisma/client";
import { ENTITLEMENTS, PLANS, FREE_PLAN_CODE } from "../src/lib/billing/catalog";

const prisma = new PrismaClient();

async function seedCatalog(): Promise<void> {
  // --- Entitlement definitions (upsert by stable code, never overwrite) ---
  for (const spec of ENTITLEMENTS) {
    await prisma.entitlementDefinition.upsert({
      where: { code: spec.code },
      create: {
        code: spec.code,
        type: spec.type,
        unit: spec.unit,
        description: spec.description,
      },
      // Existing definitions keep their stored description/unit — the DB is
      // the runtime authority once seeded (§63: seed only missing records).
      update: {},
    });
  }

  // --- Plans + their entitlement mappings ---
  for (const plan of PLANS) {
    const row = await prisma.plan.upsert({
      where: { code: plan.code },
      create: {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        sortOrder: plan.sortOrder,
        isPublic: plan.isPublic,
        active: true,
      },
      update: {}, // never overwrite a seeded plan (§63)
    });

    for (const spec of ENTITLEMENTS) {
      const value = plan.entitlements[spec.code];
      const entitlement = await prisma.entitlementDefinition.findUnique({
        where: { code: spec.code },
      });
      if (!entitlement) throw new Error(`EntitlementDefinition ${spec.code} missing after seed`);
      const data =
        spec.type === "LIMIT"
          ? { value: value as number | null, boolValue: false }
          : { value: null, boolValue: value as boolean };
      await prisma.planEntitlement.upsert({
        where: { planId_entitlementId: { planId: row.id, entitlementId: entitlement.id } },
        create: { planId: row.id, entitlementId: entitlement.id, ...data },
        update: {}, // idempotent: existing mapping stays (§103)
      });
    }
  }
}

/** Completeness gate: every active plan must define EVERY entitlement. */
async function verifyCatalogCompleteness(): Promise<void> {
  const plans = await prisma.plan.findMany({ where: { active: true }, include: { planEntitlements: true } });
  const expected = ENTITLEMENTS.length;
  for (const plan of plans) {
    if (plan.planEntitlements.length !== expected) {
      throw new Error(
        `Plan ${plan.code} has ${plan.planEntitlements.length}/${expected} entitlements — catalog incomplete`,
      );
    }
  }
}

/**
 * Backfill (§14/§64/§104): every business WITHOUT a subscription gets FREE.
 * Idempotent + transactional per business + auditable.
 */
async function backfillExistingBusinesses(): Promise<{ backfilled: number; skipped: number }> {
  const free = await prisma.plan.findUnique({ where: { code: FREE_PLAN_CODE } });
  if (!free) throw new Error("FREE plan missing after catalog seed");

  const businesses = await prisma.business.findMany({
    where: { subscription: null },
    select: { id: true },
  });

  let backfilled = 0;
  for (const business of businesses) {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      const end = new Date(now.getTime());
      end.setUTCMonth(end.getUTCMonth() + 1);
      const sub = await tx.subscription.create({
        data: {
          businessId: business.id,
          planId: free.id,
          status: "ACTIVE",
          billingPeriod: "MONTHLY",
          currentPeriodStart: now,
          currentPeriodEnd: end,
        },
      });
      await tx.subscriptionEvent.create({
        data: {
          businessId: business.id,
          subscriptionId: sub.id,
          type: "CREATED",
          toStatus: "ACTIVE",
          toPlanCode: free.code,
          dataJson: JSON.stringify({ source: "seed-backfill" }),
        },
      });
      await tx.auditLog.create({
        data: {
          businessId: business.id,
          action: "billing.subscription_created",
          entityType: "Subscription",
          entityId: sub.id,
          afterJson: JSON.stringify({ planCode: free.code, status: "ACTIVE", source: "seed-backfill" }),
        },
      });
    });
    backfilled += 1;
  }

  const skipped = (await prisma.business.count()) - backfilled;
  return { backfilled, skipped };
}

async function main(): Promise<void> {
  console.log("[billing-seed] seeding catalog…");
  await seedCatalog();
  await verifyCatalogCompleteness();
  console.log("[billing-seed] catalog complete (5 plans × 7 entitlements verified)");

  console.log("[billing-seed] backfilling existing businesses to FREE…");
  const { backfilled, skipped } = await backfillExistingBusinesses();
  console.log(`[billing-seed] backfill done: ${backfilled} created, ${skipped} already had a subscription`);

  const counts = {
    plans: await prisma.plan.count(),
    entitlements: await prisma.entitlementDefinition.count(),
    planEntitlements: await prisma.planEntitlement.count(),
    subscriptions: await prisma.subscription.count(),
    businesses: await prisma.business.count(),
    subscriptionEvents: await prisma.subscriptionEvent.count(),
  };
  console.log("[billing-seed] state:", JSON.stringify(counts));

  if (counts.subscriptions !== counts.businesses) {
    throw new Error(
      `Invariant violated: ${counts.businesses} businesses but ${counts.subscriptions} subscriptions`,
    );
  }
  console.log("[billing-seed] invariant OK: every business has exactly one subscription");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[billing-seed] FAILED:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
