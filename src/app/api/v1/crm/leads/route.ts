/**
 * GET  /api/v1/crm/leads — bounded lead list (§19: q/status/source/assignee
 *      filters + pagination; q never logged — §131).
 * POST /api/v1/crm/leads — create lead (§20: status NEW, audited).
 *
 * Prompt 35 CRM (§15/§18): getAuthContext → membership → requirePermission;
 * businessId comes ONLY from the server context. Tenant-scope params from
 * the client are not read at all.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  createLead,
  getLeadDetail,
  isLeadSource,
  isLeadStatus,
  LEAD_PAGE_SIZE_DEFAULT,
  LEAD_PAGE_SIZE_MAX,
  leadCreateSchema,
  listLeads,
  type LeadSource,
  type LeadStatus,
} from "@/lib/crm";

export const dynamic = "force-dynamic";

/** §19 — closed filter vocabularies; unknown filter values are rejected. */
const leadListQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.string().trim().max(20).optional(),
  source: z.string().trim().max(20).optional(),
  assignedToUserId: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

function parseLeadListQuery(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = leadListQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    assignedToUserId: url.searchParams.get("assignedToUserId") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  // Unknown filter tokens → 422 (never silently ignored — closed vocab §6).
  if (parsed.status && !isLeadStatus(parsed.status)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown lead status filter.", {
      field: "status",
    });
  }
  if (parsed.source && !isLeadSource(parsed.source)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown lead source filter.", {
      field: "source",
    });
  }
  return {
    q: parsed.q ?? "",
    status: (parsed.status as LeadStatus | undefined) ?? null,
    source: (parsed.source as LeadSource | undefined) ?? null,
    assignedToUserId: parsed.assignedToUserId ?? null,
    page: parsed.page ?? 1,
    // §19 — clamp to the documented cap (never reject — listParams convention)
    pageSize: Math.min(parsed.pageSize ?? LEAD_PAGE_SIZE_DEFAULT, LEAD_PAGE_SIZE_MAX),
  };
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  const filters = parseLeadListQuery(req);
  const result = await listLeads(ctx.businessId, filters);
  return ok(result);
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, leadCreateSchema);
  const id = await createLead(ctx.businessId, ctx.userId, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  // §79 — explicit DTO response, never a raw Prisma row.
  return ok(await getLeadDetail(ctx.businessId, id), 201);
});
