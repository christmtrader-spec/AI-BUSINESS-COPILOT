/**
 * GET /api/v1/billing/plans — the internal plan catalog for the switching
 * UI (§37/§96). Returns active+public plans with their entitlements so the
 * Settings → Subscription view can render a comparison.
 *
 * Prompt 22: paid plans now also carry SERVER-AUTHORITATIVE pricing from
 * src/lib/payments/pricing.ts (monthlyMinor/yearlyMinor/currency) so the
 * UI can show prices without ever inventing amounts client-side. The
 * no-payment internal switch (§82/§83) REMAINS available — the payment
 * path is additive, not a replacement.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { ENTITLEMENTS } from "@/lib/billing";
import { priceCatalog, SETTLEMENT_CURRENCY } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const plans = await db.plan.findMany({
    where: { active: true, isPublic: true },
    orderBy: { sortOrder: "asc" },
    include: { planEntitlements: { include: { entitlement: true } } },
  });

  const prices = new Map<string, { monthlyMinor: number; yearlyMinor: number; currency: string }>(
    priceCatalog().map((p) => [p.planCode as string, p]),
  );

  return ok({
    definitions: ENTITLEMENTS,
    // Prompt 22 — settlement currency is the plan-catalog currency (EUR),
    // independent of each business's display currency.
    settlementCurrency: SETTLEMENT_CURRENCY,
    plans: plans.map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description,
      sortOrder: p.sortOrder,
      // ENTERPRISE is customizable per customer (§38) — shown in the catalog
      // but NOT offered through the self-service switcher.
      selfService: p.code !== "ENTERPRISE",
      pricing: prices.has(p.code)
        ? {
            monthlyMinor: prices.get(p.code)!.monthlyMinor,
            yearlyMinor: prices.get(p.code)!.yearlyMinor,
            currency: prices.get(p.code)!.currency,
          }
        : null,
      // LIMIT: number | null = unlimited; BOOLEAN: boolean.
      entitlements: Object.fromEntries(
        p.planEntitlements.map((pe) => [
          pe.entitlement.code,
          pe.entitlement.type === "LIMIT" ? pe.value : pe.boolValue,
        ]),
      ),
    })),
  });
});
