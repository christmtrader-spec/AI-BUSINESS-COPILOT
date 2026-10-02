/**
 * GET /api/v1/crm/tasks/reminder-summary — CRM reminder configuration counts
 * (Prompt 37 §63/§64).
 *
 * Business-scoped server aggregate: how many ACTIVE assigned tasks have a
 * due-soon reminder / overdue alert configured, plus how many reminder
 * windows open within the next 24h. NOT notification counts (§63/§64) and
 * never mixed with financial aggregates (§87 discipline).
 *
 * NOTE: this static segment intentionally coexists with /tasks/[id] —
 * Next.js resolves static routes first.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getCrmReminderSummary } from "@/lib/crm";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  const summary = await getCrmReminderSummary(ctx.businessId);
  return ok(summary);
});
