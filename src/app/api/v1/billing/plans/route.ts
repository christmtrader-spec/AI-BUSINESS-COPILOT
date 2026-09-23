/**
 * GET /api/v1/billing/plans — the internal plan catalog for the switching
 * UI (§37/§96). Returns active+public plans with their entitlements so the
 * Settings → Subscription view can render a comparison. NO prices exist
 * (§39/§40) and NO checkout is built — switching is an internal no-payment
 * mechanism clearly labeled as such in the UI (§82/§83).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { ENTITLEMENTS } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const plans = await db.plan.findMany({
    where: { active: true, isPublic: true },
    orderBy: { sortOrder: "asc" },
    include: { planEntitlements: { include: { entitlement: true } } },
  });

  return ok({
    definitions: ENTITLEMENTS,
    plans: plans.map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description,
      sortOrder: p.sortOrder,
      // ENTERPRISE is customizable per customer (§38) — shown in the catalog
      // but NOT offered through the self-service switcher.
      selfService: p.code !== "ENTERPRISE",
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
