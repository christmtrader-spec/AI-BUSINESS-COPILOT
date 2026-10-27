/**
 * R93 — the aging-details TABLE per-party sub-grouping: a pure, CLIENT-SAFE
 * reading of the SAME rows the page shows (no Prisma, no server imports —
 * the aging-details engine stays server-only; this module holds only the
 * presentation transform).
 *
 * ONE population (the server page items), TWO presentations (the flat list
 * / grouped by party). Grouping changes NO number and NO row — only their
 * arrangement — so it is presentation, not a filter: it stays LOCAL UI
 * state (the deep-link law covers population selectors; sort/arrangement
 * never enters the hash), and the CSV export stays flat (data, not
 * presentation).
 *
 * LAWS (each unit-proven in scripts/r93-aging-groups-unit.ts):
 *  1. GROUP ORDER reuses the EXACT R89 rollupRank comparator — outstanding
 *     desc (who owns the balance first) → name asc (null reads as "", the
 *     honest unassigned group sorts first on ties) → id asc. When the
 *     board and the table describe the same population (unfiltered page,
 *     board untruncated) they list parties in the SAME order by
 *     construction — never a second ranking law.
 *  2. WITHIN a group the server's row order is preserved VERBATIM — the
 *     signed-cursor order is the server's authority (age-anchored walk);
 *     the client never re-sorts rows.
 *  3. PARTITION EXACTNESS: every item appears exactly once; each group's
 *     count/outstanding/oldest reconcile with its own items (the mirror
 *     law — sum of group subtotals === flat sum over ANY input).
 *  4. The UNASSIGNED population (partyId null) is its own honest group
 *     (key "") — never attributed to a fabricated party, the R89 law.
 *  5. NO CAP: the page is already bounded by the server's page limit, so
 *     every party present in the page gets its group — the board remains
 *     the TOP-N summary (its AGING_DETAIL_ROLLUP_MAX_GROUPS cap is about
 *     ranking, not about hiding rows); the table groups the visible page
 *     completely. When the summary walk was truncated (summary.truncated)
 *     the BOARD is the honest whole-population view and the page is a
 *     window — the UI says so (the group subtotals cover THIS page).
 */

/** The row contract — a structural subset of AgingDetailItem (and of the
 *  view's DTO), so the grouping works over the engine's items AND the
 *  client's DTOs without importing either. */
export type AgingGroupableItem = {
  partyId: string | null;
  partyName: string | null;
  outstandingMinor: number;
  ageDays: number;
};

export type AgingPartyGroup<T extends AgingGroupableItem> = {
  partyId: string | null;
  partyName: string | null;
  /** Items in this group — the caller's own rows, server order preserved. */
  items: T[];
  count: number;
  /** Exact integer sum of the group's outstandingMinor (no float, no clamp). */
  outstandingMinor: number;
  /** The group's OLDEST open item (max ageDays) — the rollupAccumulate law. */
  oldestDays: number;
};

/** THE one comparator — lifted verbatim from rollupRank (aging-details.ts).
 *  Kept as a named export so the unit harness can prove the two call sites
 *  agree by identity, not by re-implementation. */
export function compareAgingGroups<T extends { outstandingMinor: number; partyName: string | null; partyId: string | null }>(
  a: T,
  b: T,
): number {
  return (
    b.outstandingMinor - a.outstandingMinor ||
    (a.partyName ?? "").localeCompare(b.partyName ?? "") ||
    (a.partyId ?? "").localeCompare(b.partyId ?? "")
  );
}

export function groupAgingItemsByParty<T extends AgingGroupableItem>(items: readonly T[]): AgingPartyGroup<T>[] {
  const byKey = new Map<string, AgingPartyGroup<T>>();
  for (const item of items) {
    const key = item.partyId ?? "";
    const prev = byKey.get(key);
    if (prev) {
      prev.items.push(item);
      prev.count += 1;
      prev.outstandingMinor += item.outstandingMinor;
      prev.oldestDays = Math.max(prev.oldestDays, item.ageDays);
    } else {
      byKey.set(key, {
        partyId: item.partyId,
        partyName: item.partyName,
        items: [item],
        count: 1,
        outstandingMinor: item.outstandingMinor,
        oldestDays: item.ageDays,
      });
    }
  }
  const groups = [...byKey.values()];
  groups.sort(compareAgingGroups);
  return groups;
}
