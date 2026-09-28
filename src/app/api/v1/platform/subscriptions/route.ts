/**
 * GET /api/v1/platform/subscriptions — paginated subscription list (§36/§69).
 * Read-only. Filters: status, planCode, businessId. Explicit DTO.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk, queryFilter } from "@/lib/platform/http";
import { platformSubscriptionDto } from "@/lib/platform/serializers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:subscriptions:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const status = queryFilter(sp, "status", 20);
  const planCode = queryFilter(sp, "plan", 32);
  const businessId = queryFilter(sp, "businessId", 64);

  const where = {
    ...(status ? { status } : {}),
    ...(planCode ? { plan: { code: planCode } } : {}),
    ...(businessId ? { businessId } : {}),
  };

  const [rows, total] = await Promise.all([
    db.subscription.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
      include: {
        plan: { select: { code: true, name: true } },
        business: { select: { name: true } },
      },
    }),
    db.subscription.count({ where }),
  ]);

  return platformOk({
    subscriptions: rows.map(platformSubscriptionDto),
    page: pageMeta(p, total),
  });
});
