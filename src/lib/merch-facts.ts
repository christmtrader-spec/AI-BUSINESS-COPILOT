/**
 * R98 — THE BEST-SELLER: pure merchandise-fact extractors (ZERO imports —
 * client-safe by construction, proven by the r98 unit harness's static
 * scan, exactly like src/lib/leader-view.ts).
 *
 * The report summary (src/lib/reports.ts) already ranks the window's best
 * sellers (topProducts: revenue desc, tie → productId/name) and the
 * biggest cost categories (expensesByCategory: total desc, tie →
 * category). These extractors hand the copilot meta the FIRST entry of
 * those lists VERBATIM — the server's own order IS the ranking; these
 * functions NEVER re-rank, re-sort, dedupe, or aggregate.
 *
 * Silence law: an empty (or absent) list → null. A truncated read is
 * impossible here by construction — topProducts/expensesByCategory are
 * windowed top-N facts (top 5 / top 6), never truncated whole-book
 * scans — but the absent-shape guard still maps to null so an unexpected
 * payload degrades to honest silence, never a crash and never a wrong
 * leader.
 */

/**
 * The copilot meta's top-product view (R98): the report's own rank 1.
 * R153 — the view grows the stable catalog identity (ADDITIVE — r98's
 * shape law re-pinned to 4 fields in the same round): the report row
 * already carries `productId` (the Prompt 50 aggregation key), so the
 * view passes it through VERBATIM instead of dropping it. `null` = the
 * unlinked mass (a snapshot name with no catalog row) — carried, but the
 * client picker refuses to drill it (the R96 mass law, exactly like
 * R147's null partyId). The FACT never depended on the id; only the
 * DRILL does.
 */
export type TopProductView = {
  name: string;
  unitsSold: number;
  revenueMinor: number;
  productId: string | null;
};

/** The copilot meta's top-expense-category view (R98): the report's own
 *  rank 1. */
export type TopCategoryView = {
  category: string;
  totalMinor: number;
};

/**
 * The window's best-selling product — the report's FIRST entry verbatim.
 * The report ranks by revenue (desc, tie → identity); this function must
 * never see a different order, so it preserves entries[0] byte-for-byte.
 * Guards: null/undefined/non-array → null; empty → null; an entry whose
 * name is not a non-empty string → null (an unnamed rank 1 is not a
 * nameable fact — honest silence beats a "best seller" with no name).
 */
export function topProductOf(
  products: readonly {
    name: unknown;
    qty: unknown;
    revenueMinor: unknown;
    productId?: unknown;
  }[]
    | null
    | undefined,
): TopProductView | null {
  if (!Array.isArray(products) || products.length === 0) return null;
  const first = products[0] as {
    name?: unknown;
    qty?: unknown;
    revenueMinor?: unknown;
    productId?: unknown;
  };
  if (typeof first?.name !== "string" || first.name.trim().length === 0) return null;
  if (typeof first.qty !== "number" || !Number.isFinite(first.qty)) return null;
  if (
    typeof first.revenueMinor !== "number" ||
    !Number.isFinite(first.revenueMinor)
  )
    return null;
  return {
    name: first.name,
    unitsSold: first.qty,
    revenueMinor: first.revenueMinor,
    // R153 — the drill id: a non-blank string rides VERBATIM; anything
    // else (null for the unlinked mass, a missing key on old rows, or an
    // ill-typed value) degrades to null — honest silence for the DRILL,
    // never a navigation that rides a name or a fabricated id.
    productId:
      typeof first.productId === "string" && first.productId.trim().length > 0
        ? first.productId
        : null,
  };
}

/**
 * The window's biggest cost category — the report's FIRST entry verbatim
 * (the report ranks by total desc, tie → category name). Same guard law
 * as topProductOf: an absent/empty list or a blank category degrades to
 * honest silence.
 */
export function topCategoryOf(
  categories:
    | readonly { category: unknown; totalMinor: unknown }[]
    | null
    | undefined,
): TopCategoryView | null {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  const first = categories[0] as { category?: unknown; totalMinor?: unknown };
  if (typeof first?.category !== "string" || first.category.trim().length === 0)
    return null;
  if (
    typeof first.totalMinor !== "number" ||
    !Number.isFinite(first.totalMinor)
  )
    return null;
  return { category: first.category, totalMinor: first.totalMinor };
}
