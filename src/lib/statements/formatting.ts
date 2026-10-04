/**
 * Prompt 39 — statement formatting + date-preset utilities (pure).
 *
 * - Localized description templates and event labels come from the shared
 *   i18n catalogs (single source, EN + FA parity enforced by i18n-audit).
 * - Date presets (§75) are computed in the BUSINESS calendar; the existing
 *   Reports module has no date-preset utility to reuse (it uses fixed
 *   7/30/90-day selectors), so this is the single documented implementation.
 * - CSV money uses the EXACT decimal-string convention of the existing
 *   exports (data-portability money-csv — pure integer string math, §80).
 */
import { localDayKey } from "@/lib/aging";
import { formatMinorToDecimal } from "@/lib/data-portability/money-csv";
import { messagesFor } from "@/i18n/messages";

/** Narrow CSV input — any statement row (engine row or DTO row) satisfies it. */
export type StatementCsvRowInput = {
  occurredAt: Date;
  reference: string | null;
  description: string | null;
  increaseMinor: number;
  decreaseMinor: number;
  balanceAfterMinor: number;
};

/** Minimal {key} template interpolation for localized server-side strings. */
export function formatTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/** Closed date-range preset vocabulary (§75). */
export const STATEMENT_PRESETS = [
  "thisMonth",
  "lastMonth",
  "last30Days",
  "last90Days",
  "thisYear",
] as const;
export type StatementPreset = (typeof STATEMENT_PRESETS)[number];

export function isStatementPreset(value: string): value is StatementPreset {
  return (STATEMENT_PRESETS as readonly string[]).includes(value);
}

function dayKeyToUtcIndex(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function utcIndexToDayKey(index: number): string {
  return new Date(index * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolve a named preset to a { from, to } business-calendar range (§75).
 * "Last N days" is inclusive of today. All math is calendar-day integer
 * arithmetic in the BUSINESS timezone — never the server clock's zone.
 */
export function presetRange(
  preset: StatementPreset,
  timeZone: string,
  now: Date = new Date(),
): { from: string; to: string } {
  const todayKey = localDayKey(now, timeZone);
  const todayIndex = dayKeyToUtcIndex(todayKey);
  switch (preset) {
    case "thisMonth":
      return { from: `${todayKey.slice(0, 7)}-01`, to: lastDayOf(todayKey.slice(0, 7)) };
    case "lastMonth": {
      const [y, m] = todayKey.split("-").map(Number);
      const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
      return { from: `${prev}-01`, to: lastDayOf(prev) };
    }
    case "last30Days":
      return { from: utcIndexToDayKey(todayIndex - 29), to: todayKey };
    case "last90Days":
      return { from: utcIndexToDayKey(todayIndex - 89), to: todayKey };
    case "thisYear":
      return { from: `${todayKey.slice(0, 4)}-01-01`, to: `${todayKey.slice(0, 4)}-12-31` };
  }
}

function lastDayOf(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

/**
 * CSV cell mapping for one statement row (§79/§80/§121):
 *   date        — the event's business-calendar day (YYYY-MM-DD, machine-usable)
 *   reference   — business-facing reference (invoice number / bill reference)
 *   description — localized description (never a private note, §29)
 *   increase/decrease/balance — EXACT decimal strings at the business
 *                 precision (integer minor units underneath, §80/§269).
 */
export function statementCsvRowCells(
  row: StatementCsvRowInput,
  precision: number,
  timeZone: string,
): { date: string; reference: string; description: string; increase: string; decrease: string; balance: string } {
  return {
    date: localDayKey(row.occurredAt, timeZone),
    reference: row.reference ?? "",
    description: row.description ?? "",
    increase: formatMinorToDecimal(row.increaseMinor, precision),
    decrease: formatMinorToDecimal(row.decreaseMinor, precision),
    balance: formatMinorToDecimal(row.balanceAfterMinor, precision),
  };
}
