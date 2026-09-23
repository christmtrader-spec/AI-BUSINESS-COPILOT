/**
 * GET /api/v1/billing/subscription — the active business's subscription.
 *
 * Prompt 20 (§50/§51/§55/§57): read-only inspection for ordinary members.
 * Every role with settings:read may see the CURRENT business's plan and
 * status (§55); nothing from another business is ever resolvable here —
 * the businessId comes exclusively from the membership-verified context
 * (§98/§99: no browser-supplied businessId is trusted).
 *
 * UI convenience only — the SERVER re-verifies every entitlement at every
 * gate regardless of what this returns (§24/§26).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getEntitlementContext } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const bctx = await getEntitlementContext(ctx.businessId);
  return ok({
    subscription: bctx.subscription,
    entitlements: Object.values(bctx.entitlements),
  });
});
