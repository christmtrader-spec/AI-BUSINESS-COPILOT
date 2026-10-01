/**
 * Prompt 34 — Customer detail DTO mapper (§11/§12/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";
import type {
  CustomerDetail,
  CustomerRecentSale,
  CustomerSummary,
  RecentPaymentRow,
} from "./types";

/** Structural input row (compatible with the Prisma customer record). */
export type CustomerRecordRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  createdAt: Date;
};

export type CustomerSaleRow = {
  id: string;
  number: number;
  issueDate: Date;
  totalMinor: number;
  paidMinor: number;
  status: string;
};

export type CustomerPaymentRecordRow = {
  id: string;
  amountMinor: number;
  method: string;
  paidAt: Date;
  note: string | null;
};

export function mapRecentSales(rows: CustomerSaleRow[]): CustomerRecentSale[] {
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    issueDate: row.issueDate.toISOString(),
    totalMinor: row.totalMinor,
    paidMinor: row.paidMinor,
    balanceMinor: balanceOf(row.totalMinor, row.paidMinor),
    status: toStatusToken(row.status),
  }));
}

export function mapRecentPayments(
  rows: CustomerPaymentRecordRow[],
): RecentPaymentRow[] {
  return rows.map((row) => ({
    id: row.id,
    amountMinor: row.amountMinor,
    method: toMethodToken(row.method),
    paidAt: row.paidAt.toISOString(),
    note: row.note,
  }));
}

export function mapCustomerDetail(
  record: CustomerRecordRow,
  summary: CustomerSummary,
  recentSales: CustomerSaleRow[],
  recentPayments: CustomerPaymentRecordRow[],
): CustomerDetail {
  return {
    customer: {
      id: record.id,
      name: record.name,
      phone: record.phone,
      email: record.email,
      address: record.address,
      note: record.note,
      createdAt: record.createdAt.toISOString(),
    },
    summary,
    recentSales: mapRecentSales(recentSales),
    recentPayments: mapRecentPayments(recentPayments),
  };
}
