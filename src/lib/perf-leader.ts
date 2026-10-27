/**
 * R101 — the LEADER FACT (pure, ZERO-IMPORT extractor for the performance
 * panel's leader strip — the R99 throne grammar's fourth surface).
 *
 * The panel cites its OWN rank 1: the server orders product/customer
 * (sales) and category/supplier (expenses) groups value-DESC with a
 * stable tie-break BEFORE the group cap (report-performance.ts), so
 * groups[0] IS the true rank 1 under any client sort. This extractor
 * VERBALIZES that head — it NEVER re-ranks (the R98 merch law: the
 * response's own rank 1 verbatim; a re-rank could crown a name the
 * table's server order disagrees with).
 *
 * Silence laws (honest silence, never a padded crown):
 *  - truncated  → null (the R98 truncation-silence law: a share of a
 *    partial total is a wrong number).
 *  - cashflow   → null (rows are KEYSET-PAGED — a rank over page 1 is
 *    not the true rank).
 *  - day/month  → null (chronological buckets — groups[0] is the OLDEST
 *    bucket, not a leader; crowning it would be a lie).
 *  - empty groups → null.
 *  - blank rank-1 name → null (a crown needs a name; the R98 trim law).
 *  - non-finite rank value or total → null.
 *
 * Identity law: the drill rides a STABLE id only — unlinked products,
 * unassigned customers and anonymous suppliers render the citation
 * WITHOUT a destination (drill: null; the UI then renders a static
 * strip, never a button that fakes a page).
 *
 * Basis law: the strip's money IS the rank's own sort key (product →
 * netValueMinor over totals.netLineValueMinor — the table's default
 * sort column; customer → revenueMinor; category/supplier →
 * amountMinor). Same basis by construction, so the share bar is honest;
 * the R98 share COLUMN keeps its own line-value basis — the two may
 * differ for discounted products, each correct on its own basis.
 *
 * The unassigned mass CAN legitimately lead (the dashboard
 * TileLeaderLine precedent): the caller's fallback name (the UI's
 * "no customer/supplier recorded" string) renders and the drill stays
 * null — a citation without a fake destination.
 */

export type PerfLeaderDrill = {
  entity: "customer" | "supplier" | "product";
  id: string;
};

export type PerfLeaderFact = {
  /** The rank-1 display name (verbatim, or the caller's fallback for the
   *  unassigned mass — never padded, never re-ranked). */
  name: string;
  /** The rank's own sort-key value (minor units) — the money shown. */
  valueMinor: number;
  /** The response's OWN window total on the SAME basis (minor units). */
  totalMinor: number;
  /** Stable-entity destination, or null when the rank-1 has no identity. */
  drill: PerfLeaderDrill | null;
};

/** Structural input — exactly the /api/v1/reports/performance response
 *  shapes the panel already consumes (TS structural typing; no imports). */
export type PerfLeaderInput =
  | {
      kind: "sales";
      truncated: boolean;
      groupBy: "product" | "customer" | "day" | "month";
      totals: {
        revenueMinor: number;
        invoiceCount: number;
        lineValueMinor: number;
        discountMinor: number;
        netLineValueMinor: number;
      };
      groups: Array<
        | {
            dimension: "product";
            productId: string | null;
            kind: "catalog" | "unlinked";
            name: string;
            qtySold: number;
            invoiceCount: number;
            lineValueMinor: number;
            netValueMinor: number;
          }
        | {
            dimension: "customer";
            customerId: string | null;
            name: string | null;
            invoiceCount: number;
            revenueMinor: number;
          }
        | { dimension: "day"; date: string; invoiceCount: number; revenueMinor: number }
        | { dimension: "month"; month: string; invoiceCount: number; revenueMinor: number }
      >;
    }
  | {
      kind: "expenses";
      truncated: boolean;
      groupBy: "category" | "supplier" | "day" | "month";
      totals: { amountMinor: number; expenseCount: number };
      groups: Array<
        | { dimension: "category"; category: string; expenseCount: number; amountMinor: number }
        | {
            dimension: "supplier";
            supplierId: string | null;
            name: string | null;
            expenseCount: number;
            amountMinor: number;
          }
        | { dimension: "day"; date: string; expenseCount: number; amountMinor: number }
        | { dimension: "month"; month: string; expenseCount: number; amountMinor: number }
      >;
    }
  | { kind: "cashflow"; truncated: boolean };

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

const named = (s: string | null | undefined): string | null => {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t ? t : null;
};

/**
 * Extract the leader fact from the panel's OWN response — groups[0]
 * verbatim (never re-ranks) under the silence laws above.
 *
 * @param data    the performance response the panel already holds
 * @param fallbackName the UI string for the unassigned mass (customer/
 *   supplier rows with no identity) — used verbatim, never padded
 */
export function perfLeaderFact(
  data: PerfLeaderInput,
  fallbackName: string,
): PerfLeaderFact | null {
  // Truncation-silence: a share of a partial total is a wrong number.
  if (data.truncated) return null;
  // Paged rows: a rank over page 1 is not the true rank.
  if (data.kind === "cashflow") return null;

  if (data.kind === "sales") {
    const head = data.groups[0];
    if (!head) return null;
    // Chronological buckets — the head is the OLDEST bucket, not a leader.
    if (head.dimension === "day" || head.dimension === "month") return null;
    if (head.dimension === "product") {
      const name = named(head.name);
      if (!name) return null;
      if (!finite(head.netValueMinor) || !finite(data.totals.netLineValueMinor)) return null;
      return {
        name,
        valueMinor: head.netValueMinor,
        totalMinor: data.totals.netLineValueMinor,
        drill: head.productId ? { entity: "product", id: head.productId } : null,
      };
    }
    // customer
    if (!finite(head.revenueMinor) || !finite(data.totals.revenueMinor)) return null;
    const name = named(head.name) ?? named(fallbackName);
    if (!name) return null;
    return {
      name,
      valueMinor: head.revenueMinor,
      totalMinor: data.totals.revenueMinor,
      drill: head.customerId ? { entity: "customer", id: head.customerId } : null,
    };
  }

  // expenses
  const head = data.groups[0];
  if (!head) return null;
  if (head.dimension === "day" || head.dimension === "month") return null;
  if (!finite(head.amountMinor) || !finite(data.totals.amountMinor)) return null;
  if (head.dimension === "category") {
    const name = named(head.category);
    if (!name) return null;
    return {
      name,
      valueMinor: head.amountMinor,
      totalMinor: data.totals.amountMinor,
      // A category is a plain string — no stable entity id exists, so
      // the citation never fakes a destination (the identity law).
      drill: null,
    };
  }
  // supplier
  const name = named(head.name) ?? named(fallbackName);
  if (!name) return null;
  return {
    name,
    valueMinor: head.amountMinor,
    totalMinor: data.totals.amountMinor,
    drill: head.supplierId ? { entity: "supplier", id: head.supplierId } : null,
  };
}
