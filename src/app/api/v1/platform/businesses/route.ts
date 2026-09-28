/**
 * GET /api/v1/platform/businesses — paginated business search (§19/§36/§69).
 *
 * Filters (all optional, all allowlisted): businessId, name (contains),
 * slug, ownerEmail (exact, lowercased), plan, subscriptionStatus, currency,
 * createdFrom/createdTo. Bounded page size, stable sort (createdAt desc),
 * explicit DTO (§70). Existence of an unmatched id is NOT distinguished
 * from a permission failure for tenants — this route is operator-only.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk, queryDate, queryFilter } from "@/lib/platform/http";
import { platformBusinessDto } from "@/lib/platform/serializers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:businesses:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const where = {
    ...(queryFilter(sp, "businessId", 64) ? { id: queryFilter(sp, "businessId", 64)! } : {}),
    ...(queryFilter(sp, "name") ? { name: { contains: queryFilter(sp, "name")! } } : {}),
    ...(queryFilter(sp, "slug") ? { slug: { contains: queryFilter(sp, "slug")! } } : {}),
    ...(queryFilter(sp, "ownerEmail")
      ? { owner: { email: queryFilter(sp, "ownerEmail")!.toLowerCase() } }
      : {}),
    ...(queryFilter(sp, "currency", 8)
      ? { currencyCode: queryFilter(sp, "currency", 8)!.toUpperCase() }
      : {}),
    ...(queryDate(sp, "createdFrom") || queryDate(sp, "createdTo", true)
      ? {
          createdAt: {
            ...(queryDate(sp, "createdFrom") ? { gte: queryDate(sp, "createdFrom")! } : {}),
            ...(queryDate(sp, "createdTo", true) ? { lte: queryDate(sp, "createdTo", true)! } : {}),
          },
        }
      : {}),
    ...(queryFilter(sp, "plan") || queryFilter(sp, "subscriptionStatus")
      ? {
          subscription: {
            ...(queryFilter(sp, "plan") ? { plan: { code: queryFilter(sp, "plan")! } } : {}),
            ...(queryFilter(sp, "subscriptionStatus")
              ? { status: queryFilter(sp, "subscriptionStatus")! }
              : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.business.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
      select: {
        id: true,
        name: true,
        slug: true,
        currencyCode: true,
        locale: true,
        timezone: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        owner: { select: { email: true, name: true } },
        _count: { select: { members: true } },
      },
    }),
    db.business.count({ where }),
  ]);

  return platformOk({
    businesses: rows.map((b) =>
      platformBusinessDto(b, b.owner, b._count.members),
    ),
    page: pageMeta(p, total),
  });
});
