/**
 * GET    /api/v1/crm/leads/[id] — lead detail (§41, bounded relations).
 * PATCH  /api/v1/crm/leads/[id] — field edits only (§21 — status/conversion
 *        fields ride dedicated endpoints).
 * DELETE /api/v1/crm/leads/[id] — soft delete (§67, audited).
 *
 * §15/§82: foreign-tenant and deleted records → 404 (no existence leak).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  deleteLead,
  getLeadDetail,
  leadUpdateSchema,
  updateLead,
} from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  return ok(await getLeadDetail(ctx.businessId, id));
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, leadUpdateSchema);
  await updateLead(ctx.businessId, ctx.userId, id, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(await getLeadDetail(ctx.businessId, id));
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  await deleteLead(ctx.businessId, ctx.userId, id, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ deleted: true });
});
