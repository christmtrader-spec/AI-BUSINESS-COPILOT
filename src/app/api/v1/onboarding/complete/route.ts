/**
 * POST /api/v1/onboarding/complete — Prompt 25.
 *
 * Marks onboarding COMPLETE for the ACTIVE business. Requirements are
 * honest and minimal: the business EXISTS (full data entry is optional —
 * no payment, no trial, no checklist item is mandatory). The completion
 * event fires exactly ONCE per business (unique constraint), so repeated
 * calls are idempotent (already=true, no duplicate rows).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { recordCommercialEvent } from "@/lib/billing/events";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  // Defensive: the business must exist (it always does behind
  // getAuthContext — this also guards future refactors).
  const business = await db.business.findUnique({
    where: { id: ctx.businessId },
    select: { id: true },
  });

  const recorded = await recordCommercialEvent({
    eventType: "ONBOARDING_COMPLETED",
    userId: ctx.userId,
    businessId: ctx.businessId,
    dedupeKey: business ? `onb-done:${business.id}` : null,
  });

  return ok({ completed: true, already: !recorded });
});
