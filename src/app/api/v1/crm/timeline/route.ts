/**
 * GET /api/v1/crm/timeline — unified context timeline (§34/§35/§36).
 *
 * Combines activities (occurredAt) + active tasks (createdAt) for EXACTLY
 * ONE same-business context, newest first, bounded candidate window
 * (≤50 per source), page ≤100 (default 25). Excludes AuditLog, security
 * events, notifications and financial records (§34/§108).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getTimeline, TIMELINE_PAGE_SIZE_DEFAULT, TIMELINE_PAGE_SIZE_MAX } from "@/lib/crm";
import { isCrmContextType } from "@/lib/crm/activity-types";

export const dynamic = "force-dynamic";

const timelineQuerySchema = z.object({
  contextType: z.string().trim().max(20),
  contextId: z.string().trim().min(1).max(64),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  const url = new URL(req.url);
  const raw = timelineQuerySchema.parse({
    contextType: url.searchParams.get("contextType") ?? "",
    contextId: url.searchParams.get("contextId") ?? "",
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  if (!isCrmContextType(raw.contextType)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown context type.", {
      field: "contextType",
    });
  }
  const result = await getTimeline(ctx.businessId, {
    contextType: raw.contextType,
    contextId: raw.contextId,
    page: raw.page ?? 1,
    pageSize: Math.min(raw.pageSize ?? TIMELINE_PAGE_SIZE_DEFAULT, TIMELINE_PAGE_SIZE_MAX),
  });
  return ok(result);
});
