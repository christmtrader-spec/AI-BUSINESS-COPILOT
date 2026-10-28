/**
 * R135 — THE USAGE-SERIES AUTHORITY (pure core, zero DB).
 *
 * The daily shape behind the ⌘K quick dialog's "Last 14 days" sparkline.
 * ONE population law shared with the meter itself:
 * - the ROUTE counts UsageEvent rows (businessId, metric = AI_REQUESTS,
 *   status = COMMITTED) — RELEASED rows were reconciled back by the meter
 *   (§20/§49) and NEVER count; this module only shapes what the route
 *   already summed per UTC day;
 * - UTC day bucketing happens server-side (the ledger's own clock) — the
 *   client renders the day keys in the UI locale and never re-buckets;
 * - ZERO-FILL: every day of the window exists. An absent day is an honest
 *   zero, never a gap — the sparkline's silhouette is the truth;
 * - days is clamped to [1, 30] — a bounded response no matter what the
 *   query string says (zero-trust on inputs, §69);
 * - rows dated outside the window or malformed are dropped WHOLESALE
 *   (never shift the window, never invent a day);
 * - ordering is oldest → newest (sparkline draws left = past).
 *
 * PURE by construction: dates enter as `Date`/ISO strings, no clock reads,
 * no IO — the battery (scripts/r135-usage-series.ts) pins every law.
 */

export type UsageSeriesDay = {
  /** UTC day key, YYYY-MM-DD. */
  date: string;
  /** COMMITTED AI_REQUESTS quantity summed for that UTC day. */
  requests: number;
};

export type UsageSeries = {
  /** Inclusive window the series covers (UTC day keys). */
  from: string;
  to: string;
  /** The clamped, authoritative day count (mirrors `series.length`). */
  days: number;
  /** Zero-filled day rows, oldest → newest. */
  series: UsageSeriesDay[];
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Hard response bound — the sparkline never asks for more. */
export const USAGE_SERIES_MAX_DAYS = 30;
export const USAGE_SERIES_DEFAULT_DAYS = 14;

/**
 * Zero-trust `?days=` parsing: an EXACT integer inside [1, 30] wins;
 * anything else (null, NaN, float like "12.5", empty, out of range) falls
 * back to the default — the route NEVER echoes a hostile value back into
 * the query. `Number` (not `parseInt`) so a float can never truncate its
 * way into a valid day count.
 */
export function clampSeriesDays(raw: string | number | null | undefined, fallback = USAGE_SERIES_DEFAULT_DAYS): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(n) || n < 1 || n > USAGE_SERIES_MAX_DAYS) return fallback;
  return n;
}

/** The ledger's own day key — UTC, never the server's local timezone. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add `n` days to a UTC day key (calendar math in UTC, DST-free). */
function addUtcDays(key: string, n: number): string {
  const dt = new Date(`${key}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcDayKey(dt);
}

/**
 * The inclusive day-key window, oldest → newest, ENDING at today (UTC).
 * `todayUtc` is injected so the function stays pure and the battery can
 * pin exact windows across month/year boundaries.
 */
export function seriesWindowKeys(todayUtc: Date, days: number): string[] {
  const to = utcDayKey(todayUtc);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) keys.push(addUtcDays(to, -i));
  return keys;
}

/**
 * Merge the route's per-day sums into the zero-filled window.
 * - `counts` items with malformed day keys are dropped (never fabricated
 *   into a day);
 * - items dated AFTER the window's end (clock skew, late writes) are
 *   dropped — the series never claims usage from the future;
 * - items BEFORE the window's start are dropped (the caller asked for a
 *   bounded window; older history stays out of the silhouette);
 * - every window day is present exactly once, oldest → newest.
 */
export function buildUsageSeries(
  counts: ReadonlyArray<{ day: string; requests: number }>,
  todayUtc: Date,
  days: number,
): UsageSeries {
  const window = seriesWindowKeys(todayUtc, days);
  const byDay = new Map<string, number>();
  for (const row of counts) {
    if (!row || typeof row.day !== "string" || !ISO_DAY.test(row.day)) continue;
    if (typeof row.requests !== "number" || !Number.isFinite(row.requests) || row.requests < 0) continue;
    if (row.day > window[window.length - 1] || row.day < window[0]) continue;
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + Math.floor(row.requests));
  }
  const series = window.map((date) => ({ date, requests: byDay.get(date) ?? 0 }));
  return { from: window[0], to: window[window.length - 1], days: window.length, series };
}
