/**
 * GET /api/v1/businesses/[id]/danger — record counts for the danger-zone
 * confirmation dialog (OWNER-only). Lets the UI show exactly what a
 * business deletion will remove BEFORE the owner confirms it.
 *
 * Permission: business:delete (OWNER only — same bar as DELETE).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "business:delete"); // OWNER only

  const [customers, suppliers, products, sales, expenses, payments] = await Promise.all([
    db.customer.count({ where: { businessId: ctx.businessId } }),
    db.supplier.count({ where: { businessId: ctx.businessId } }),
    db.product.count({ where: { businessId: ctx.businessId } }),
    db.sale.count({ where: { businessId: ctx.businessId } }),
    db.expense.count({ where: { businessId: ctx.businessId } }),
    db.payment.count({ where: { businessId: ctx.businessId } }),
  ]);

  return ok({ customers, suppliers, products, sales, expenses, payments });
});
