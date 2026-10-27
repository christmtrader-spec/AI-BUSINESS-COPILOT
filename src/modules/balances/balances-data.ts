"use client";

import { api } from "@/lib/api-client";
// R96 — ONE extractor for both routes' leaders facts (client-safe by
// construction — the module has zero imports, the r93 law).
import { topLeaderOfFact, type BookLeaderView, type LeadersFactInput } from "@/lib/leader-view";

/**
 * Shared fetch + transform for the balances views (receivables / payables).
 *
 * IMPORTANT for prefetch warming: the query cache MUST hold the TRANSFORMED
 * shape (`BalancesData`), not the raw API response — the view renders
 * `byParty` and mapped items. Both the view's queryFn and the shell
 * prefetcher use this function so the cached shape can never diverge
 * (a raw-shape cache entry crashed the view via `byParty[0]` in r8 QA).
 */

export type BalanceItem = {
  id: string;
  label1: string; // INV-0001 | category
  label2: string | null; // customer | supplier
  date: string;
  amountMinor: number;
  paidMinor: number;
  balanceMinor: number;
  status: string;
  /** Payables only — supplier-bill terms (aging round). */
  dueDate?: string | null;
  reference?: string | null;
  /** Payables only — SERVER-derived (business tz); the UI never computes it. */
  pastDue?: boolean;
};

export type BalancesData = {
  totalOutstandingMinor: number;
  openCount: number;
  items: BalanceItem[];
  byParty: { name: string; balanceMinor: number }[];
  /** R96 — rank 1 of the book-leaders fact, extracted by the ONE shared
   *  extractor (null when the fact is silent — never a fabricated leader). */
  topLeader: BookLeaderView | null;
};

export function fetchBalancesData(kind: "receivables" | "payables"): Promise<BalancesData> {
  if (kind === "receivables") {
    return api<{
      totalOutstandingMinor: number;
      openCount: number;
      items: {
        id: string;
        number: number;
        customerName: string | null;
        issueDate: string;
        totalMinor: number;
        paidMinor: number;
        balanceMinor: number;
        status: string;
      }[];
      byCustomer: { name: string; balanceMinor: number }[];
      // R96 — the debtors leaders fact (server-ranked, verbatim head).
      leaders: LeadersFactInput;
    }>("/api/v1/receivables").then((raw) => ({
      totalOutstandingMinor: raw.totalOutstandingMinor,
      openCount: raw.openCount,
      byParty: raw.byCustomer,
    // R96 — BOTH routes map their leaders fact through the ONE extractor.
    topLeader: topLeaderOfFact(raw.leaders),
      items: raw.items.map<BalanceItem>((s) => ({
        id: s.id,
        label1: `INV-${String(s.number).padStart(4, "0")}`,
        label2: s.customerName,
        date: s.issueDate,
        amountMinor: s.totalMinor,
        paidMinor: s.paidMinor,
        balanceMinor: s.balanceMinor,
        status: s.status,
      })),
    }));
  }

  return api<{
    totalOutstandingMinor: number;
    openCount: number;
    items: {
      id: string;
      category: string;
      supplierName: string | null;
      spentAt: string;
      dueDate: string | null;
      reference: string | null;
      pastDue: boolean;
      amountMinor: number;
      paidMinor: number;
      balanceMinor: number;
      status: string;
    }[];
    bySupplier: { name: string; balanceMinor: number }[];
    // R96 — the creditors leaders fact (server-ranked, verbatim head).
    leaders: LeadersFactInput;
  }>("/api/v1/payables").then((raw) => ({
    totalOutstandingMinor: raw.totalOutstandingMinor,
    openCount: raw.openCount,
    byParty: raw.bySupplier,
    // R96 — BOTH routes map their leaders fact through the ONE extractor.
    topLeader: topLeaderOfFact(raw.leaders),
    items: raw.items.map<BalanceItem>((e) => ({
      id: e.id,
      label1: e.category,
      label2: e.supplierName,
      date: e.spentAt,
      amountMinor: e.amountMinor,
      paidMinor: e.paidMinor,
      balanceMinor: e.balanceMinor,
      status: e.status,
      dueDate: e.dueDate,
      reference: e.reference,
      pastDue: e.pastDue,
    })),
  }));
}
