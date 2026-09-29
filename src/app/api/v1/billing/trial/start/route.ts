/**
 * POST /api/v1/billing/trial/start — Prompt 25.
 *
 * Start the configured free trial for the ACTIVE business. OWNER/ADMIN only
 * (settings:manage). The trial capability, plan snapshot, one-trial-per-
 * business rule and current-state checks are ALL re-validated server-side.
 * Idempotent: a repeated call returns the existing valid trial instead of
 * duplicating anything.
 *
 * A trial is NEVER created without an existing business — the funnel order
 * pricing → signup → business → trial is enforced by construction.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { startBusinessTrial } from "@/lib/billing/trial";
import { recordCommercialEvent } from "@/lib/billing/events";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  // Trial = a commercial decision about the business → OWNER/ADMIN only.
  requirePermission(ctx, "settings:manage");

  // Prompt 30 §10/§120/§473 — REQUIRED-mode email verification gate.
  const { assertEmailVerifiedForCommercialAction } = await import(
    "@/lib/auth/email-verification/gate"
  );
  await assertEmailVerifiedForCommercialAction(ctx.userId);

  const result = await startBusinessTrial(ctx.businessId, {
    actorId: ctx.userId,
    source: "api",
  });

  // Funnel (idempotent per business — a trial can only ever start once).
  void recordCommercialEvent({
    eventType: "TRIAL_STARTED",
    userId: ctx.userId,
    businessId: ctx.businessId,
    planCode: result.subscription.plan.code,
    source: "api",
    dedupeKey: `trial-start:${ctx.businessId}`,
  });

  return ok(result);
});
