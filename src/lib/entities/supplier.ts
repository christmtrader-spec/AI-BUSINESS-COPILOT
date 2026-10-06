/**
 * Prompt 34 — Supplier detail DTO mapper (§13/§14/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";
import {
  computePurchaseOrderTotal,
  parsePurchaseOrderStatus,
} from "@/lib/purchase-orders/types";
import type { PurchaseOrderStatus } from "@/lib/purchase-orders/types";
import type {
  RecentPaymentRow,
  SupplierDetail,
  SupplierRecentExpense,
  SupplierRecentPurchaseOrder,
  SupplierSummary,
} from "./types";

export type SupplierRecordRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  createdAt: Date;
};

export type SupplierExpenseRow = {
  id: string;
  category: string;
  spentAt: Date;
  amountMinor: number;
  paidMinor: number;
  status: string;
};

export type SupplierPaymentRecordRow = {
  id: string;
  amountMinor: number;
  method: string;
  paidAt: Date;
  note: string | null;
};

/** Prompt 41 (§65) — bounded PO row for Supplier 360. */
export type SupplierPurchaseOrderRow = {
  id: string;
  reference: string;
  status: string;
  orderedAt: Date;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  lines: Array<{ orderedQty: number; unitPriceMinor: number }>;
};

export function mapRecentExpenses(
  rows: SupplierExpenseRow[],
): SupplierRecentExpense[] {
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    spentAt: row.spentAt.toISOString(),
    amountMinor: row.amountMinor,
    paidMinor: row.paidMinor,
    balanceMinor: balanceOf(row.amountMinor, row.paidMinor),
    status: toStatusToken(row.status),
  }));
}

export function mapSupplierPayments(
  rows: SupplierPaymentRecordRow[],
): RecentPaymentRow[] {
  return rows.map((row) => ({
    id: row.id,
    amountMinor: row.amountMinor,
    method: toMethodToken(row.method),
    paidAt: row.paidAt.toISOString(),
    note: row.note,
  }));
}

export function mapSupplierDetail(
  record: SupplierRecordRow,
  summary: SupplierSummary,
  recentExpenses: SupplierExpenseRow[],
  recentPayments: SupplierPaymentRecordRow[],
  recentPurchaseOrders: SupplierPurchaseOrderRow[] = [],
): SupplierDetail {
  return {
    supplier: {
      id: record.id,
      name: record.name,
      phone: record.phone,
      email: record.email,
      address: record.address,
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    },
    summary,
    recentExpenses: mapRecentExpenses(recentExpenses),
    recentPayments: mapSupplierPayments(recentPayments),
    recentPurchaseOrders: mapSupplierPurchaseOrders(recentPurchaseOrders),
  };
}

/**
 * Prompt 41 (§65/§154) — ≤10 rows; totals derived with the ONE canonical
 * BigInt function (§18 — no second math, no silent rounding); status goes
 * through the centralized parser (§13 — corrupt status never renders as a
 * fake lifecycle token).
 */
export function mapSupplierPurchaseOrders(
  rows: SupplierPurchaseOrderRow[],
): SupplierRecentPurchaseOrder[] {
  return rows.map((row) => {
    const totals = computePurchaseOrderTotal(row.lines);
    const status: PurchaseOrderStatus = parsePurchaseOrderStatus(row.status);
    return {
      id: row.id,
      reference: row.reference,
      status,
      orderedAt: row.orderedAt.toISOString(),
      currencyCodeAtOrder: row.currencyCodeAtOrder,
      currencySymbolAtOrder: row.currencySymbolAtOrder,
      decimalPrecisionAtOrder: row.decimalPrecisionAtOrder,
      totalQty: totals.totalQty,
      totalMinor: totals.totalMinor,
    };
  });
}
