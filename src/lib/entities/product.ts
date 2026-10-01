/**
 * Prompt 34 — Product detail DTO mapper (§15/§16/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { dedupeProductSaleLines, stockStateOf } from "./summary";
import type {
  ProductDetail,
  ProductRecentAdjustment,
  ProductRecentSale,
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

export type ProductSaleItemRow = {
  saleId: string;
  qty: number;
  lineTotalMinor: number;
  number: number;
  issueDate: Date;
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
  };
}
