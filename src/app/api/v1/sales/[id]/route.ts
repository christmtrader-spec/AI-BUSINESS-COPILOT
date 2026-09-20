/**
 * GET    /api/v1/sales/[id] — invoice detail with items + payments.
 * DELETE /api/v1/sales/[id] — soft delete (data:write). Blocked while
 * payments exist (money history stays honest); restores product stock.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { formatInvoiceNumber } from "@/lib/finance";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const sale = await db.sale.findFirst({
    where: { id, businessId: ctx.businessId, deletedAt: null },
    include: {
      customer: { select: { name: true } },
      items: { orderBy: { id: "asc" } },
      payments: {
        orderBy: { paidAt: "desc" },
        include: { actor: { select: { name: true, email: true } } },
      },
    },
  });
  if (!sale) throw new ApiError(404, "NOT_FOUND", "Invoice not found.");

  return ok({
    sale: {
      id: sale.id,
      number: sale.number,
      customerId: sale.customerId,
      customerName: sale.customer?.name ?? null,
      issueDate: sale.issueDate.toISOString(),
      subtotalMinor: sale.subtotalMinor,
      discountMinor: sale.discountMinor,
      totalMinor: sale.totalMinor,
      paidMinor: sale.paidMinor,
      status: sale.status,
      balanceMinor: sale.totalMinor - sale.paidMinor,
      note: sale.note,
      createdAt: sale.createdAt.toISOString(),
    },
    items: sale.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      name: i.name,
      unit: i.unit,
      qty: i.qty,
      unitPriceMinor: i.unitPriceMinor,
      lineTotalMinor: i.lineTotalMinor,
    })),
    payments: sale.payments.map((p) => ({
      id: p.id,
      amountMinor: p.amountMinor,
      method: p.method,
      note: p.note,
      paidAt: p.paidAt.toISOString(),
      actorName: p.actor?.name ?? p.actor?.email ?? null,
    })),
  });
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const sale = await db.sale.findFirst({
    where: { id, businessId: ctx.businessId, deletedAt: null },
    include: { items: true },
  });
  if (!sale) throw new ApiError(404, "NOT_FOUND", "Invoice not found.");
  const paymentCount = await db.payment.count({ where: { saleId: sale.id } });
  if (paymentCount > 0 || sale.paidMinor !== 0) {
    throw new ApiError(
      422,
      "SALE_HAS_PAYMENTS",
      "This invoice has payments recorded. Delete its payments first to keep the money history consistent.",
    );
  }

  const display = formatInvoiceNumber(sale.number);

  await db.$transaction(async (tx) => {
    await tx.sale.update({ where: { id: sale.id }, data: { deletedAt: new Date() } });

    // Restore stock for product-backed lines (mirror of sale.create).
    for (const item of sale.items) {
      if (!item.productId) continue;
      const product = await tx.product.findFirst({
        where: { id: item.productId, businessId: ctx.businessId },
      });
      if (!product) continue; // product hard-gone (never happens via API); sale stays deleted
      await tx.product.update({
        where: { id: product.id },
        data: { stockQty: { increment: item.qty } },
      });
      await tx.inventoryAdjustment.create({
        data: {
          businessId: ctx.businessId,
          productId: product.id,
          delta: item.qty,
          reason: `Sale ${display} deleted (reversal)`,
          actorId: ctx.userId,
        },
      });
    }

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "sale.delete",
        entityType: "Sale",
        entityId: sale.id,
        before: { number: sale.number, totalMinor: sale.totalMinor },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ deleted: true });
});
