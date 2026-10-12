/**
 * Prompt 34 — Customer detail DTO mapper (§11/§12/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";

/** Closed stage tokens (Prompt 35 §6) — duplicated here ONLY as a literal
 * tuple so the mapper never depends on client-importable modules. */
const CRM_STAGE_TOKENS = ["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"] as const;
import type {
  CustomerCrmSection,
  CustomerDetail,
  CustomerOpportunityRef,
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

export type CustomerCrmRows = {
  openOpportunityCount: number;
  recentOpportunities: {
    id: string;
    title: string;
    stage: string;
    probabilityPct: number;
    expectedValueMinor: number;
    expectedCloseDate: Date | null;
  }[];
  leadOrigin: { id: string; name: string; convertedAt: Date | null } | null;
};

/** Prompt 35 (§44) — explicit CRM-section mapper (closed stage tokens). */
export function mapCustomerCrm(rows: CustomerCrmRows): CustomerCrmSection {
  return {
    openOpportunityCount: rows.openOpportunityCount,
    recentOpportunities: rows.recentOpportunities.map(
      (o): CustomerOpportunityRef => ({
        id: o.id,
        title: o.title,
        stage: (["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"] as const).includes(
          o.stage as (typeof CRM_STAGE_TOKENS)[number],
        )
          ? (o.stage as (typeof CRM_STAGE_TOKENS)[number])
          : "DISCOVERY",
        probabilityPct: o.probabilityPct,
        expectedValueMinor: o.expectedValueMinor,
        expectedCloseDate: o.expectedCloseDate ? o.expectedCloseDate.toISOString() : null,
      }),
    ),
    leadOrigin: rows.leadOrigin
      ? {
          id: rows.leadOrigin.id,
          name: rows.leadOrigin.name,
          convertedAt: rows.leadOrigin.convertedAt
            ? rows.leadOrigin.convertedAt.toISOString()
            : null,
        }
      : null,
  };
}

export function mapCustomerDetail(
  record: CustomerRecordRow,
  summary: CustomerSummary,
  recentSales: CustomerSaleRow[],
  recentPayments: CustomerPaymentRecordRow[],
  crm?: CustomerCrmSection,
  // Prompt 44 — bounded dispatch history passes through verbatim (already
  // mapped by the goods-dispatch service).
  recentGoodsDispatches: CustomerDetail["recentGoodsDispatches"] = [],
  // Prompt 45 (§71) — bounded sales-order history passes through verbatim
  // (already mapped by the sales-order service; commitment data that is
  // NEVER mixed into the financial summary §92).
  recentSalesOrders: CustomerDetail["recentSalesOrders"] = [],
  // Prompt 47 (§19) — bounded quotation history passes through verbatim
  // (already mapped by the sales-quotation service).
  recentSalesQuotations: CustomerDetail["recentSalesQuotations"] = [],
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
    recentGoodsDispatches,
    recentSalesOrders,
    recentSalesQuotations,
    // §44 — present but EMPTY for legacy callers; the detail route always
    // supplies the real bounded section.
    crm: crm ?? {
      openOpportunityCount: 0,
      recentOpportunities: [],
      leadOrigin: null,
    },
  };
}
