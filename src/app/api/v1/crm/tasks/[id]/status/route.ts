/**
 * POST /api/v1/crm/tasks/[id]/status — dedicated status transition (§27).
 *
 * Body { status } — closed vocabulary + server state machine (§13);
 * completion sets completedAt = now, reopen/cancel clears it (§121).
 * Audited as crm.task.status_change.
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { changeTaskStatus, getTask, taskStatusSchema } from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, taskStatusSchema);
  await changeTaskStatus(ctx.businessId, ctx.userId, id, input.status, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  // Return the fresh DTO so the client badge reflects server truth.
  return ok(await getTask(ctx.businessId, id));
});
