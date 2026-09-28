/**
 * GET /api/v1/platform/users — paginated user search (§21/§69).
 * Explicit DTO: id/name/email/locale/timestamps/sessionVersion/counts/
 * operator status. NEVER passwordHash (§21/§83).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk, queryDate, queryFilter } from "@/lib/platform/http";
import { platformUserDto } from "@/lib/platform/serializers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:users:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const where = {
    ...(queryFilter(sp, "userId", 64) ? { id: queryFilter(sp, "userId", 64)! } : {}),
    ...(queryFilter(sp, "email") ? { email: { contains: queryFilter(sp, "email")!.toLowerCase() } } : {}),
    ...(queryFilter(sp, "name") ? { name: { contains: queryFilter(sp, "name")! } } : {}),
    ...(queryDate(sp, "createdFrom") || queryDate(sp, "createdTo", true)
      ? {
          createdAt: {
            ...(queryDate(sp, "createdFrom") ? { gte: queryDate(sp, "createdFrom")! } : {}),
            ...(queryDate(sp, "createdTo", true) ? { lte: queryDate(sp, "createdTo", true)! } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
      select: {
        id: true, name: true, email: true, locale: true,
        createdAt: true, updatedAt: true, sessionVersion: true,
        _count: { select: { ownedBusinesses: true, memberships: true } },
        platformOperator: { select: { id: true, active: true, role: true } },
      },
    }),
    db.user.count({ where }),
  ]);

  return platformOk({
    users: rows.map((u) =>
      platformUserDto(
        u,
        { ownedBusinesses: u._count.ownedBusinesses, memberships: u._count.memberships },
        u.platformOperator != null,
      ),
    ),
    page: pageMeta(p, total),
  });
});
