/**
 * Prompt 34 — Expense detail DTO mapper (§18/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";
import type { ExpenseDetail, ExpensePaymentRow } from "./types";

export type ExpenseRecordRow = {
  id: string;
  category: string;
  amountMinor: number;
  paidMinor: number;
  status: string;
  spentAt: Date;
  note: string | null;
  supplierId: string | null;
  supplierName: string | null;
  createdAt: Date;
};

export type ExpensePaymentRecordRow = {
  id: string;
  amountMinor: number;
  method: string;
  paidAt: Date;
  note: string | null;
  actorName: string | null;
};

export function mapExpensePayments(
  rows: ExpensePaymentRecordRow[],
): ExpensePaymentRow[] {
  return rows.map((row) => ({
    id: row.id,
    amountMinor: row.amountMinor,
    method: toMethodToken(row.method),
    paidAt: row.paidAt.toISOString(),
    note: row.note,
    actorName: row.actorName,
  }));
}

export function mapExpenseDetail(
  record: ExpenseRecordRow,
  payments: ExpensePaymentRecordRow[],
): ExpenseDetail {
  return {
    expense: {
      id: record.id,
      category: record.category,
      amountMinor: record.amountMinor,
      paidMinor: record.paidMinor,
      balanceMinor: balanceOf(record.amountMinor, record.paidMinor),
      status: toStatusToken(record.status),
      spentAt: record.spentAt.toISOString(),
      note: record.note,
      supplierId: record.supplierId,
      supplierName: record.supplierName,
      createdAt: record.createdAt.toISOString(),
    },
    payments: mapExpensePayments(payments),
  };
}
