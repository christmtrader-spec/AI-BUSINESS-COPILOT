/**
 * POST /api/v1/billing/cancel — cancellation (§44): sets
 * cancelAtPeriodEnd + status CANCELED. Access continues until
 * currentPeriodEnd, then the subscription expires (lazy transition).
 * Idempotent (§48). Data is NEVER touched.
 *
 * Role policy: OWNER/ADMIN only (§100). Audited + evented inside the
 * service transaction.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { billingCancelSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { cancelSubscription } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage"); // OWNER/ADMIN only (§100)

  const rl = rateLimit(`billing:cancel:${ctx.userId}`, 10, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many billing changes. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  await parseBody(req, billingCancelSchema);
  const result = await cancelSubscription(ctx.businessId, { actorId: ctx.userId });
  return ok(result);
});
