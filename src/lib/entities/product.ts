/**
 * Prompt 34 — Product detail DTO mapper (§15/§16/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { dedupeProductSaleLines, stockStateOf } from "./summary";
import { parsePurchaseOrderStatus } from "@/lib/purchase-orders/types";
import type {
  ProductDetail,
  ProductRecentAdjustment,
  ProductRecentPurchaseOrder,
  ProductRecentSale,
  ProductRecentStocktake,
} from "./types";

export type ProductRecordRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  salePriceMinor: number;
  costPriceMinor: number;
  stockQty: number;
  lowStockAt: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductAdjustmentRow = {
  id: string;
  delta: number;
  reason: string;
  createdAt: Date;
};

export type ProductStocktakeLineRow = {
  stocktakeId: string;
  reference: string;
  status: string;
  varianceQty: number;
  countedAt: Date;
};

export type ProductSaleItemRow = {
  saleId: string;
  qty: number;
  lineTotalMinor: number;
  number: number;
  issueDate: Date;
};

/** Prompt 41 (§66) — bounded PO line row for Product detail. */
export type ProductPurchaseOrderLineRow = {
  purchaseOrderId: string;
  reference: string;
  status: string;
  supplierNameAtOrder: string;
  orderedAt: Date;
  orderedQty: number;
  unitPriceMinor: number;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
};

export function mapRecentAdjustments(
  rows: ProductAdjustmentRow[],
): ProductRecentAdjustment[] {
  return rows.map((row) => ({
    id: row.id,
    delta: row.delta,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}

export function mapRecentStocktakes(
  rows: ProductStocktakeLineRow[],
): ProductRecentStocktake[] {
  return rows.map((row) => ({
    stocktakeId: row.stocktakeId,
    reference: row.reference,
    status: row.status,
    varianceQty: row.varianceQty,
    countedAt: row.countedAt.toISOString(),
  }));
}

export function mapProductRecentSales(
  rows: ProductSaleItemRow[],
  cap: number,
): ProductRecentSale[] {
  // §15 — ≤ cap UNIQUE sale records via SaleItem → Sale (§42: bounded).
  return dedupeProductSaleLines(rows, cap).map((row) => ({
    saleId: row.saleId,
    number: row.number,
    issueDate:
      row.issueDate instanceof Date
        ? row.issueDate.toISOString()
        : new Date(row.issueDate).toISOString(),
    qty: row.qty,
    lineTotalMinor: row.lineTotalMinor,
  }));
}

export function mapProductDetail(
  record: ProductRecordRow,
  recentAdjustments: ProductAdjustmentRow[],
  recentSaleItems: ProductSaleItemRow[],
  recentSaleCap: number,
  recentStocktakeLines: ProductStocktakeLineRow[] = [],
  recentPurchaseOrderLines: ProductPurchaseOrderLineRow[] = [],
  // Prompt 42 (§120) — bounded receipt-line history passes through
  // verbatim (already mapped by the goods-receipt service).
  recentGoodsReceipts: ProductDetail["recentGoodsReceipts"] = [],
  // Prompt 43 (§99) — bounded return-line history passes through verbatim
  // (already mapped by the goods-return service).
  recentGoodsReturns: ProductDetail["recentGoodsReturns"] = [],
  // Prompt 44 — bounded dispatch-line history passes through verbatim
  // (already mapped by the goods-dispatch service).
  recentGoodsDispatches: ProductDetail["recentGoodsDispatches"] = [],
  // Prompt 45 (§72) — bounded sales-order history passes through verbatim
  // (already mapped by the sales-order service).
  recentSalesOrders: ProductDetail["recentSalesOrders"] = [],
): ProductDetail {
  return {
    product: {
      id: record.id,
      name: record.name,
      sku: record.sku,
      unit: record.unit,
      salePriceMinor: record.salePriceMinor,
      costPriceMinor: record.costPriceMinor,
      isActive: record.isActive,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    },
    inventory: {
      stockQty: record.stockQty,
      lowStockAt: record.lowStockAt,
      state: stockStateOf(record.stockQty, record.lowStockAt),
    },
    recentAdjustments: mapRecentAdjustments(recentAdjustments),
    recentSales: mapProductRecentSales(recentSaleItems, recentSaleCap),
    recentStocktakes: mapRecentStocktakes(recentStocktakeLines),
    recentPurchaseOrders: mapRecentPurchaseOrders(recentPurchaseOrderLines),
    recentGoodsReceipts,
    recentGoodsReturns,
    recentGoodsDispatches,
    recentSalesOrders,
  };
}

/** Prompt 41 (§66/§155) — ≤10 rows; snapshots carried verbatim (§236).
 * §13 — status passes the centralized parser: corrupt persisted status is
 * a controlled integrity error, never a silently faked lifecycle token.
 */
export function mapRecentPurchaseOrders(
  rows: ProductPurchaseOrderLineRow[],
): ProductRecentPurchaseOrder[] {
  return rows.map((row) => ({
    purchaseOrderId: row.purchaseOrderId,
    reference: row.reference,
    status: parsePurchaseOrderStatus(row.status),
    supplierNameAtOrder: row.supplierNameAtOrder,
    orderedAt: row.orderedAt.toISOString(),
    orderedQty: row.orderedQty,
    unitPriceMinor: row.unitPriceMinor,
    currencyCodeAtOrder: row.currencyCodeAtOrder,
    currencySymbolAtOrder: row.currencySymbolAtOrder,
    decimalPrecisionAtOrder: row.decimalPrecisionAtOrder,
  }));
}
