/**
 * Pure filename-slug helpers (NO server-only, NO db) — safe to import from
 * both server routes AND pure unit scripts (bun scripts/*).
 *
 * Extracted from src/lib/inventory/stocktake/export.ts (which keeps the
 * server-only law because it touches the database) so the reference-slug
 * law stays unit-testable. The slug law is unchanged byte-for-byte.
 */

/**
 * Business-facing, filesystem-safe reference slug (never raw user input):
 * lowercase, [a-z0-9_-] only, collapsed dashes, trimmed, ≤40 chars, and
 * never empty (falls back to the module-level fallback token).
 */
export function referenceSlug(reference: string, fallback: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}
