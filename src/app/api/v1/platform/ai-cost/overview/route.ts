/**
 * GET /api/v1/platform/ai-cost/overview — INTERNAL ONLY (§38/§39/§52).
 *
 * Reuses the Prompt-26 economics services (getAiCostHealth /
 * getAiCostBreakdown / getUnknownCostGroups) — NO calculation is duplicated
 * in this route or in React (§39). Every tenant role is 403 by the platform
 * gate alone (§52); no customer API may ever reach this code.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { getAiCostHealth, getAiCostBreakdown, getUnknownCostGroups } from "@/lib/ai/cost/economics";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:read");

  const windowDays = Math.min(
    Math.max(Number(req.nextUrl.searchParams.get("windowDays") ?? "30"), 1),
    365,
  );

  const [health, breakdown, unknownGroups] = await Promise.all([
    getAiCostHealth(windowDays),
    getAiCostBreakdown(windowDays),
    getUnknownCostGroups(windowDays),
  ]);

  return platformOk({
    health,
    breakdown,
    unknownGroups,
  });
});
