/**
 * POST /api/v1/onboarding/dismiss — Prompt 25 §47/§98.
 *
 * "Skip" is honest: the user leaves the guided flow, the business stays
 * fully usable, and the dashboard checklist remains available (§99).
 * Idempotent; never touches onboardingCompletedAt (skipping is not
 * completing — §91: completion must represent actual behavior).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const business = await db.business.update({
    where: { id: ctx.businessId },
    data: { onboardingDismissedAt: new Date() },
    select: { onboardingDismissedAt: true },
  });

  return ok({ onboardingDismissedAt: business.onboardingDismissedAt });
});
