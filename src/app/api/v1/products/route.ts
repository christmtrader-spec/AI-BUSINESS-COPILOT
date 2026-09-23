/**
 * GET  /api/v1/products — list (search + pagination, soft-delete aware).
 * POST /api/v1/products — create (data:write, audited, plan-limited).
 *
 * Prompt 20: creation is gated by the PRODUCTS_MAX entitlement (§27/§33).
 * Count + check + create inside ONE serializable transaction (§112).
 * Counting policy (§105/§106): non-soft-deleted products count; isActive
 * deactivation is a catalog state, NOT deletion — deactivated products
 * still occupy plan capacity. Existing products are grandfathered on
 * downgrade — never deleted or deactivated by a plan change.
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { listParams, productCreateSchema } from "@/lib/schemas";
import { assertWithinLimitIn, getEntitlementContextTx } from "@/lib/billing";

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

  const product = await db.$transaction(
    async (tx) => {
      // Billing gate (§27): fresh entitlement read + count inside the tx.
      const bctx = await getEntitlementContextTx(tx, ctx.businessId);
      const usage = await tx.product.count({
        where: { businessId: ctx.businessId, deletedAt: null },
      });
      assertWithinLimitIn(bctx, "PRODUCTS_MAX", usage);

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
    },
    { isolationLevel: "Serializable" },
  );

  return ok(product, 201);
});
