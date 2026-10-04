/**
 * Prompt 39 — statement query schema (§35/§94/§95/§129/§139).
 *
 * Supported query parameters — NOTHING else is accepted (§129):
 *   from    optional "YYYY-MM-DD" strict business-calendar date
 *   to      optional "YYYY-MM-DD" strict business-calendar date
 *   cursor  optional opaque signed cursor (see cursor.ts)
 *   limit   optional page size, default 50, clamped-validated 10..100
 *   locale  optional response language token, "en" | "fa" (default "en")
 *
 * DATE LAW (§17/§18/§94):
 *   - Calendar dates are validated STRICTLY (regex + real calendar day,
 *     leap-year aware). JS Date rollover (2026-02-31 → Mar 3) is rejected,
 *     reusing the Prompt 38 lesson encoded in lib/schemas.ts.
 *   - from > to → 422 before any query executes (§95).
 *   - The calendar dates are converted to UTC instants with the BUSINESS
 *     timezone (never the server's, never the browser's, §17/§93). The
 *     window end is the START of the next local day (exclusive), so a
 *     23:30 or 23:59:59 local event on `to` is always included (§18/§91).
 *   - Default range (§19): the CURRENT business calendar month — there is
 *     no pre-existing Reports date-range default to reuse (Reports uses
 *     days/months selectors), so this is the documented deterministic rule.
 */
import { zonedWallClockToUtc } from "@/lib/crm/normalization";
import { localDayKey } from "@/lib/aging";
import {
  STATEMENT_DEFAULT_LIMIT,
  STATEMENT_MAX_LIMIT,
  STATEMENT_MIN_LIMIT,
} from "./types";

export class StatementValidationError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
    this.name = "StatementValidationError";
  }
}

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Strict calendar-date validation — rejects 2026-02-31 and any rollover (§94). */
export function isValidCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

export type StatementQueryInput = {
  from: string | null;
  to: string | null;
  cursor: string | null;
  limit: number;
  locale: "en" | "fa";
};

function optionalCalendarDate(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null || raw === "") return null;
  const value = raw.trim();
  if (!isValidCalendarDate(value)) {
    throw new StatementValidationError(key, "Use a valid YYYY-MM-DD calendar date.");
  }
  return value;
}

/** Parse + validate the statement query string. Throws StatementValidationError (→ 422). */
export function parseStatementQuery(params: URLSearchParams): StatementQueryInput {
  const from = optionalCalendarDate(params, "from");
  const to = optionalCalendarDate(params, "to");
  // §95 — invalid range rejected BEFORE any query runs.
  if (from && to && from > to) {
    throw new StatementValidationError("to", "from must be on or before to.");
  }

  let limit = STATEMENT_DEFAULT_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit.trim())) {
      throw new StatementValidationError("limit", "limit must be a positive integer.");
    }
    limit = Number(rawLimit.trim());
    if (limit < STATEMENT_MIN_LIMIT || limit > STATEMENT_MAX_LIMIT) {
      throw new StatementValidationError(
        "limit",
        `limit must be between ${STATEMENT_MIN_LIMIT} and ${STATEMENT_MAX_LIMIT}.`,
      );
    }
  }

  const rawCursor = params.get("cursor");
  const cursor = rawCursor && rawCursor.trim() !== "" ? rawCursor.trim() : null;
  if (cursor && cursor.length > 1024) {
    throw new StatementValidationError("cursor", "cursor is invalid.");
  }

  const rawLocale = params.get("locale");
  const locale: "en" | "fa" = rawLocale === "fa" ? "fa" : "en";

  return { from, to, cursor, limit, locale };
}

/** "2026-10-31" → "2026-11-01" — pure calendar arithmetic on the date key. */
export function nextCalendarDay(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + 86_400_000).toISOString().slice(0, 10);
}

/** Last calendar day ("YYYY-MM-DD") of a "YYYY-MM" month key. */
export function lastDayOfMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

/**
 * Resolve the effective from/to CALENDAR RANGE (§19). Deterministic rules:
 *   both missing → the current business calendar month;
 *   only from    → through the last day of that month;
 *   only to      → from the first day of that month.
 */
export function resolveStatementRange(
  from: string | null,
  to: string | null,
  timeZone: string,
  now: Date = new Date(),
): { from: string; to: string } {
  if (from && to) return { from, to };
  const todayKey = localDayKey(now, timeZone);
  if (from) return { from, to: lastDayOfMonthKey(from.slice(0, 7)) };
  if (to) return { from: `${to.slice(0, 7)}-01`, to };
  const month = todayKey.slice(0, 7);
  return { from: `${month}-01`, to: lastDayOfMonthKey(month) };
}

/** UTC instants of the business-calendar window: [from 00:00, next-day 00:00). */
export type StatementWindow = { from: Date; until: Date };

/**
 * Convert a resolved calendar range into UTC instants using the BUSINESS
 * timezone (§17/§18/§93). `until` is EXCLUSIVE (start of the next local
 * day), so the whole `to` local day — including 23:59:59 — is included.
 */
export function resolveStatementWindow(from: string, to: string, timeZone: string): StatementWindow {
  const fromInstant = zonedWallClockToUtc(`${from}T00:00`, timeZone);
  const untilInstant = zonedWallClockToUtc(`${nextCalendarDay(to)}T00:00`, timeZone);
  if (!fromInstant || !untilInstant) {
    throw new StatementValidationError("from", "Could not resolve the date range in the business timezone.");
  }
  if (untilInstant.getTime() <= fromInstant.getTime()) {
    throw new StatementValidationError("to", "The resolved date range is empty.");
  }
  return { from: fromInstant, until: untilInstant };
}
