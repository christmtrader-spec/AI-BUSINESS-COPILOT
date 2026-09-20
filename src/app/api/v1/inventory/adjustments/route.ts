/**
 * GET /api/v1/inventory/adjustments — recent stock adjustments feed
 * (data:read). Includes product name and actor for the inventory view.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const takeRaw = Number(new URL(req.url).searchParams.get("take") ?? 50);
  const take =
    Number.isInteger(takeRaw) && takeRaw > 0 && takeRaw <= 200 ? takeRaw : 50;

  const items = await db.inventoryAdjustment.findMany({
    where: { businessId: ctx.businessId },
    include: {
      product: { select: { name: true, unit: true, sku: true } },
      actor: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take,
  });

  return ok({ items });
});
