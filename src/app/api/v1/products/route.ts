/**
 * GET  /api/v1/products — list (search + pagination, soft-delete aware).
 * POST /api/v1/products — create (data:write, audited).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { listParams, productCreateSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const { q, page, pageSize } = listParams(new URL(req.url));
  const where = {
    businessId: ctx.businessId,
    deletedAt: null,
    ...(q
      ? {
          OR: [{ name: { contains: q } }, { sku: { contains: q } }],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.product.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.product.count({ where }),
  ]);

  return ok({ items, total, page, pageSize });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, productCreateSchema);

  const product = await db.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: { ...input, businessId: ctx.businessId },
    });
    if (created.stockQty !== 0) {
      await tx.inventoryAdjustment.create({
        data: {
          businessId: ctx.businessId,
          productId: created.id,
          delta: created.stockQty,
          reason: "initial stock",
          actorId: ctx.userId,
        },
      });
    }
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "product.create",
        entityType: "Product",
        entityId: created.id,
        after: created,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return created;
  });

  return ok(product, 201);
});
