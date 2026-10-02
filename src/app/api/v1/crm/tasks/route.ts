/**
 * GET  /api/v1/crm/tasks — bounded task list (§24: q/status/priority/
 *      assignee/context filters + pagination; q never logged §76).
 * POST /api/v1/crm/tasks — create task (§25: status OPEN forced, server
 *      sets business + actor, exactly one same-business context, assignee
 *      must be an active member of THIS business, audited).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  createTask,
  getTask,
  listTasks,
  taskCreateSchema,
  TASK_PAGE_SIZE_DEFAULT,
  TASK_PAGE_SIZE_MAX,
} from "@/lib/crm";
import {
  isTaskPriority,
  isTaskStatus,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/crm/task-types";
import { isCrmContextType, type CrmContextType } from "@/lib/crm/activity-types";

export const dynamic = "force-dynamic";

const taskListQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.string().trim().max(20).optional(),
  priority: z.string().trim().max(20).optional(),
  assignedToUserId: z.string().trim().max(64).optional(),
  contextType: z.string().trim().max(20).optional(),
  contextId: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  const url = new URL(req.url);
  const raw = taskListQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    priority: url.searchParams.get("priority") ?? undefined,
    assignedToUserId: url.searchParams.get("assignedToUserId") ?? undefined,
    contextType: url.searchParams.get("contextType") ?? undefined,
    contextId: url.searchParams.get("contextId") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  if (raw.status && !isTaskStatus(raw.status)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown task status filter.", { field: "status" });
  }
  if (raw.priority && !isTaskPriority(raw.priority)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown task priority filter.", { field: "priority" });
  }
  if (raw.contextType && !isCrmContextType(raw.contextType)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown context type filter.", { field: "contextType" });
  }
  const result = await listTasks(ctx.businessId, {
    q: raw.q ?? "",
    status: (raw.status as TaskStatus | undefined) ?? null,
    priority: (raw.priority as TaskPriority | undefined) ?? null,
    assignedToUserId: raw.assignedToUserId ?? null,
    contextType: (raw.contextType as CrmContextType | undefined) ?? null,
    contextId: raw.contextId ?? null,
    page: raw.page ?? 1,
    // §71 — clamp to the documented cap (never reject — listParams convention)
    pageSize: Math.min(raw.pageSize ?? TASK_PAGE_SIZE_DEFAULT, TASK_PAGE_SIZE_MAX),
  });
  return ok(result);
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const input = await parseBody(req, taskCreateSchema);
  const id = await createTask(ctx.businessId, ctx.userId, input, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  // §79 — explicit DTO response, never a raw Prisma row.
  return ok(await getTask(ctx.businessId, id), 201);
});
