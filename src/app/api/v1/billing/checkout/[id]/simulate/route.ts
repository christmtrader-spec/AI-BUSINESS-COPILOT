/**
 * POST /api/v1/billing/checkout/[id]/simulate — sandbox driver (Prompt 22).
 *
 * MOCK PROVIDER ONLY. Builds the byte-identical gateway request for the
 * requested outcome (signed body + headers) and pushes it through the REAL
 * verification → idempotent fulfillment pipeline, so the sandbox checkout
 * dialog exercises the exact production webhook contract.
 *
 * Security: OWNER/ADMIN only; the session must belong to the caller's
 * business; PENDING-only (409 otherwise); audited.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { billingSimulateSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { simulateWebhook } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const POST = route(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await getAuthContext(req);
    requirePermission(ctx, "settings:manage");

    const rl = rateLimit(`billing:simulate:${ctx.userId}`, 30, 60_000);
    if (!rl.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Too many simulation attempts.", {
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const { id } = await params;
    const { outcome } = await parseBody(req, billingSimulateSchema);
    const session = await simulateWebhook(ctx.businessId, id, outcome, { actorId: ctx.userId });
    return ok({ checkoutSession: session });
  },
);
