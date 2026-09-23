/**
 * GET /api/v1/billing/usage — Prompt 21 (§52/§63/§94/§99).
 *
 * Read-only consumption summary for the ACTIVE business (the business is
 * resolved server-side from the session — the client can never pass a
 * businessId and read another tenant's usage, §55/§99).
 *
 * Response (only REAL, implemented metrics — §52):
 * {
 *   planCode, entitled, status,
 *   period: { start, end },          // aligned with the billing period
 *   metrics: {
 *     AI_REQUESTS: { used, limit|null(unlimited), remaining, percentageUsed, level },
 *     AI_MESSAGES: { ... },
 *     AI_TOKENS:   { used, limit: null, remaining: null, percentageUsed: null, level }
 *   }
 * }
 *
 * - `level` ∈ ok | warning(≥75%) | critical(≥90%) | reached(100%) — the
 *   thresholds live in src/lib/billing/usage.ts, never in components (§53).
 * - Unlimited plans: limit/remaining/percentageUsed are null — NEVER fake
 *   giant numbers (§64).
 * - AI_TOKENS is recorded-when-reported (§14) and NOT quota-enforced; the
 *   UI may hide it until `used > 0`.
 * - No money is ever computed here (§62/§104).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getUsageSummary, listUsagePeriods } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const summary = await getUsageSummary(ctx.businessId);
  // Include recent historical periods (§101 retention-friendly, capped)
  // unless the caller asks for the current period only.
  const history = new URL(req.url).searchParams.get("history") === "1";

  return ok({
    ...summary,
    ...(history ? { history: await listUsagePeriods(ctx.businessId, 12) } : {}),
  });
});
