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

/**
 * Prompt 36 (§14/§15/§16) — parse a full datetime instant (activity
 * occurredAt / task dueAt). These are REAL points in time — UTC instants —
 * NOT date-only values, so the Prompt 35 UTC-midnoon rule does NOT apply.
 * Accepts any parseable ISO-8601 string; returns null for garbage.
 */
export function parseInstant(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Prompt 36 (§119) — convert a business-timezone wall-clock reading
 * ("YYYY-MM-DDTHH:mm" from a datetime-local input) into the true UTC
 * instant, so users always schedule in the BUSINESS clock regardless of
 * their device timezone. Two-pass offset resolution handles DST boundaries;
 * invalid zones fall back to UTC; garbage input returns null.
 */
export function zonedWallClockToUtc(
  raw: string | null | undefined,
  timeZone: string,
): Date | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(raw.trim());
  if (!match) return null;
  const [, day, time] = match;
  const guess = new Date(`${day}T${time}:00Z`); // pretend the wall clock is UTC
  if (Number.isNaN(guess.getTime())) return null;
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    tz = "UTC";
  }
  const asUtc = (d: Date) =>
    new Date(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .format(d)
        .replace(/,\s*/, "T") + "Z",
    );
  // Two passes converge everywhere except the theoretical double-DST hour.
  let offset = guess.getTime() - asUtc(guess).getTime();
  offset = guess.getTime() + offset - asUtc(new Date(guess.getTime() + offset)).getTime();
  const instant = new Date(guess.getTime() + offset);
  return Number.isNaN(instant.getTime()) ? null : instant;
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
