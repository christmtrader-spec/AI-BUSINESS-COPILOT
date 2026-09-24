/**
 * GET /api/v1/billing/plans — the internal plan catalog for the switching
 * UI (§37/§96). Returns active+public plans with their entitlements so the
 * Settings → Subscription view can render a comparison.
 *
 * Prompt 24 §40/§92 — prices come from the PricingService (database-backed
 * price books), are currency-aware and resolve ONLY active, currently-
 * effective versions. Optional `?currency=EUR|IRR` names the settlement
 * currency explicitly; anything else falls back to the deployment default
 * (never the browser locale). Arbitrary currency codes are rejected
 * (§41); plans without a price in the requested currency are reported
 * honestly as NOT_PRICED (§52/§53) — never zero, never converted.
 *
 * The no-payment internal switch (§82/§83) REMAINS available — the payment
 * path is additive, not a replacement.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { ENTITLEMENTS } from "@/lib/billing";
import { priceCatalogForCurrency } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  // §41/§92 — validate the optional currency parameter (3-letter code;
  // allowlist + book existence are enforced by the PricingService).
  const currencyParam = new URL(req.url).searchParams.get("currency") ?? undefined;
  const catalog = await priceCatalogForCurrency(currencyParam ?? undefined);

  const plans = await db.plan.findMany({
    where: { active: true, isPublic: true },
    orderBy: { sortOrder: "asc" },
    include: { planEntitlements: { include: { entitlement: true } } },
  });

  return ok({
    definitions: ENTITLEMENTS,
    // Prompt 24 — the settlement currency THIS catalog is priced in
    // (explicit parameter or the documented deployment default — §42).
    settlementCurrency: catalog.currency,
    // Currencies that currently have an active, effective price book (§92).
    supportedCurrencies: catalog.supportedCurrencies,
    plans: plans.map((p) => {
      const item = catalog.byPlan.get(p.code);
      return {
        code: p.code,
        name: p.name,
        description: p.description,
        sortOrder: p.sortOrder,
        // ENTERPRISE is customizable per customer (§38) — shown in the
        // catalog but NOT offered through the self-service switcher.
        selfService: p.code !== "ENTERPRISE",
        // Prompt 24 §52 — honest availability in THIS currency.
        availability: item?.availability ?? "NOT_PRICED",
        pricing: item?.pricing ?? null,
        // LIMIT: number | null = unlimited; BOOLEAN: boolean.
        entitlements: Object.fromEntries(
          p.planEntitlements.map((pe) => [
            pe.entitlement.code,
            pe.entitlement.type === "LIMIT" ? pe.value : pe.boolValue,
          ]),
        ),
      };
    }),
  });
});
