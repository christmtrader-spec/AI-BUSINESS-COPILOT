/**
 * GET /api/v1/billing/trial/eligibility — Prompt 25.
 *
 * Server-side trial eligibility for the ACTIVE business (resolved from the
 * session — the client can never nominate another tenant's business).
 * Read path: settings:read (OWNER/ADMIN/MANAGER may LOOK at eligibility;
 * starting a trial requires settings:manage = OWNER/ADMIN).
 *
 * Also records TRIAL_ELIGIBILITY_VIEWED once per business (funnel).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getTrialEligibility } from "@/lib/billing/trial";
import { recordCommercialEvent } from "@/lib/billing/events";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const eligibility = await getTrialEligibility(ctx.businessId);

  // Funnel: a business looking at trial eligibility (once per business).
  if (eligibility.businessExists) {
    void recordCommercialEvent({
      eventType: "TRIAL_ELIGIBILITY_VIEWED",
      userId: ctx.userId,
      businessId: ctx.businessId,
      planCode: eligibility.trialPlanCode,
      dedupeKey: `trial-elig:${ctx.businessId}`,
    });
  }

  return ok(eligibility);
});
