/**
 * GET    /api/v1/products/[id] — product detail + inventory + recents (data:read).
 * PATCH  /api/v1/products/[id] — update (data:write, audited; price changes audited explicitly).
 * DELETE /api/v1/products/[id] — soft delete (data:write, audited).
 *
 * Prompt 34 (§15/§16/§20/§21/§42): tenant-scoped GET with soft-delete
 * filter; stock state reuses the established thresholds; recent
 * adjustments (≤10) and recent sales (≤10 unique sale records via
 * SaleItem → Sale, bounded pre-take + JS dedupe, §42) — no full sale-item
 * history is ever loaded. Explicit DTO, integer minor units.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { productUpdateSchema } from "@/lib/schemas";
import { mapPurePurchaseOrderDomainError } from "@/lib/purchase-orders/service";
import { mapProductDetail } from "@/lib/entities";
import { listRecentReceiptsForProduct } from "@/lib/inventory/goods-receipt/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Bounded recent-record caps (§15/§42/§85). */
const RECENT_ADJUSTMENTS_TAKE = 10;
const RECENT_SALES_TAKE = 10;
/** Prompt 41 (§66/§155) — bounded procurement history cap. */
const RECENT_PURCHASE_ORDER_LINES_TAKE = 10;
/**
 * §15/§42 — pre-dedupe fetch bound (≤ 3× RECENT_SALES_TAKE + 5, hard max
 * 40): enough SaleItem rows to survive a few same-product lines per sale.
 */
const RECENT_SALE_ITEMS_FETCH = 35;

async function loadProduct(businessId: string, id: string) {
  const product = await db.product.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found.");
  return product;
}

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §20 — foreign/deleted record → 404 (same path as unknown id).
  const product = await loadProduct(ctx.businessId, id);

  // §42 — parallel bounded queries, deterministic ordering, explicit select.
  // Prompt 41 (§66) — Product detail gains a bounded purchase-order history:
  // READ-ONLY (§201), historical line snapshots (§236), never stock-related.
  const [recentAdjustments, recentSaleItems, recentStocktakeLines, recentPurchaseOrderLines, recentGoodsReceiptLines] =
    await Promise.all([
    db.inventoryAdjustment.findMany({
      where: { businessId: ctx.businessId, productId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_ADJUSTMENTS_TAKE,
      select: { id: true, delta: true, reason: true, createdAt: true },
    }),
    db.saleItem.findMany({
      where: {
        productId: id,
        sale: { businessId: ctx.businessId, deletedAt: null },
      },
      orderBy: [{ sale: { issueDate: "desc" } }, { id: "desc" }],
      take: RECENT_SALE_ITEMS_FETCH,
      select: {
        saleId: true,
        qty: true,
        lineTotalMinor: true,
        sale: { select: { number: true, issueDate: true } },
      },
    }),
    // Prompt 40 (§90) — ≤10 recent physical-count lines for this product,
    // joined to their (tenant-scoped) stocktake for reference/status.
    db.inventoryStocktakeLine.findMany({
      where: {
        productId: id,
        stocktake: { businessId: ctx.businessId },
      },
      orderBy: [{ countedAt: "desc" }, { id: "desc" }],
      take: 10,
      select: {
        stocktakeId: true,
        varianceQty: true,
        countedAt: true,
        stocktake: { select: { reference: true, status: true } },
      },
    }),
    // Prompt 41 (§66) — ≤10 recent procurement lines, joined to their
    // (tenant-scoped) order for reference/supplier/status/date.
    db.purchaseOrderLine.findMany({
      where: {
        productId: id,
        purchaseOrder: { businessId: ctx.businessId },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_PURCHASE_ORDER_LINES_TAKE,
      select: {
        orderedQty: true,
        unitPriceMinor: true,
        purchaseOrder: {
          select: {
            id: true,
            reference: true,
            status: true,
            supplierNameAtOrder: true,
            orderedAt: true,
            currencyCodeAtOrder: true,
            currencySymbolAtOrder: true,
            decimalPrecisionAtOrder: true,
          },
        },
      },
    }),
    // Prompt 42 (§120) — ≤10 recent goods-receipt lines (NO money §120).
    listRecentReceiptsForProduct({ businessId: ctx.businessId, productId: id, take: 10 }),
  ]);

  // Flatten SaleItem → Sale into the mapper's input shape (no N+1: the
  // sale fields arrive with the same bounded query).
  const recentSalesInput = recentSaleItems.map((item) => ({
    saleId: item.saleId,
    qty: item.qty,
    lineTotalMinor: item.lineTotalMinor,
    number: item.sale.number,
    issueDate: item.sale.issueDate,
  }));

  let detail;
  try {
    detail = mapProductDetail(
      product,
      recentAdjustments,
      recentSalesInput,
      RECENT_SALES_TAKE,
      recentStocktakeLines.map((l) => ({
        stocktakeId: l.stocktakeId,
        reference: l.stocktake.reference,
        status: l.stocktake.status,
        varianceQty: l.varianceQty,
        countedAt: l.countedAt,
      })),
      recentPurchaseOrderLines.map((l) => ({
        purchaseOrderId: l.purchaseOrder.id,
        reference: l.purchaseOrder.reference,
        status: l.purchaseOrder.status,
        supplierNameAtOrder: l.purchaseOrder.supplierNameAtOrder,
        orderedAt: l.purchaseOrder.orderedAt,
        orderedQty: l.orderedQty,
        unitPriceMinor: l.unitPriceMinor,
        currencyCodeAtOrder: l.purchaseOrder.currencyCodeAtOrder,
        currencySymbolAtOrder: l.purchaseOrder.currencySymbolAtOrder,
        decimalPrecisionAtOrder: l.purchaseOrder.decimalPrecisionAtOrder,
      })),
      recentGoodsReceiptLines,
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
