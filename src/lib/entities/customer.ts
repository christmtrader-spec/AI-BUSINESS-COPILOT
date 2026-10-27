/**
 * Prompt 34 — Customer detail DTO mapper (§11/§12/§22).
 * Explicit field selection ONLY — never a Prisma object spread.
 */

import { balanceOf, toMethodToken, toStatusToken } from "./summary";
import { isPastDueDay } from "@/lib/reports-insights";
import { localDayIndex } from "@/lib/aging";

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
  // R90 — DRAFT rows arrive with a null issue day (honest absence).
  issueDate: Date | null;
  // R88 — stated terms ride the row so the 360 can speak the SAME overdue
  // law as the sales list (undefined = legacy row shape = termless).
  dueDate?: Date | null;
  totalMinor: number;
  paidMinor: number;
  status: string;
};

/** R88 — day-math context (business timezone + today's index). */
export type CustomerDayMathContext = { timeZone: string; todayIdx: number };

export type CustomerPaymentRecordRow = {
  id: string;
  amountMinor: number;
  method: string;
  paidAt: Date;
  note: string | null;
};

export function mapRecentSales(
  rows: CustomerSaleRow[],
  dayMath?: CustomerDayMathContext,
): CustomerRecentSale[] {
  return rows.map((row) => {
    // R88 — the breach law, shared gate (reports-insights isPastDueDay):
    // stated terms + open balance + due day STRICTLY before today's
    // business day. The floor law: due TODAY is never overdue; past-due
    // days floor at 1. No ctx / no terms / settled → honest silence —
    // never a fabricated flag (the legacy no-ctx caller stays valid).
    const dueDate = row.dueDate ?? null;
    const balance = balanceOf(row.totalMinor, row.paidMinor);
    const overdue =
      // R90 — a DRAFT is pre-issuance money: never overdue on the 360.
      row.status !== "DRAFT" &&
      balance > 0 &&
      dueDate !== null &&
      dayMath !== undefined &&
      isPastDueDay(dueDate, dayMath.todayIdx, dayMath.timeZone);
    return {
      id: row.id,
      number: row.number,
      // R90 — a draft's issue day is honestly absent (null passthrough).
      issueDate: row.issueDate ? row.issueDate.toISOString() : null,
      dueDate: dueDate ? dueDate.toISOString() : null,
      totalMinor: row.totalMinor,
      paidMinor: row.paidMinor,
      balanceMinor: balance,
      status: toStatusToken(row.status),
      overdue,
      overdueDays: overdue
        ? Math.max(1, dayMath!.todayIdx - localDayIndex(dueDate!, dayMath!.timeZone))
        : null,
    };
  });
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
  // Prompt 49 (§17) — canonical receivables-aging overview for THIS customer
  // (computed by the caller from the canonical aging engine; bounded scan).
  receivablesAging: CustomerDetail["receivablesAging"] = undefined,
  // R88 — the customer's receivables BREACH strip, forwarded VERBATIM from
  // the service count. ABSENT when not supplied (the legacy-caller honest
  // absence law — never a fabricated zero where no scan ran).
  overdueStrip?: { count: number; outstandingMinor: number },
  // R88 — day-math ctx passed to mapRecentSales so the 360 rows speak the
  // SAME overdue law (legacy callers omit it → honest silence per row).
  dayMath?: CustomerDayMathContext,
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
    recentSales: mapRecentSales(recentSales, dayMath),
    recentPayments: mapRecentPayments(recentPayments),
    recentGoodsDispatches,
    recentSalesOrders,
    recentSalesQuotations,
    receivablesAging,
    // R88 — the strip facts ride additively ONLY when a caller supplied
    // them; legacy callers see honest absence (undefined), never zeros.
    ...(overdueStrip
      ? {
          overdueSaleCount: overdueStrip.count,
          overdueSalesOutstandingMinor: overdueStrip.outstandingMinor,
        }
      : {}),
    // §44 — present but EMPTY for legacy callers; the detail route always
    // supplies the real bounded section.
    crm: crm ?? {
      openOpportunityCount: 0,
      recentOpportunities: [],
      leadOrigin: null,
    },
  };
}
