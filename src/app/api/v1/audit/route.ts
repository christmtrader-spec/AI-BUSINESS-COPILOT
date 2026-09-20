/**
 * GET /api/v1/audit — recent audit log entries (audit:read).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "audit:read");

  const takeRaw = Number(new URL(req.url).searchParams.get("take") ?? 50);
  if (!Number.isInteger(takeRaw) || takeRaw < 1 || takeRaw > 200) {
    throw new ApiError(422, "INVALID_TAKE", "'take' must be an integer between 1 and 200.");
  }
  const take = takeRaw;

  const logs = await db.auditLog.findMany({
    where: { businessId: ctx.businessId },
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });

  return ok(
    logs.map((l) => ({
      id: l.id,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      actor: l.actor,
      before: l.beforeJson ? JSON.parse(l.beforeJson) : null,
      after: l.afterJson ? JSON.parse(l.afterJson) : null,
      createdAt: l.createdAt,
    })),
  );
});
