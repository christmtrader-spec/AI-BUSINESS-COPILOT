/**
 * POST /api/v1/billing/change-plan — internal plan switch (§41/§43/§82).
 *
 * ⚠️ NO PAYMENT (§83): this is the domain-level state transition mechanism
 * required by Prompt 20. It never charges money, never creates fake
 * transaction records, and nothing is labeled "payment successful".
 *
 * Security (§54/§98/§100):
 * - authenticated + membership-verified business context (never a
 *   browser-supplied businessId)
 * - role policy: OWNER and ADMIN only (`settings:manage`); STAFF/MANAGER/
 *   ACCOUNTANT/VIEWER are denied
 * - zod-validated plan code; unknown/inactive codes → INVALID_PLAN
 * - rate limited; audited (billing.plan_changed) + SubscriptionEvent —
 *   both written inside the service's transaction
 * - idempotent: same plan → no-op (§48)
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { changePlanSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { changePlan, invalidateBillingCache } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage"); // OWNER/ADMIN only (§100)

  const rl = rateLimit(`billing:change:${ctx.userId}`, 10, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many billing changes. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, changePlanSchema);
  const result = await changePlan(ctx.businessId, input.planCode, {
    actorId: ctx.userId,
    source: "settings",
  });
  invalidateBillingCache(ctx.businessId); // §60/§111 — belt & braces

  return ok(result);
});
