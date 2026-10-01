/**
 * Prompt 34 — Sale detail DTO mapper (§17/§22).
 * Produces EXACTLY the response shape the existing sales/[id] GET has
 * always returned — refactoring centralizes mapping without changing the
 * wire contract (the SaleDetailDialog depends on it).
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";
import type { SaleDetail, SaleItemLine, SalePaymentRow } from "./types";

export type SaleRecordRow = {
  id: string;
  number: number;
  customerId: string | null;
  customerName: string | null;
  issueDate: Date;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  paidMinor: number;
  status: string;
  note: string | null;
  createdAt: Date;
};

export type SaleItemRecordRow = {
  id: string;
  productId: string | null;
  name: string;
  unit: string | null;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
};

export type SalePaymentRecordRow = {
  id: string;
  amountMinor: number;
  method: string;
  note: string | null;
  paidAt: Date;
  actorName: string | null;
};

export function mapSaleItems(rows: SaleItemRecordRow[]): SaleItemLine[] {
  return rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    name: row.name,
    unit: row.unit,
    qty: row.qty,
    unitPriceMinor: row.unitPriceMinor,
    lineTotalMinor: row.lineTotalMinor,
  }));
}

export function mapSalePayments(
  rows: SalePaymentRecordRow[],
): SalePaymentRow[] {
  return rows.map((row) => ({
    id: row.id,
    amountMinor: row.amountMinor,
    method: toMethodToken(row.method),
    note: row.note,
    paidAt: row.paidAt.toISOString(),
    actorName: row.actorName,
  }));
}

export function mapSaleDetail(
  record: SaleRecordRow,
  items: SaleItemRecordRow[],
  payments: SalePaymentRecordRow[],
): SaleDetail {
  return {
    sale: {
      id: record.id,
      number: record.number,
      customerId: record.customerId,
      customerName: record.customerName,
      issueDate: record.issueDate.toISOString(),
      subtotalMinor: record.subtotalMinor,
      discountMinor: record.discountMinor,
      totalMinor: record.totalMinor,
      paidMinor: record.paidMinor,
      balanceMinor: balanceOf(record.totalMinor, record.paidMinor),
      status: toStatusToken(record.status),
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    },
    items: mapSaleItems(items),
    payments: mapSalePayments(payments),
  };
}
