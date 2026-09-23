/**
 * POST /api/v1/billing/trial — trial capability (§19), DISABLED BY DEFAULT.
 *
 * Prompt 20 implements the domain capability (startTrial/endTrial in the
 * service layer) but deliberately does NOT finalize business policy: no
 * automatic trials, no self-service UI. This endpoint only works when the
 * operator explicitly sets BILLING_TRIALS_ENABLED=1 — otherwise it returns
 * BUSINESS_NOT_ELIGIBLE. Role policy: OWNER/ADMIN only (§100).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { billingTrialSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { endTrial, startTrial } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage"); // OWNER/ADMIN only (§100)

  const rl = rateLimit(`billing:trial:${ctx.userId}`, 5, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many billing changes. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // §19: no trial policy without an explicit operator decision.
  if (process.env.BILLING_TRIALS_ENABLED !== "1") {
    throw new ApiError(
      422,
      "BUSINESS_NOT_ELIGIBLE",
      "Trials are not enabled for this deployment.",
    );
  }

  const input = await parseBody(req, billingTrialSchema);
  const result =
    input.action === "start"
      ? await startTrial(ctx.businessId, input.days, { actorId: ctx.userId, source: "api" })
      : await endTrial(ctx.businessId, { actorId: ctx.userId });
  return ok(result);
});
