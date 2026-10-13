/**
 * GET    /api/v1/suppliers/[id] — supplier detail + 360 summary (data:read).
 * PATCH  /api/v1/suppliers/[id] — update (data:write, audited).
 * DELETE /api/v1/suppliers/[id] — soft delete (data:write, audited).
 *
 * Prompt 34 (§13/§14/§20/§21/§41): tenant-scoped GET, soft-delete filter,
 * one groupBy for the payable summary, bounded recent lists (≤10 each),
 * explicit DTO. Payable NEVER includes platform subscription balances.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { partyUpdateSchema } from "@/lib/schemas";
import { purchaseOrderLineCap } from "@/lib/purchase-orders/types";
import { mapPurePurchaseOrderDomainError } from "@/lib/purchase-orders/service";
import { listRecentReceiptsForSupplier } from "@/lib/inventory/goods-receipt/service";
import { listRecentReturnsForSupplier } from "@/lib/inventory/goods-return/service";
import { listRecentBillsForSupplier } from "@/lib/supplier-bills/service";
import {
  computeSupplierSummary,
  mapSupplierDetail,
  toStatusToken,
} from "@/lib/entities";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Bounded recent-record caps (§13/§41/§85). */
const RECENT_EXPENSES_TAKE = 10;
const RECENT_PAYMENTS_TAKE = 10;
/** Prompt 41 (§65/§154) — bounded procurement history cap. */
const RECENT_PURCHASE_ORDERS_TAKE = 10;

async function loadSupplier(businessId: string, id: string) {
  const supplier = await db.supplier.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!supplier) throw new ApiError(404, "NOT_FOUND", "Supplier not found.");
  return supplier;
}

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §20 — foreign/deleted record → 404 (same path as unknown id).
  const supplier = await loadSupplier(ctx.businessId, id);

  // §41 — parallel bounded queries; groupBy aggregate; deterministic order.
  // Prompt 41 (§65) — the Supplier 360 gains a bounded procurement section:
  // PurchaseOrder rows are READ-ONLY here (§201) and never feed the payable
  // summary below — a PO is a commitment document, not a payable (§150).
  const [statusBuckets, recentExpenses, recentPayments, recentPurchaseOrders, recentGoodsReceipts, recentGoodsReturns, recentSupplierBills] =
    await Promise.all([
    db.expense.groupBy({
      by: ["status"],
      where: { businessId: ctx.businessId, supplierId: id, deletedAt: null },
      _count: { _all: true },
      _sum: { amountMinor: true, paidMinor: true },
    }),
    db.expense.findMany({
      where: { businessId: ctx.businessId, supplierId: id, deletedAt: null },
      orderBy: [{ spentAt: "desc" }, { id: "desc" }],
      take: RECENT_EXPENSES_TAKE,
      select: {
        id: true,
        category: true,
        spentAt: true,
        amountMinor: true,
        paidMinor: true,
        status: true,
      },
    }),
    db.payment.findMany({
      where: { businessId: ctx.businessId, expense: { supplierId: id } },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
      take: RECENT_PAYMENTS_TAKE,
      select: {
        id: true,
        amountMinor: true,
        method: true,
        paidAt: true,
        note: true,
      },
    }),
    db.purchaseOrder.findMany({
      where: { businessId: ctx.businessId, supplierId: id },
      orderBy: [{ orderedAt: "desc" }, { id: "desc" }],
      take: RECENT_PURCHASE_ORDERS_TAKE,
      select: {
        id: true,
        reference: true,
        status: true,
        orderedAt: true,
        currencyCodeAtOrder: true,
        currencySymbolAtOrder: true,
        decimalPrecisionAtOrder: true,
        // §20 — the line slice feeding each document total is EXPLICITLY
        // bounded by the same P41 line-cap law (never unbounded relation load).
        lines: {
          select: { orderedQty: true, unitPriceMinor: true },
          take: purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES),
        },
      },
    }),
    // Prompt 42 (§121) — bounded receipt history (≤10, snapshot identity,
    // NO financial statement contamination — receipts are never payables).
    listRecentReceiptsForSupplier({ businessId: ctx.businessId, supplierId: id, take: 10 }),
    // Prompt 43 (§100) — bounded return history (≤10, snapshot identity,
    // NO financial statement contamination — returns are never payables
    // and never mutate the statement or aging views).
    listRecentReturnsForSupplier({ businessId: ctx.businessId, supplierId: id, take: 10 }),
    // Prompt 48 (§8) — bounded supplier-bill history (≤10, snapshot identity).
    // READ-ONLY document rows; the per-bill payable state comes from the
    // LIVE linked Expense — this section never adds a payable movement.
    listRecentBillsForSupplier({ businessId: ctx.businessId, supplierId: id, take: 10 }),
  ]);

  const summary = computeSupplierSummary(
    statusBuckets.map((bucket) => ({
      status: toStatusToken(bucket.status),
      count: bucket._count._all,
      totalMinor: bucket._sum.amountMinor ?? 0,
      paidMinor: bucket._sum.paidMinor ?? 0,
    })),
  );

  let detail;
  try {
    detail = mapSupplierDetail(
      supplier,
      summary,
      recentExpenses,
      recentPayments,
      recentPurchaseOrders,
      recentGoodsReceipts,
      recentGoodsReturns,
      recentSupplierBills,
    );
  } catch (error) {
    // §12/§13 — corrupted PO status → the SAME stable integrity code as the
    // P41 domain routes; never a fake lifecycle token, never a generic 500.
    mapPurePurchaseOrderDomainError(error);
  }

  return ok(detail);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadSupplier(ctx.businessId, id);
  const input = await parseBody(req, partyUpdateSchema);

  const updated = await db.$transaction(async (tx) => {
    const s = await tx.supplier.update({ where: { id: before.id }, data: input });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "supplier.update",
        entityType: "Supplier",
        entityId: s.id,
        before,
        after: s,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return s;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadSupplier(ctx.businessId, id);

  await db.$transaction(async (tx) => {
    await tx.supplier.update({
      where: { id: before.id },
      data: { deletedAt: new Date() },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "supplier.delete",
        entityType: "Supplier",
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
