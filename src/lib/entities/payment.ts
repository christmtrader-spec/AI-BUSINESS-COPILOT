/**
 * Prompt 34 — Payment detail DTO mapper (§19/§22/§69).
 * Tenant Payment ONLY — never PaymentTransaction/gateway internals.
 */

import { formatInvoiceNumber } from "@/lib/finance";
import { balanceOf, toDirectionToken, toMethodToken, toStatusToken } from "./summary";
import type { PaymentDetail, PaymentRelatedExpense, PaymentRelatedSale } from "./types";

export type PaymentRecordRow = {
  id: string;
  direction: string;
  amountMinor: number;
  method: string;
  note: string | null;
  paidAt: Date;
  createdAt: Date;
};

export type RelatedSaleRow = {
  id: string;
  number: number;
  customerId: string | null;
  customerName: string | null;
  totalMinor: number;
  paidMinor: number;
  status: string;
};

export type RelatedExpenseRow = {
  id: string;
  category: string;
  supplierId: string | null;
  supplierName: string | null;
  amountMinor: number;
  paidMinor: number;
  status: string;
};

export function mapRelatedSale(row: RelatedSaleRow | null): PaymentRelatedSale | null {
  if (!row) return null;
  return {
    id: row.id,
    // §17 — invoice formatting stays in lib/finance (single definition).
    formattedInvoiceNumber: formatInvoiceNumber(row.number),
    customerId: row.customerId,
    customerName: row.customerName,
    totalMinor: row.totalMinor,
    paidMinor: row.paidMinor,
    balanceMinor: balanceOf(row.totalMinor, row.paidMinor),
    status: toStatusToken(row.status),
  };
}

export function mapRelatedExpense(
  row: RelatedExpenseRow | null,
): PaymentRelatedExpense | null {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    amountMinor: row.amountMinor,
    paidMinor: row.paidMinor,
    balanceMinor: balanceOf(row.amountMinor, row.paidMinor),
    status: toStatusToken(row.status),
  };
}

export function mapPaymentDetail(
  record: PaymentRecordRow,
  relatedSale: RelatedSaleRow | null,
  relatedExpense: RelatedExpenseRow | null,
): PaymentDetail {
  return {
    payment: {
      id: record.id,
      direction: toDirectionToken(record.direction),
      amountMinor: record.amountMinor,
      method: toMethodToken(record.method),
      note: record.note,
      paidAt: record.paidAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
    },
    related: {
      sale: mapRelatedSale(relatedSale),
      expense: mapRelatedExpense(relatedExpense),
    },
  };
}
