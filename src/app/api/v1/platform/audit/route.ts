/**
 * GET /api/v1/platform/audit — PlatformAuditLog view (§58/§69/§117).
 * Filters: operator, action, entityType, targetBusinessId, targetUserId,
 * date range. Newest first, paginated, sanitized (the stored payloads are
 * already sanitized at write time — see src/lib/platform/audit.ts).
 * TENANT USERS CANNOT REACH THIS (platform:audit:read gate, §119).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk, queryDate, queryFilter } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { platformAuditDto } from "@/lib/platform/serializers";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:audit:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const action = queryFilter(sp, "action", 64);
  const entityType = queryFilter(sp, "entityType", 40);
  const operatorId = queryFilter(sp, "operatorId", 64);
  const targetBusinessId = queryFilter(sp, "businessId", 64);
  const targetUserId = queryFilter(sp, "userId", 64);
  const createdFrom = queryDate(sp, "createdFrom");
  const createdTo = queryDate(sp, "createdTo", true);

  const where = {
    ...(action ? { action } : {}),
    ...(entityType ? { entityType } : {}),
    ...(operatorId ? { operatorId } : {}),
    ...(targetBusinessId ? { targetBusinessId } : {}),
    ...(targetUserId ? { targetUserId } : {}),
    ...(createdFrom || createdTo
      ? { createdAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
      include: { operator: { select: { user: { select: { email: true } } } } },
    }),
    db.platformAuditLog.count({ where }),
  ]);

  return platformOk({
    entries: rows.map((row) => platformAuditDto(row, row.operator?.user?.email ?? null)),
    page: pageMeta(p, total),
  });
});
