/**
 * GET    /api/v1/crm/activities/[id] — activity detail (§18).
 * PATCH  /api/v1/crm/activities/[id] — field edits only (§22 — context is
 *        NEVER writable: delete + re-create keeps timeline semantics clean).
 * DELETE /api/v1/crm/activities/[id] — soft delete (§23, audited).
 *
 * §15/§82: foreign-tenant and deleted records → 404 (no existence leak).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { activityUpdateSchema, deleteActivity, getActivity, updateActivity } from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  return ok(await getActivity(ctx.businessId, id));
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, activityUpdateSchema);
  await updateActivity(ctx.businessId, ctx.userId, id, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(await getActivity(ctx.businessId, id));
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  await deleteActivity(ctx.businessId, ctx.userId, id, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ deleted: true });
});
