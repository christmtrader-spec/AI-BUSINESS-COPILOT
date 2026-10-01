/**
 * Prompt 35 — input normalization + date-only interpretation (§84).
 *
 * expectedCloseDate UX is DATE-ONLY. Interpreted as UTC MIDDAY ("T12:00:00Z")
 * so that neither UTC nor any realistic display timezone (UTC−11 … UTC+14)
 * can shift 2026-10-10 into 2026-10-09 (§84 — documented deterministic rule).
 * Stored as a UTC DateTime; rendering uses the existing date helpers.
 */
import { isLeadSource, isLeadStatus, isOpportunityStage, type LeadSource, type LeadStatus, type OpportunityStage } from "./types";

/** Parse a date-only (or full ISO) string into a UTC-midnoon Date (§84). */
export function parseExpectedCloseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** ISO string for DTOs; null passthrough. */
export function toIsoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Closed-enum coercion for DB rows that may pre-date validation (§79). */
export function leadStatusOf(value: string): LeadStatus {
  return isLeadStatus(value) ? value : "NEW";
}

export function leadSourceOf(value: string): LeadSource {
  return isLeadSource(value) ? value : "OTHER";
}

export function stageOf(value: string): OpportunityStage {
  return isOpportunityStage(value) ? value : "DISCOVERY";
}

/** Phone normalization: strip separators, keep leading +, bound length (§13). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  return `${plus ? "+" : ""}${digits}`.slice(0, 20);
}

/**
 * Weighted pipeline value (§35) — EXACT integer math:
 * (expectedValueMinor × probabilityPct) / 100 with integer truncation on
 * the remainder. NEVER floating point (100.00 × 0.75 forbidden).
 */
export function weightedValue(expectedValueMinor: number, probabilityPct: number): number {
  if (!Number.isInteger(expectedValueMinor) || !Number.isInteger(probabilityPct)) {
    throw new Error("Weighted pipeline math requires integers");
  }
  if (probabilityPct < 0 || probabilityPct > 100) {
    throw new Error("Probability out of range");
  }
  return Math.trunc((expectedValueMinor * probabilityPct) / 100);
}
