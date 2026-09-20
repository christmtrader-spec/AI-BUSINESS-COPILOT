/**
 * POST /api/v1/products/[id]/stock — basic inventory adjustment (A09).
 * Transactional: updates stockQty and writes an InventoryAdjustment row,
 * so the stock history is always reconstructable. Negative stock rejected.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { stockAdjustSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, stockAdjustSchema);

  const result = await db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id, businessId: ctx.businessId, deletedAt: null },
    });
    if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found.");

    const newQty = product.stockQty + input.delta;
    if (newQty < 0) {
      throw new ApiError(
        422,
        "INSUFFICIENT_STOCK",
        `Stock cannot go below zero (current: ${product.stockQty}).`,
      );
    }

    const updated = await tx.product.update({
      where: { id: product.id },
      data: { stockQty: newQty },
    });

    const adjustment = await tx.inventoryAdjustment.create({
      data: {
        businessId: ctx.businessId,
        productId: product.id,
        delta: input.delta,
        reason: input.reason,
        actorId: ctx.userId,
      },
    });

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "inventory.adjust",
        entityType: "InventoryAdjustment",
        entityId: adjustment.id,
        before: { stockQty: product.stockQty },
        after: { stockQty: newQty, delta: input.delta, reason: input.reason },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return updated;
  });

  return ok(result);
});
