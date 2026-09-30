/**
 * Prompt 33 — pure search-text normalization (§4.3).
 *
 * Deterministic, side-effect-free, Unicode-aware:
 * - NFKC normalization (full-width → ASCII, compatibility forms)
 * - Arabic/Persian compatibility: ي→ی, ك→ک (Persian-first canonical form)
 * - Persian/Arabic digits → Latin digits (numeric identifiers)
 * - zero-width formatting noise removed
 * - whitespace collapsed, Latin lowercased
 *
 * Meaningful user content is never destroyed: only formatting noise and
 * script/digit variants are unified. Pure functions — unit-tested by
 * scripts/prompt33-unit.ts.
 */

/** Zero-width / invisible formatting characters stripped from queries. */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/** Control characters and null bytes (§16 hygiene) — never meaningful. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function toLatinDigits(value: string): string {
  let out = "";
  for (const ch of value) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Canonical form used for ranking, comparison and DB prefiltering.
 * Idempotent: normalizeSearchText(normalizeSearchText(x)) === normalizeSearchText(x).
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/[\u064A\u0649]/g, "\u06CC") // ي ى → ی
    .replace(/\u0643/g, "\u06A9") // ك → ک
    .replace(/[\u0640]/g, "") // tatweel elongation noise
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split("")
    .map(toLatinDigits)
    .join("");
}

/**
 * Bounded search variants for a normalized query (§4.3):
 * the canonical form plus at most ONE Arabic compatibility variant
 * (ی→ي, ک→ك) so DB LIKE prefilters can hit rows stored in Arabic script.
 * No combinatorial explosion — at most 2 variants, deduplicated.
 */
export function getSearchVariants(normalized: string): string[] {
  const variants = [normalized];
  const compat = normalized
    .replace(/\u06CC/g, "\u064A") // ی → ي
    .replace(/\u06A9/g, "\u0643"); // ک → ك
  if (compat !== normalized && compat.length > 0) variants.push(compat);
  return variants;
}

/**
 * Extract a numeric invoice lookup from a normalized query (§5.4):
 * "INV-0001" → 1 · "inv-25" → 25 · "25" → 25 · "001" → 1 · "abc" → null.
 * Bounded to ≤9 digits so absurd inputs can never reach an Int column.
 */
export function extractInvoiceNumberQuery(normalizedQuery: string): number | null {
  const m = /^(?:inv-)?(\d{1,9})$/.exec(normalizedQuery.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
