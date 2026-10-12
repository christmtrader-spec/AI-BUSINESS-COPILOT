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
import { recordCommercialEvent } from "@/lib/billing/events";

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

  // §19: no trial policy without an explicit operator decision. ONE gate,
  // ONE truth: the canonical trial config (BILLING_TRIALS_ENABLED=true +
  // BILLING_TRIAL_DAYS + BILLING_TRIAL_PLAN — trial-config.ts) is the
  // single policy authority. The legacy `=== "1"` literal here predated
  // the canonical config and contradicted it after the sandbox env restore
  // (the newer /trial/start route already follows this contract).
  const { getTrialConfig } = await import("@/lib/billing/trial-config");
  if (!getTrialConfig().enabled) {
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

  // Prompt 46 canonical funnel law: trial starts flow through the ONE
  // CommercialEvent ledger (idempotent per business via the SAME dedupeKey
  // contract as the canonical /trial/start route — a second start attempt
  // can never inflate the funnel). Fire-and-forget: the trial decision is
  // never blocked by ledger writes.
  if (input.action === "start") {
    void recordCommercialEvent({
      eventType: "TRIAL_STARTED",
      userId: ctx.userId,
      businessId: ctx.businessId,
      planCode: result?.subscription?.plan?.code ?? null,
      source: "api",
      dedupeKey: `trial-start:${ctx.businessId}`,
    });
  }

  return ok(result);
});
