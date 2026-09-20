/**
 * GET /api/v1/reports/summary?days=7|30|90
 *
 * Phase 04 — deterministic report aggregates. Every figure is computed
 * by the SERVER from recorded transactions (Rule 05 / A11-A13): the AI
 * copilot and the UI only narrate these numbers, never invent them.
 * The computation lives in lib/reports.ts — shared with the copilot
 * grounding pipeline (single source of truth).
 *
 * Permission: data:read (all roles).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { buildReportSummary, normalizeReportDays } from "@/lib/reports";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const url = new URL(req.url);
  const days = normalizeReportDays(url.searchParams.get("days"));

  return ok(await buildReportSummary(ctx.businessId, days));
});
