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
import { mapSaleDetail } from "@/lib/entities";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Prompt 34 §17 — audited: tenant-scoped, soft-delete filtered, DTO-shaped.
  // Mapping now goes through the centralized mapper (§22) — the wire shape
  // is byte-identical to the pre-Prompt-34 contract the dialog depends on.
  const sale = await db.sale.findFirst({
    where: { id, businessId: ctx.businessId, deletedAt: null },
    include: {
      customer: { select: { name: true } },
      items: { orderBy: { id: "asc" } },
      payments: {
        orderBy: [{ paidAt: "desc" }, { id: "desc" }],
        include: { actor: { select: { name: true, email: true } } },
      },
    },
  });
  if (!sale) throw new ApiError(404, "NOT_FOUND", "Invoice not found.");

  return ok(
    mapSaleDetail(
      {
        id: sale.id,
        number: sale.number,
        customerId: sale.customerId,
        customerName: sale.customer?.name ?? null,
        issueDate: sale.issueDate,
        subtotalMinor: sale.subtotalMinor,
        discountMinor: sale.discountMinor,
        taxRateBp: sale.taxRateBp,
        taxMinor: sale.taxMinor,
        totalMinor: sale.totalMinor,
        paidMinor: sale.paidMinor,
        status: sale.status,
        note: sale.note,
        createdAt: sale.createdAt,
      },
      sale.items,
      sale.payments.map((p) => ({
        id: p.id,
        amountMinor: p.amountMinor,
        method: p.method,
        note: p.note,
        paidAt: p.paidAt,
        actorName: p.actor?.name ?? p.actor?.email ?? null,
      })),
    ),
  );
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

  // Prompt 45 (§62/§121) — a SalesOrder-linked invoice must NEVER restore
  // product stock: the linked GoodsDispatch documents already own that
  // inventory movement, and a legacy-style deletion would fabricate a
  // false stock increase. Prompt 45 has no invoice-void workflow, so the
  // safest correct behavior is to REJECT user-facing deletion of a linked
  // invoice (the authoritative relation decides — never notes text).
  if (sale.salesOrderId) {
    throw new ApiError(
      409,
      "SALE_LINKED_TO_SALES_ORDER",
      "This invoice belongs to a sales order. Its inventory movement is owned by the linked goods dispatches, so the legacy delete-with-restock path does not apply. Voiding a linked invoice is not yet supported.",
    );
  }

  const paymentCount = await db.payment.count({ where: { saleId: sale.id, businessId: ctx.businessId } });
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
