/**
 * Prompt 34 — Supplier detail DTO mapper (§13/§14/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";
import type {
  RecentPaymentRow,
  SupplierDetail,
  SupplierRecentExpense,
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
  };
}
