/**
 * POST /api/v1/events — Prompt 25 authenticated funnel events.
 *
 * The authenticated companion of /api/public/events: allows ONLY the two
 * funnel events that are inherently client-observed UI actions
 * (TRIAL_SKIPPED, CHECKOUT_INTENT_STARTED). Identity/dimensions come from
 * the session and the allowlisted body — never emails, never IPs.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { cleanDimension, recordCommercialEvent } from "@/lib/billing/events";

export const dynamic = "force-dynamic";

/** Client-emittable allowlist — everything else is server-recorded only. */
const CLIENT_EVENT_TYPES = ["TRIAL_SKIPPED", "CHECKOUT_INTENT_STARTED"] as const;

const bodySchema = z.object({
  eventType: z.enum(CLIENT_EVENT_TYPES),
  planCode: z.string().trim().max(32).optional(),
  billingPeriod: z.enum(["MONTHLY", "YEARLY"]).optional(),
  currency: z.string().trim().max(8).optional(),
  route: z.string().trim().max(64).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const input = await parseBody(req, bodySchema);

  await recordCommercialEvent({
    eventType: input.eventType,
    userId: ctx.userId,
    businessId: ctx.businessId,
    planCode: cleanDimension(input.planCode, 32),
    billingPeriod: input.billingPeriod ?? null,
    currency: cleanDimension(input.currency, 8),
    route: cleanDimension(input.route),
    // TRIAL_SKIPPED is once-per-business for clean funnel math; the intent
    // event is repeatable by design.
    dedupeKey: input.eventType === "TRIAL_SKIPPED" ? `trial-skip:${ctx.businessId}` : null,
  });

  return ok({ recorded: true });
});
