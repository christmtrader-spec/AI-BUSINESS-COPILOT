/**
 * GET /api/v1/crm/tasks/work-queue — "What do I need to do?" (§29/§30).
 *
 * Server-driven buckets (overdue/today/upcoming/unscheduled) with server
 * `now` + business timezone (§32/§118). Defaults to the CALLER's assigned
 * tasks; ?assignedToUserId=<other> is allowed only for members of this
 * business (§29/§69). Hard cap 50 (§29). NO reminder delivery (§33/§66).
 *
 * NOTE: this static segment intentionally coexists with /tasks/[id] —
 * Next.js resolves static routes first.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getWorkQueue } from "@/lib/crm";

export const dynamic = "force-dynamic";

const workQueueQuerySchema = z.object({
  assignedToUserId: z.string().trim().max(64).optional(),
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  const url = new URL(req.url);
  const raw = workQueueQuerySchema.parse({
    assignedToUserId: url.searchParams.get("assignedToUserId") ?? undefined,
  });
  const queue = await getWorkQueue(ctx.businessId, ctx.userId, {
    assignedToUserId: raw.assignedToUserId ?? null,
  });
  return ok(queue);
});
