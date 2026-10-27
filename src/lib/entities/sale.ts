/**
 * Prompt 34 — Sale detail DTO mapper (§17/§22).
 * Produces EXACTLY the response shape the existing sales/[id] GET has
 * always returned — refactoring centralizes mapping without changing the
 * wire contract (the SaleDetailDialog depends on it).
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";
import { isPastDueDay } from "@/lib/reports-insights";
import type { SaleDetail, SaleItemLine, SalePaymentRow } from "./types";

export type SaleRecordRow = {
  id: string;
  number: number;
  customerId: string | null;
  customerName: string | null;
  issueDate: Date;
  // R81 — stated payment terms (date-only §84 midnoon instant). Null = no
  // terms stated → the DTO honestly stays AGING-framed, never "overdue".
  dueDate: Date | null;
  subtotalMinor: number;
  discountMinor: number;
  taxRateBp: number;
  taxMinor: number;
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

/**
 * Day-math context for stated-terms honesty (R81). Callers that HAVE the
 * business timezone + today's index pass it; legacy callers that omit it
 * degrade HONESTLY to overdue:false (never a fabricated "overdue").
 */
export type SaleDayMathContext = { timeZone: string; todayIdx: number };

export function mapSaleDetail(
  record: SaleRecordRow,
  items: SaleItemRecordRow[],
  payments: SalePaymentRecordRow[],
  dayMath?: SaleDayMathContext,
): SaleDetail {
  // Stated-terms law (R81, shared gate from reports-insights): an invoice is
  // "overdue" ONLY when terms were stated (dueDate non-null) AND the balance
  // is open (paid < total — PAID invoices never overdue) AND the due day is
  // STRICTLY BEFORE today's business-timezone day (isPastDueDay). No stated
  // terms or no day-math context → overdue:false (AGING framing).
  const balance = balanceOf(record.totalMinor, record.paidMinor);
  const overdue =
    balance > 0 &&
    record.dueDate !== null &&
    dayMath !== undefined &&
    isPastDueDay(record.dueDate, dayMath.todayIdx, dayMath.timeZone);
  return {
    sale: {
      id: record.id,
      number: record.number,
      customerId: record.customerId,
      customerName: record.customerName,
      issueDate: record.issueDate.toISOString(),
      // Date-only semantics: the §84 midnoon instant renders the same
      // calendar day in every display timezone.
      dueDate: record.dueDate ? record.dueDate.toISOString() : null,
      subtotalMinor: record.subtotalMinor,
      discountMinor: record.discountMinor,
      taxRateBp: record.taxRateBp,
      taxMinor: record.taxMinor,
      totalMinor: record.totalMinor,
      paidMinor: record.paidMinor,
      balanceMinor: balance,
      status: toStatusToken(record.status),
      overdue,
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    },
    items: mapSaleItems(items),
    payments: mapSalePayments(payments),
  };
}
