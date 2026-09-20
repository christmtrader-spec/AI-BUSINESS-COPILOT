/**
 * PATCH  /api/v1/products/[id] — update (data:write, audited; price changes audited explicitly).
 * DELETE /api/v1/products/[id] — soft delete (data:write, audited).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { productUpdateSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

async function loadProduct(businessId: string, id: string) {
  const product = await db.product.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found.");
  return product;
}

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadProduct(ctx.businessId, id);
  const input = await parseBody(req, productUpdateSchema);

  // Price changes are sensitive (Constitution A09) — record old→new explicitly.
  const priceChanged =
    (input.salePriceMinor !== undefined && input.salePriceMinor !== before.salePriceMinor) ||
    (input.costPriceMinor !== undefined && input.costPriceMinor !== before.costPriceMinor);

  const updated = await db.$transaction(async (tx) => {
    const p = await tx.product.update({ where: { id: before.id }, data: input });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: priceChanged ? "product.price_change" : "product.update",
        entityType: "Product",
        entityId: p.id,
        before: {
          ...before,
          ...(priceChanged
            ? {
                _prices: {
                  salePriceMinor: { from: before.salePriceMinor, to: p.salePriceMinor },
                  costPriceMinor: { from: before.costPriceMinor, to: p.costPriceMinor },
                },
              }
            : {}),
        },
        after: p,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return p;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadProduct(ctx.businessId, id);

  await db.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: before.id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "product.delete",
        entityType: "Product",
        entityId: before.id,
        before,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ deleted: true });
});
