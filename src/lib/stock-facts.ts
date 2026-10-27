/**
 * R102 — THE STOCK THRONE FACTS (the copilot chip + summary-card citation's
 * pure mapping layer). ZERO imports — deterministic, client-safe by
 * construction (the same law as src/lib/merch-facts.ts and
 * src/lib/leader-view.ts).
 *
 * ONE AUTHORITY NOTE: the RANKING itself never lives here — the server
 * ranks through the Prompt 51 valuation service's own
 * `computeInventoryTopValueProducts` (VALUE_DESC + stable-id tie-break)
 * inside `buildReportSummary`, so the crowned rank 1 can never disagree
 * with the detailed valuation table. This module only MAPS the verdict:
 *   - `topStockProductOf` — the rank-1 view for the copilot meta (verbatim,
 *     never re-ranked, guarded → honest silence),
 *   - `stockSharePercent` — the share-of-stock-value bar math with the
 *     house gates (a zero or negative basis stays silent, the fill never
 *     exceeds 100).
 */

/** The rank-1 view the copilot chip + the summary card cite. `id` is the
 *  STABLE product id (the identity law — navigation never rides a name). */
export type TopStockView = {
  id: string;
  name: string;
  valueMinor: number;
};

/** Structural input shape — matches the valuation service's
 *  `InventoryTopValueProduct` without importing the server module. */
export type StockThroneEntry = {
  productId: string;
  name: string;
  estimatedValueMinor: number;
};

/**
 * The rank-1 view of the server's own throne list — VERBATIM (never
 * re-ranked, never re-computed). Guard law = deterministic silence:
 *   - absent / empty list → null,
 *   - blank or whitespace-only name → null (an unnamed crown would be a
 *     chip about nothing),
 *   - non-finite value → null (the arithmetic never lies).
 * A zero or NEGATIVE value is kept VERBATIM (an all-zero-cost book's
 * throne is a real fact the prose may cite) — the UI layers gate the
 * celebration (chips/bars render only on valueMinor > 0).
 */
export function topStockProductOf(
  list: readonly StockThroneEntry[] | null | undefined,
): TopStockView | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const head = list[0];
  if (
    !head ||
    typeof head.productId !== "string" ||
    head.productId.length === 0 ||
    typeof head.name !== "string" ||
    head.name.trim().length === 0 ||
    typeof head.estimatedValueMinor !== "number" ||
    !Number.isFinite(head.estimatedValueMinor)
  ) {
    return null;
  }
  return {
    id: head.productId,
    name: head.name,
    valueMinor: head.estimatedValueMinor,
  };
}

/**
 * R103 — the RUNNER-UP view: the throne's rank 2 under the EXACT same
 * guard law as `topStockProductOf` (absent/short list → null — a throne
 * of one has no runner-up, and padding one would be a lie; blank or
 * whitespace-only name → null; non-finite value → null). A zero or
 * NEGATIVE value is kept VERBATIM (the same all-zero-book honesty as
 * rank 1) — the UI layers gate the celebration (the Medal chip renders
 * only on valueMinor > 0).
 */
export function stockRunnerUpOf(
  list: readonly StockThroneEntry[] | null | undefined,
): TopStockView | null {
  if (!Array.isArray(list) || list.length < 2) return null;
  const second = list[1];
  if (
    !second ||
    typeof second.productId !== "string" ||
    second.productId.length === 0 ||
    typeof second.name !== "string" ||
    second.name.trim().length === 0 ||
    typeof second.estimatedValueMinor !== "number" ||
    !Number.isFinite(second.estimatedValueMinor)
  ) {
    return null;
  }
  return {
    id: second.productId,
    name: second.name,
    valueMinor: second.estimatedValueMinor,
  };
}

/**
 * The share-of-stock-value bar math: rank value ÷ the SAME response's own
 * inventory total (same basis by construction — the throne and the total
 * walk the same complete row set). Gates:
 *   - totalMinor ≤ 0 → null (an empty or all-negative book has no honest
 *     denominator — the R99 panel law: skipped on negative arithmetic),
 *   - valueMinor ≤ 0 → null (nothing to celebrate),
 *   - the fill caps at 100 (a lone leader on a shrunken — e.g. negative
 *     offset — basis can exceed 100 arithmetically; the bar never lies).
 */
export function stockSharePercent(
  valueMinor: number,
  totalMinor: number,
): number | null {
  if (!Number.isFinite(valueMinor) || !Number.isFinite(totalMinor)) return null;
  if (totalMinor <= 0 || valueMinor <= 0) return null;
  return Math.min(100, Math.round((valueMinor / totalMinor) * 100));
}
