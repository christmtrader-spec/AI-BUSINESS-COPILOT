/**
 * Transaction-domain formatting helpers (Phase 03).
 * Pure functions — deterministic, unit-testable (Constitution §9).
 */

/** "INV-0001" display form for a per-business sequential invoice number. */
export function formatInvoiceNumber(number: number): string {
  if (!Number.isInteger(number) || number < 0) {
    throw new Error("Invoice number must be a non-negative integer");
  }
  return `INV-${String(number).padStart(4, "0")}`;
}

/** Parse "INV-0001" back to its numeric part (null when not parseable). */
export function parseInvoiceNumber(display: string): number | null {
  const m = /^INV-(\d+)$/i.exec(display.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}
