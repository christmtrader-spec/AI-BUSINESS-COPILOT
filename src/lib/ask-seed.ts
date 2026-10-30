/**
 * R150 — the ask-seed cap law, ONE authority for every producer that seeds
 * the composer from FREE USER TEXT (the searcher's own words — not the
 * composed, surface-specific questions the R144→R149 family pins).
 *
 * Laws (battery: scripts/r150-search-ask-check.ts [1]):
 * - the COMPOSER's maxLength 500 is the cap authority — a seed longer than
 *   the composer can hold would be silently truncated by the textarea
 *   itself (a lying draft); slice HERE, visibly, at the source;
 * - trim FIRST (a paste with trailing whitespace is not part of the
 *   intent), then slice;
 * - a BLANK seed is dropped WHOLESALE by the CALLER (render nothing) —
 *   the empty string never navigates (the R144 blank-drops law, producer
 *   side);
 * - the store parser re-applies its own trim+slice on read (hashToView) —
 *   this helper is the producer-side mirror of that one law, not a second
 *   grammar.
 */
export function askSeedFromFreeText(raw: string): string {
  return raw.trim().slice(0, 500);
}
