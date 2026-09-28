/**
 * GET /api/v1/platform/ai-cost/economics — plan AI contribution (§48).
 * Reuses getPlanAiEconomics (Prompt 26) — statuses COMPARABLE /
 * NOT_COMPARABLE_CURRENCY / COST_UNKNOWN / PRICE_UNKNOWN /
 * INSUFFICIENT_SAMPLE. NEVER labeled "net profit" (§48/§115).
 * No FX, no cross-currency aggregation (§49).
 */
import { NextRequest } from "next/server";
import { route, ApiError } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { getPlanAiEconomics } from "@/lib/ai/cost/economics";
import { PLAN_CODES } from "@/lib/billing/catalog";
import { isBillingPeriod } from "@/lib/billing/state-machine";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:read");

  const sp = req.nextUrl.searchParams;
  const planCode = sp.get("planCode") ?? "";
  if (!(PLAN_CODES as readonly string[]).includes(planCode)) {
    throw new ApiError(422, "PLATFORM_INVALID_OPERATION", "Unknown plan code.");
  }
  const billingPeriod = sp.get("billingPeriod") ?? "MONTHLY";
  if (!isBillingPeriod(billingPeriod)) {
    throw new ApiError(422, "PLATFORM_INVALID_OPERATION", "Unknown billing period.");
  }

  const economics = await getPlanAiEconomics(planCode, billingPeriod);
  return platformOk({ economics });
});
