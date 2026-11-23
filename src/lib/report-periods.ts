/**
 * Prompt 50 (§4) — reporting-period service. The ONE pure module that
 * converts business-local calendar semantics into UTC instants for every
 * report window (A04 timezone law, A08 integer money law unaffected).
 *
 * WHY THIS EXISTS (Risks A/B/D50-I, verified by tests this round):
 *  - lib/reports.ts derived local-day keys by stepping `now` back in UTC
 *    24h hops — correct in the common case, but the KPI predicate never
 *    checked the UPPER bound and the fetch window had no `lt`, so a
 *    future-dated record could enter KPI totals.
 *  - lib/reports-advanced.ts anchored windows at `Date(local+"T00:00:00Z")`
 *    and stepped fixed 86_400_000 ms — WRONG for every timezone that is not
 *    UTC (a +03:30 local day is [prev 20:30Z, 20:30Z), not [00:00Z, 24:00Z))
 *    and wrong across DST transitions (comparison windows could contain a
 *    different number of local calendar dates).
 *
 * LAWS (docs/product/business-reports.md §2):
 *  L1  A business-local date key is exactly "YYYY-MM-DD" (strict, real
 *      calendar date). User-facing from/to are INCLUSIVE local dates.
 *  L2  Database boundaries are EXCLUSIVE UTC instants: fetchFrom =
 *      start of `fromKey`'s local day; fetchUntil = start of the local day
 *      AFTER `toKey`. A local day is NOT assumed to be 24h (DST-safe:
 *      exact instants come from Intl offset arithmetic, never fixed ms).
 *  L3  The browser/client timezone is never an input. The timezone comes
 *      from the authenticated business context (server-side).
 *  L4  Rolling windows end on the CURRENT business-local date; future
 *      local dates are excluded from completed windows everywhere.
 *  L5  Comparison windows contain exactly N local calendar dates each,
 *      no overlap, no gap (pure local-calendar enumeration, never ms math).
 *  L6  New custom-range advanced reports accept at most
 *      MAX_REPORT_RANGE_DAYS local calendar days (366), from <= to.
 *  L7  All money stays integer minor units; additions/multiplications
 *      guard the safe-integer range and throw a controlled integrity
 *      error instead of silently overflowing.
 *  L8  Percentage change: null when the baseline is 0 (never divide by
 *      zero, never invent 100% for 0→positive) — the established UI law.
 */

/** §4 — maximum custom local-date span for newly introduced advanced reports. */
export const MAX_REPORT_RANGE_DAYS = 366;

/**
 * Bounded-read cap from the environment (P49 convention, shared): numeric
 * env overrides are clamped to [min, max] — harnesses exercise the
 * truncation/rejection laws with small caps; production defaults stand.
 */
export function envCap(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Closed rolling presets preserved from the existing summary endpoint. */
export const ALLOWED_REPORT_DAYS = [7, 30, 90] as const;
export type ReportDays = (typeof ALLOWED_REPORT_DAYS)[number];

/** Closed month presets preserved from the existing monthly endpoint. */
export const ALLOWED_REPORT_MONTHS = [3, 6, 12] as const;
export type ReportMonths = (typeof ALLOWED_REPORT_MONTHS)[number];

// ---------------------------------------------------------------------------
// Controlled errors (422 validation / 500 integrity — stable API contracts)
// ---------------------------------------------------------------------------

/** Invalid user-supplied period input — routes translate this to a 422
 *  ApiError (same pattern as AgingDetailValidationError, §7). Kept free of
 *  Next.js imports so the module stays pure/testable (P50 unit harness). */
export class ReportRangeError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
    this.name = "ReportRangeError";
  }
}

/** Corrupt financial source data (non-integer/overflow money) → 500. */
export class ReportIntegrityError extends Error {
  constructor(message: string) {
    super(`Report integrity violation: ${message}`);
    this.name = "ReportIntegrityError";
  }
}

// ---------------------------------------------------------------------------
// Safe integer arithmetic (L7)
// ---------------------------------------------------------------------------

export function safeAdd(a: number, b: number, what = "amount"): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new ReportIntegrityError(`non-integer ${what} encountered`);
  }
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new ReportIntegrityError(`${what} overflowed the safe integer range`);
  }
  return sum;
}

export function safeSub(a: number, b: number, what = "amount"): number {
  return safeAdd(a, -b, what);
}

/** qty × unit-value guard (inventory estimate / product totals). */
export function safeMul(qty: number, unitValueMinor: number, what = "value"): number {
  if (!Number.isSafeInteger(qty) || !Number.isSafeInteger(unitValueMinor)) {
    throw new ReportIntegrityError(`non-integer factor in ${what}`);
  }
  const product = qty * unitValueMinor;
  if (!Number.isSafeInteger(product)) {
    throw new ReportIntegrityError(`${what} overflowed the safe integer range`);
  }
  return product;
}

/** §6/§8 — documented change rule; null baseline stays null (L8). */
export function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// ---------------------------------------------------------------------------
// Local date keys — strict parsing (L1)
// ---------------------------------------------------------------------------

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

function isRealCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  return d <= daysInMonth;
}

/** Strict YYYY-MM-DD, real calendar date, 2000..2100 — null otherwise. */
export function parseLocalDateKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = DATE_KEY_RE.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || !isRealCalendarDate(y, mo, d)) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Strict YYYY-MM, 2000-01..2100-12 — null otherwise (same law as reports.ts). */
export function parseMonthKeyInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = MONTH_KEY_RE.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12) return null;
  return `${m[1]}-${m[2]}`;
}

function validKey(key: string): { y: number; m: number; d: number } {
  const m = DATE_KEY_RE.exec(key);
  if (!m) throw new ReportRangeError("date", `invalid local date key: ${key}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Business-local YYYY-MM-DD for an instant (en-CA gives ISO-like output). */
export function localDateKeyOf(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Business-local YYYY-MM for an instant (same convention as reports.ts). */
export function localMonthKeyOf(d: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(d);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    return year && month ? `${year}-${month}` : d.toISOString().slice(0, 7);
  } catch {
    return d.toISOString().slice(0, 7);
  }
}

export function todayKey(now: Date, timeZone: string): string {
  return localDateKeyOf(now, timeZone);
}

// ---------------------------------------------------------------------------
// Pure local-calendar arithmetic (L5 — never fixed-millisecond steps)
// ---------------------------------------------------------------------------

/** Calendar-date addition on the key itself — DST-proof by construction. */
export function addLocalDays(key: string, n: number): string {
  const { y, m, d } = validKey(key);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n); // pure UTC calendar day step on the DATE
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Month-key addition on YYYY-MM — anchors on the 1st, DST-proof. */
export function addMonthKey(month: string, n: number): string {
  const m = MONTH_KEY_RE.exec(month);
  if (!m) throw new ReportRangeError("month", `invalid month key: ${month}`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Inclusive count of local calendar dates between fromKey and toKey. */
export function daysBetweenInclusive(fromKey: string, toKey: string): number {
  const a = validKey(fromKey);
  const b = validKey(toKey);
  const utcA = Date.UTC(a.y, a.m - 1, a.d);
  const utcB = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((utcB - utcA) / 86_400_000) + 1;
}

/**
 * R176 — the ADJACENCY MOVE, shared by both paging affordances (the
 * picker popover's draft nudge AND the applied-window pager on the
 * presets row): shift a window by its OWN inclusive span — no overlap,
 * no gaps. prev = [from − N, from − 1], next = [to + 1, to + N] where
 * N = daysBetweenInclusive(from, to), so the shifted window has exactly
 * the same length and touches the original only at its boundary.
 *
 * Pure calendar math (UTC steps on DATE keys, L5); the caller owns the
 * server-law clamping (a next window reaching past the business-local
 * today is clamped to today BEFORE it is sent — what the UI sends is
 * what the server would resolve, L3/L4).
 */
export function adjacentWindow(
  fromKey: string,
  toKey: string,
  direction: "prev" | "next",
): { from: string; to: string } {
  const span = daysBetweenInclusive(fromKey, toKey);
  if (direction === "prev") {
    return { from: addLocalDays(fromKey, -span), to: addLocalDays(fromKey, -1) };
  }
  return { from: addLocalDays(toKey, 1), to: addLocalDays(toKey, span) };
}

/** Enumerate every local date from fromKey to toKey inclusive (ordered). */
export function enumerateLocalDays(fromKey: string, toKey: string): string[] {
  const count = daysBetweenInclusive(fromKey, toKey);
  if (count <= 0) return [];
  const keys: string[] = new Array(count);
  for (let i = 0; i < count; i++) keys[i] = addLocalDays(fromKey, i);
  return keys;
}

// ---------------------------------------------------------------------------
// Local day ⇄ exact UTC instants (L2 — Intl offset math, never fixed ms)
// ---------------------------------------------------------------------------

function tzOffsetMinutes(instant: Date, timeZone: string): number {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
  } catch {
    // A bogus zone must fail LOUD (controlled integrity error) — never
    // silently mis-bucket whole days under a UTC fallback.
    throw new ReportIntegrityError(`unknown timezone "${timeZone}" for report windows`);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * The EXACT first UTC instant whose business-local date is `key`.
 * Handles DST spring-forward (a local midnight that does not exist → the
 * day starts at 01:00) and fall-back (local midnight occurring twice → the
 * day starts at the FIRST midnight) by converging on the offset and
 * verifying that one millisecond earlier maps to the previous local date.
 */
export function zonedDayStartUtc(key: string, timeZone: string): Date {
  const { y, m, d } = validKey(key);
  // Anchor at NOON of the local day: transitions essentially never fire at
  // 12:00, so this offset is the day's regular offset.
  const noonGuess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  let offset = tzOffsetMinutes(noonGuess, timeZone);
  let candidate = new Date(Date.UTC(y, m - 1, d) - offset * 60_000);
  // Fixpoint: re-read the offset AT the candidate (midnight transitions),
  // then verify the candidate is the FIRST instant of the local day.
  for (let i = 0; i < 3; i++) {
    const at = tzOffsetMinutes(candidate, timeZone);
    if (at !== offset) {
      offset = at;
      candidate = new Date(Date.UTC(y, m - 1, d) - offset * 60_000);
      continue;
    }
    // Fall-back corner: if one ms earlier is STILL the same local date, the
    // candidate landed on the second (post-transition) midnight — step back.
    if (localDateKeyOf(new Date(candidate.getTime() - 1), timeZone) === key) {
      const delta = tzOffsetMinutes(new Date(candidate.getTime() - 1), timeZone);
      candidate = new Date(candidate.getTime() - (delta - offset) * 60_000);
      continue;
    }
    break;
  }
  if (localDateKeyOf(candidate, timeZone) !== key) {
    // Never silently mis-bucket a whole day.
    throw new ReportIntegrityError(`cannot resolve local midnight for ${key} (${timeZone})`);
  }
  return candidate;
}

/** The EXCLUSIVE end of `key`'s local day = start of the next local day. */
export function zonedDayEndExclusiveUtc(key: string, timeZone: string): Date {
  return zonedDayStartUtc(addLocalDays(key, 1), timeZone);
}

// ---------------------------------------------------------------------------
// Window resolvers
// ---------------------------------------------------------------------------

export type ReportWindow = {
  /** Inclusive business-local from key. */
  fromKey: string;
  /** Inclusive business-local to key (== today for rolling windows). */
  toKey: string;
  /** Every local date in the window, oldest → newest. */
  dayKeys: string[];
  /** Inclusive database lower bound (exact start of fromKey's local day). */
  fetchFrom: Date;
  /** EXCLUSIVE database upper bound (start of the day after toKey). */
  fetchUntil: Date;
  timeZone: string;
};

export function normalizeReportDaysInput(input: unknown): ReportDays {
  const n = Number(input ?? 30);
  return (ALLOWED_REPORT_DAYS as readonly number[]).includes(n) ? (n as ReportDays) : 30;
}

export function normalizeReportMonthsInput(input: unknown): ReportMonths {
  const n = Number(input ?? 6);
  return (ALLOWED_REPORT_MONTHS as readonly number[]).includes(n) ? (n as ReportMonths) : 6;
}

/**
 * Rolling summary window: the last `days` business-local calendar dates
 * ENDING TODAY (L4). Both database bounds are exact local-day instants —
 * future-dated records can never enter the fetch.
 */
export function resolveRollingWindow(
  timeZone: string,
  days: ReportDays,
  now: Date,
): ReportWindow {
  const toKey = todayKey(now, timeZone);
  const fromKey = addLocalDays(toKey, -(days - 1));
  return buildWindow(timeZone, fromKey, toKey);
}

/**
 * Previous comparison window: the `days` business-local dates IMMEDIATELY
 * BEFORE `current.fromKey` (§6 — same length, no overlap, no gap).
 */
export function resolvePreviousWindow(
  timeZone: string,
  days: number,
  currentFromKey: string,
): { fromKey: string; toKey: string; fetchFrom: Date; fetchUntil: Date } {
  const toKey = addLocalDays(currentFromKey, -1);
  const fromKey = addLocalDays(currentFromKey, -days);
  return {
    fromKey,
    toKey,
    fetchFrom: zonedDayStartUtc(fromKey, timeZone),
    fetchUntil: zonedDayStartUtc(addLocalDays(toKey, 1), timeZone),
  };
}

/** Shared window builder with the L6 span cap for custom ranges. */
export function buildWindow(
  timeZone: string,
  fromKey: string,
  toKey: string,
  options?: { maxDays?: number; rangeKind?: "rolling" | "custom" },
): ReportWindow {
  const maxDays = options?.maxDays;
  if (daysBetweenInclusive(fromKey, toKey) <= 0) {
    throw new ReportRangeError("from", "The from date must be on or before the to date.");
  }
  if (maxDays !== undefined && daysBetweenInclusive(fromKey, toKey) > maxDays) {
    throw new ReportRangeError(
      "from",
      `The selected range exceeds the maximum of ${maxDays} days.`,
    );
  }
  return {
    fromKey,
    toKey,
    dayKeys: enumerateLocalDays(fromKey, toKey),
    fetchFrom: zonedDayStartUtc(fromKey, timeZone),
    fetchUntil: zonedDayStartUtc(addLocalDays(toKey, 1), timeZone),
    timeZone,
  };
}

/**
 * Custom advanced report range (§4/§11.1): strict local dates, from <= to,
 * at most MAX_REPORT_RANGE_DAYS local calendar days. The caller passes the
 * business timezone — a client timezone is never accepted (L3).
 */
export function resolveCustomRange(
  timeZone: string,
  fromInput: unknown,
  toInput: unknown,
  now: Date,
  maxDays: number = MAX_REPORT_RANGE_DAYS,
): ReportWindow {
  const fromKey = parseLocalDateKey(fromInput);
  if (!fromKey) {
    throw new ReportRangeError("from", "from must be a valid YYYY-MM-DD date.");
  }
  const toKey = parseLocalDateKey(toInput);
  if (!toKey) {
    throw new ReportRangeError("to", "to must be a valid YYYY-MM-DD date.");
  }
  const window = buildWindow(timeZone, fromKey, toKey, { maxDays, rangeKind: "custom" });
  // L4 — the current business-local date is the horizon; a range lying
  // entirely in the future is rejected instead of serving guaranteed-empty
  // totals (documented contract: reports describe recorded history).
  const today = todayKey(now, timeZone);
  if (fromKey > today) {
    throw new ReportRangeError("from", "The from date is in the future.");
  }
  // Clamp the effective end to today: future portion of a partly-future
  // range simply contributes no rows (its buckets stay zero, honestly).
  return toKey > today ? buildWindow(timeZone, fromKey, today, { maxDays }) : window;
}

/**
 * Month bucket window (§7/§10): widened bounds are NO LONGER needed —
 * exact local-day instants make the database filter authoritative. The
 * effective end of the CURRENT month is the end of TODAY (L4: future rows
 * never enter report windows; past months keep their natural end).
 */
export function resolveMonthWindow(
  timeZone: string,
  monthKey: string,
  now: Date,
): { month: string; fetchFrom: Date; fetchUntil: Date } | null {
  const month = parseMonthKeyInput(monthKey);
  if (!month) return null;
  const [y, m] = month.split("-").map(Number);
  const firstKey = `${month}-01`;
  const lastKeyDate = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day
  const lastKey = `${y}-${String(m).padStart(2, "0")}-${String(lastKeyDate.getUTCDate()).padStart(2, "0")}`;
  const fetchFrom = zonedDayStartUtc(firstKey, timeZone);
  const naturalEnd = zonedDayStartUtc(addLocalDays(lastKey, 1), timeZone);
  const today = todayKey(now, timeZone);
  const fetchUntil =
    today >= firstKey && today <= lastKey
      ? zonedDayEndExclusiveUtc(today, timeZone)
      : naturalEnd;
  return { month, fetchFrom, fetchUntil };
}
