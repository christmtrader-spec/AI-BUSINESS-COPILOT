/**
 * GET /api/v1/billing/entitlements — resolved entitlements for the active
 * business, optionally with live usage vs limit (§66/§105).
 *
 * ?usage=1 counts current usage per LIMIT entitlement:
 *   CUSTOMERS_MAX → non-deleted customers
 *   PRODUCTS_MAX  → non-deleted products (deactivation ≠ deletion)
 *   TEAM_MEMBERS_MAX → active members incl. owner (invites excluded)
 *   BUSINESSES_MAX → businesses the user OWNS
 *
 * Powers the "over plan limit" state in the UI (§42/§89) — informational
 * only; every server gate re-checks independently (§24/§26).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { countEntitlementUsage, ENTITLEMENT_CODES, getEntitlementContext } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const bctx = await getEntitlementContext(ctx.businessId);
  const entitlements = Object.values(bctx.entitlements);

  const withUsage = new URL(req.url).searchParams.get("usage") === "1";
  const usage = withUsage
    ? await countEntitlementUsage(
        ctx.businessId,
        ctx.business.ownerId,
        ENTITLEMENT_CODES.filter((c) => bctx.entitlements[c].type === "LIMIT"),
      )
    : null;

  return ok({
    planCode: bctx.subscription.effectivePlanCode,
    entitled: bctx.subscription.entitled,
    status: bctx.subscription.status,
    entitlements,
    usage,
  });
});
