/**
 * GET    /api/v1/crm/tasks/[id] — task detail (§24).
 * PATCH  /api/v1/crm/tasks/[id] — title/description/priority/dueAt/assignee
 *        ONLY (§26 — status rides /status; context is never writable).
 * DELETE /api/v1/crm/tasks/[id] — soft delete (§28, audited).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { deleteTask, getTask, taskUpdateSchema, updateTask } from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  return ok(await getTask(ctx.businessId, id));
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, taskUpdateSchema);
  await updateTask(ctx.businessId, ctx.userId, id, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(await getTask(ctx.businessId, id));
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  await deleteTask(ctx.businessId, ctx.userId, id, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ deleted: true });
});
