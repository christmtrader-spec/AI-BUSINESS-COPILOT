/**
 * Prompt 33 — deterministic search ranking (§7).
 *
 * Priority (conceptual weights, never exposed to the client):
 *   1. EXACT              1000 — full-field (title) equality with the query
 *   2. IDENTIFIER_EXACT    950 — invoice number / SKU equality
 *   3. PREFIX              800 — title or identifier starts with the query
 *   4. TITLE_CONTAINS      650 — title contains the query
 *   5. SECONDARY_CONTAINS  450 — email/phone/note/customer/supplier contains
 *
 * Recency is NOT a score component — it is only the deterministic
 * tie-breaker (createdAt descending, then id ascending, §7). The same
 * input always produces the same order.
 */
import type { SearchCandidate, SearchEntityType } from "./types";

export const RANK_WEIGHTS = {
  EXACT: 1000,
  IDENTIFIER_EXACT: 950,
  PREFIX: 800,
  TITLE_CONTAINS: 650,
  SECONDARY_CONTAINS: 450,
} as const;

export type RankReason = keyof typeof RANK_WEIGHTS;

/**
 * Score one candidate against the query variants (already normalized by
 * normalizeSearchText). Returns null when NOTHING matches — such
 * candidates are dropped before sorting (the DB prefilter is intentionally
 * wider than the final match decision).
 */
export function rankCandidate(
  candidate: SearchCandidate,
  variants: string[],
  numericQuery: number | null,
): RankReason | null {
  let best: RankReason | null = null;
  const better = (reason: RankReason) => {
    if (best === null || RANK_WEIGHTS[reason] > RANK_WEIGHTS[best]) best = reason;
  };

  for (const v of variants) {
    if (v.length === 0) continue;
    // 1 — exact full-field match on the title.
    if (candidate.titleNorm === v) better("EXACT");
    // 2 — exact identifier match (normalized or any numeric form).
    if (
      (candidate.identifierNorm !== null && candidate.identifierNorm === v) ||
      candidate.identifierExtras.includes(v)
    ) {
      better("IDENTIFIER_EXACT");
    }
    // Numeric invoice lookup: "25" matches Sale #25 exactly.
    if (
      numericQuery !== null &&
      candidate.numericIdentifier !== null &&
      candidate.numericIdentifier === numericQuery
    ) {
      better("IDENTIFIER_EXACT");
    }
    // 3 — prefix match on title or identifier.
    if (candidate.titleNorm.startsWith(v)) better("PREFIX");
    if (
      candidate.identifierNorm !== null &&
      candidate.identifierNorm.startsWith(v)
    ) {
      better("PREFIX");
    }
    // 4 — title contains.
    if (candidate.titleNorm.includes(v)) better("TITLE_CONTAINS");
    // 5 — secondary fields contain (email/phone/note/related names).
    if (candidate.secondaryNorms.some((s) => s.includes(v))) {
      better("SECONDARY_CONTAINS");
    }
  }

  return best;
}

/** Deterministic final sort: score ↓ · createdAt ↓ · id ↑ (§7, documented). */
export function compareRanked(
  a: { candidate: SearchCandidate; score: number },
  b: { candidate: SearchCandidate; score: number },
): number {
  if (a.score !== b.score) return b.score - a.score;
  const ta = a.candidate.createdAt.getTime();
  const tb = b.candidate.createdAt.getTime();
  if (ta !== tb) return tb - ta;
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

/**
 * Deduplication (§8) — identity is entity type + entity id. One entity may
 * match several fields; it appears exactly once. First occurrence wins
 * (the query builders emit at most one candidate per row, so this is a
 * belt-and-braces guarantee, not a ranking decision).
 */
export function dedupeCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  const out: SearchCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.type}:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Canonical group order (fixed vocabulary order — deterministic output). */
export function groupOrderByType(a: SearchEntityType, b: SearchEntityType): number {
  return a.localeCompare(b);
}
