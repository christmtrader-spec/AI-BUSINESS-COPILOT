/**
 * GET /api/v1/billing/plan — the effective plan for the active business.
 * (§57) Convenience read; same tenant rules as /billing/subscription.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getBusinessSubscription } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const subscription = await getBusinessSubscription(ctx.businessId);
  return ok({ plan: subscription.plan, effectivePlanCode: subscription.effectivePlanCode });
});
