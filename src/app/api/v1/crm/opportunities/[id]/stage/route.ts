/**
 * POST /api/v1/crm/opportunities/[id]/stage — the ONLY stage-change path
 * (§31/§32). Transactional; server-authoritative probability + terminal
 * timestamps; WON requires a live same-business customer (§30/§69); LOST
 * requires a reason (schema refine). NO finance side effects (§33).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { changeOpportunityStage, getOpportunityDetail, opportunityStageSchema } from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, opportunityStageSchema);
  const result = await changeOpportunityStage(ctx.businessId, ctx.userId, id, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(await getOpportunityDetail(ctx.businessId, id));
});
