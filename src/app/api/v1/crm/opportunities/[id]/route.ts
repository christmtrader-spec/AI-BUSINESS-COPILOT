/**
 * GET    /api/v1/crm/opportunities/[id] — detail + server weighted value (§42).
 * PATCH  /api/v1/crm/opportunities/[id] — field edits (§31 — stage NOT patchable).
 * DELETE /api/v1/crm/opportunities/[id] — soft delete (§67).
 *
 * §15/§82: foreign/deleted → 404 (no existence leak).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  deleteOpportunity,
  getOpportunityDetail,
  opportunityUpdateSchema,
  updateOpportunity,
} from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  return ok(await getOpportunityDetail(ctx.businessId, id));
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, opportunityUpdateSchema);
  await updateOpportunity(ctx.businessId, ctx.userId, id, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(await getOpportunityDetail(ctx.businessId, id));
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  await deleteOpportunity(ctx.businessId, ctx.userId, id, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ deleted: true });
});
