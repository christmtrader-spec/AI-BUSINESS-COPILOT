/**
 * GET  /api/v1/crm/activities — bounded activity list (§19: q/type/context/
 *      creator/from/to filters + pagination; q ≤ 64 and never logged §76).
 * POST /api/v1/crm/activities — create activity (§21: server sets business +
 *      actor; exactly one same-business context; audited; NO notification).
 *
 * §15/§82 discipline: getAuthContext → membership → requirePermission;
 * businessId comes ONLY from the server context.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  activityCreateSchema,
  createActivity,
  getActivity,
  listActivities,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
} from "@/lib/crm";
import { isActivityType, isCrmContextType, type ActivityType, type CrmContextType } from "@/lib/crm/activity-types";

export const dynamic = "force-dynamic";

/** §19 — closed filter vocabularies; unknown tokens are rejected (422). */
const activityListQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  type: z.string().trim().max(20).optional(),
  contextType: z.string().trim().max(20).optional(),
  contextId: z.string().trim().max(64).optional(),
  createdByUserId: z.string().trim().max(64).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

/** from/to must be valid datetimes or they are rejected (§19). */
function parseDateParam(value: string | undefined, field: string): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(422, "VALIDATION_ERROR", `Invalid ${field} datetime filter.`, { field });
  }
  return date;
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  const url = new URL(req.url);
  const raw = activityListQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    contextType: url.searchParams.get("contextType") ?? undefined,
    contextId: url.searchParams.get("contextId") ?? undefined,
    createdByUserId: url.searchParams.get("createdByUserId") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  if (raw.type && !isActivityType(raw.type)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown activity type filter.", { field: "type" });
  }
  if (raw.contextType && !isCrmContextType(raw.contextType)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown context type filter.", { field: "contextType" });
  }
  const result = await listActivities(ctx.businessId, {
    q: raw.q ?? "",
    type: (raw.type as ActivityType | undefined) ?? null,
    contextType: (raw.contextType as CrmContextType | undefined) ?? null,
    contextId: raw.contextId ?? null,
    createdByUserId: raw.createdByUserId ?? null,
    from: parseDateParam(raw.from, "from"),
    to: parseDateParam(raw.to, "to"),
    page: raw.page ?? 1,
    // §71 — clamp to the documented cap (never reject — listParams convention)
    pageSize: Math.min(raw.pageSize ?? ACTIVITY_PAGE_SIZE_DEFAULT, ACTIVITY_PAGE_SIZE_MAX),
  });
  return ok(result);
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, activityCreateSchema);
  const id = await createActivity(ctx.businessId, ctx.userId, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  // §79 — explicit DTO response, never a raw Prisma row.
  return ok(await getActivity(ctx.businessId, id), 201);
});
