/**
 * GET  /api/v1/crm/opportunities — bounded list (§28: q/stage/assignee/
 *      customer/lead/close-window filters + pagination).
 * POST /api/v1/crm/opportunities — create (§29: defaults + same-business
 *      relations + currency capture; audited).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  createOpportunity,
  getOpportunityDetail,
  isOpportunityStage,
  OPPORTUNITY_PAGE_SIZE_DEFAULT,
  OPPORTUNITY_PAGE_SIZE_MAX,
  opportunityCreateSchema,
  listOpportunities,
  type OpportunityStage,
} from "@/lib/crm";

export const dynamic = "force-dynamic";

const opportunityListQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  stage: z.string().trim().max(20).optional(),
  assignedToUserId: z.string().trim().max(64).optional(),
  customerId: z.string().trim().max(64).optional(),
  leadId: z.string().trim().max(64).optional(),
  closeBefore: z.string().trim().max(40).optional(),
  closeAfter: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

function parseOpportunityListQuery(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = opportunityListQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    stage: url.searchParams.get("stage") ?? undefined,
    assignedToUserId: url.searchParams.get("assignedToUserId") ?? undefined,
    customerId: url.searchParams.get("customerId") ?? undefined,
    leadId: url.searchParams.get("leadId") ?? undefined,
    closeBefore: url.searchParams.get("closeBefore") ?? undefined,
    closeAfter: url.searchParams.get("closeAfter") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  // Closed stage vocabulary (§6) — unknown filter token → 422.
  if (parsed.stage && !isOpportunityStage(parsed.stage)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown opportunity stage filter.", {
      field: "stage",
    });
  }
  return {
    q: parsed.q ?? "",
    stage: (parsed.stage as OpportunityStage | undefined) ?? null,
    assignedToUserId: parsed.assignedToUserId ?? null,
    customerId: parsed.customerId ?? null,
    leadId: parsed.leadId ?? null,
    closeBefore: parsed.closeBefore ?? null,
    closeAfter: parsed.closeAfter ?? null,
    page: parsed.page ?? 1,
    // §28 — clamp to the documented cap (never reject — listParams convention)
    pageSize: Math.min(parsed.pageSize ?? OPPORTUNITY_PAGE_SIZE_DEFAULT, OPPORTUNITY_PAGE_SIZE_MAX),
  };
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  return ok(await listOpportunities(ctx.businessId, parseOpportunityListQuery(req)));
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, opportunityCreateSchema);
  const id = await createOpportunity(ctx.businessId, ctx.userId, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  // §79 — explicit DTO response, never a raw Prisma row.
  return ok(await getOpportunityDetail(ctx.businessId, id), 201);
});
