/**
 * POST /api/v1/billing/checkout — Prompt 22 payment provider abstraction.
 *
 * Creates a checkout session for a PAID plan (STARTER/BUSINESS/PRO). The
 * browser supplies only { planCode, billingPeriod } — the amount is
 * resolved server-side from the price catalog and snapshotted on the
 * session; the provider is the registry's default (sandbox "mock" today).
 *
 * Security (mirrors change-plan discipline):
 * - authenticated + membership context (never a browser businessId)
 * - OWNER/ADMIN only (`settings:manage`)
 * - rate limited; audited (billing.checkout_created)
 * - FREE → 422 (nothing to buy); ENTERPRISE → 422 (not self-service §38)
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { billingCheckoutSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { createCheckout } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage");

  const rl = rateLimit(`billing:checkout:${ctx.userId}`, 10, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many checkout attempts. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, billingCheckoutSchema);
  const session = await createCheckout(ctx.businessId, input, { actorId: ctx.userId });
  return ok({ checkoutSession: session }, 201);
});
