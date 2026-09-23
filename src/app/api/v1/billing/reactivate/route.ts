/**
 * POST /api/v1/billing/reactivate — undo a cancellation while the period
 * is still running (§45). EXPIRED subscriptions cannot be reactivated
 * here (renewal goes through change-plan — a deliberate, authorized
 * decision). Idempotent (§48). Role policy: OWNER/ADMIN only (§100).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { billingReactivateSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { reactivateSubscription } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage"); // OWNER/ADMIN only (§100)

  const rl = rateLimit(`billing:reactivate:${ctx.userId}`, 10, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many billing changes. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  await parseBody(req, billingReactivateSchema);
  const result = await reactivateSubscription(ctx.businessId, { actorId: ctx.userId });
  return ok(result);
});
