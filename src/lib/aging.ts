/**
 * Payables/receivables AGING engine — completes the ratified MVP surface
 * (PROJECT-CONSTITUTION §2 row 15: "receivables aging").
 *
 * DETERMINISTIC-CALC ONLY (A11): every figure is derived here from recorded
 * transactions with integer math (A08) — nothing is estimated, nothing is
 * accepted from the client.
 *
 * SEMANTICS (honest, documented):
 * - The aging anchor is a DATE. Receivables: the invoice `issueDate` (sales
 *   carry no payment terms in the MVP). Payables: the supplier-bill
 *   `dueDate` when stated, otherwise `spentAt` (date the bill was recorded).
 * - Age = whole calendar days between the anchor day and "today" computed in
 *   the BUSINESS timezone (A07) — never in the server's or viewer's zone.
 * - Fixed buckets: 0–30 / 31–60 / 61–90 / 90+ days outstanding.
 * - Payables extra: a bill is PAST DUE when it has a dueDate and today's
 *   business day is strictly AFTER the due day ("due Oct 5" becomes overdue
 *   on Oct 6). Bills without a due date are never past due (honest: no terms
 *   were stated).
 */

export const AGING_BUCKET_KEYS = ["D0_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgingBucketKey = (typeof AGING_BUCKET_KEYS)[number];

export type AgingBucket = { key: AgingBucketKey; minor: number; count: number };

export type AgingParty = {
  /** Customer/supplier name; null = no party recorded ("—"). */
  name: string | null;
  /**
   * Prompt 49 (§6) — the AUTHORITATIVE party id (customerId/supplierId)
   * inside the requesting tenant; null = items with no linked party.
   * Grouping is keyed by THIS id, never by the display name: two parties
   * with identical names stay two distinct groups. Additive field —
   * existing aggregate-API consumers keep their previous shape.
   */
  partyId: string | null;
  balanceMinor: number;
  openCount: number;
  /** Age in days of this party's OLDEST open item (0 when not yet due). */
  oldestDays: number;
};

export type AgingSide = {
  totalMinor: number;
  openCount: number;
  /** Always exactly 4 buckets, in AGING_BUCKET_KEYS order. */
  buckets: AgingBucket[];
  /** Top parties by outstanding balance (≤ 8), balance desc → name asc. */
  topParties: AgingParty[];
  /** Payables only: bills with a stated due date strictly before today. */
  pastDueMinor?: number;
  pastDueCount?: number;
};

export type AgingItem = {
  anchor: Date;
  balanceMinor: number;
  party: string | null;
  /**
   * Prompt 49 (§6) — authoritative tenant-scoped party id of the source
   * record (Sale.customerId / Expense.supplierId); null when unlinked.
   * REQUIRED for per-party drill-down — display names are not identity.
   */
  partyId?: string | null;
  /** Payables only — enables the past-due slice. */
  dueDate?: Date | null;
};

export type AgingSideOptions = {
  timeZone: string;
  now?: Date;
  /** Compute the past-due slice (payables). */
  withPastDue?: boolean;
};

/** Hard honesty cap — mirrors the ≤200 list views; aging aggregates over at
 * most this many open items per side and reports truncation upstream. */
export const AGING_SCAN_CAP = 1000;
export const AGING_TOP_PARTIES = 8;

/** Days-since-epoch index of the CALENDAR DAY of `d` in `timeZone` (A07). */
export function localDayIndex(d: Date, timeZone: string): number {
  const parts = safeDayParts(d, timeZone);
  if (!parts) return Math.floor(d.getTime() / 86_400_000);
  return Math.floor(Date.UTC(parts.y, parts.m - 1, parts.d) / 86_400_000);
}

/** "YYYY-MM-DD" of `d`'s calendar day in `timeZone` (same day math). */
export function localDayKey(d: Date, timeZone: string): string {
  const parts = safeDayParts(d, timeZone);
  if (!parts) return d.toISOString().slice(0, 10);
  const mm = String(parts.m).padStart(2, "0");
  const dd = String(parts.d).padStart(2, "0");
  return `${parts.y}-${mm}-${dd}`;
}

/**
 * R81/R83 — the ONE write-side ordering gate for stated payment terms.
 * True only when the due DAY is strictly BEFORE the issue DAY in the
 * business timezone (A07 day math — §84 midnoon instants make the calendar
 * day identical everywhere, so comparing day indexes is the honest gate).
 * Same day (due == issue) is NEVER "before" — net-N terms issued today are
 * legitimately due today.
 */
export function dueBeforeIssue(due: Date, issue: Date, timeZone: string): boolean {
  return localDayIndex(due, timeZone) < localDayIndex(issue, timeZone);
}

function safeDayParts(
  d: Date,
  timeZone: string,
): { y: number; m: number; d: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(d);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const day = Number(parts.find((p) => p.type === "day")?.value);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return null;
    return { y, m, d: day };
  } catch {
    return null; // invalid zone → UTC fallback (same convention as CRM §119)
  }
}

/** Fixed-range bucket for an age in whole days (negative ages clamp to 0–30). */
export function agingBucketForAge(ageDays: number): AgingBucketKey {
  const age = Math.max(0, Math.floor(ageDays));
  if (age <= 30) return "D0_30";
  if (age <= 60) return "D31_60";
  if (age <= 90) return "D61_90";
  return "D90_PLUS";
}

/**
 * Build one aging side (receivables OR payables) from open items.
 * Integer math only; parties aggregated by AUTHORITATIVE PARTY ID
 * (Prompt 49 §6 — never by display name alone); deterministic ordering.
 */
export function buildAgingSide(
  items: AgingItem[],
  opts: AgingSideOptions,
): AgingSide {
  const now = opts.now ?? new Date();
  const todayIdx = localDayIndex(now, opts.timeZone);

  const byKey = new Map<AgingBucketKey, { minor: number; count: number }>(
    AGING_BUCKET_KEYS.map((k) => [k, { minor: 0, count: 0 }]),
  );

  let totalMinor = 0;
  let pastDueMinor = 0;
  let pastDueCount = 0;

  const partyAgg = new Map<
    string,
    { partyId: string | null; name: string | null; balanceMinor: number; openCount: number; oldestDays: number }
  >();

  for (const item of items) {
    const balance = Math.trunc(item.balanceMinor);
    if (!Number.isFinite(balance) || balance <= 0) continue; // closed/noise guard
    const ageDays = todayIdx - localDayIndex(item.anchor, opts.timeZone);
    const key = agingBucketForAge(ageDays);
    const b = byKey.get(key)!;
    b.minor += balance;
    b.count += 1;
    totalMinor += balance;

    // Prompt 49 (§6) — the group key is the party ID (tenant-scoped), not
    // the name. Two same-name parties therefore NEVER merge, and every
    // record without a linked party lands in one explicit unassigned group.
    const partyKey = item.partyId ?? "\u0000";
    const agg = partyAgg.get(partyKey);
    if (agg) {
      agg.balanceMinor += balance;
      agg.openCount += 1;
      agg.oldestDays = Math.max(agg.oldestDays, ageDays);
    } else {
      partyAgg.set(partyKey, {
        partyId: item.partyId ?? null,
        name: item.party,
        balanceMinor: balance,
        openCount: 1,
        oldestDays: ageDays,
      });
    }

    if (opts.withPastDue && item.dueDate) {
      if (todayIdx > localDayIndex(item.dueDate, opts.timeZone)) {
        pastDueMinor += balance;
        pastDueCount += 1;
      }
    }
  }

  const topParties = [...partyAgg.values()]
    .sort(
      (a, b2) =>
        b2.balanceMinor - a.balanceMinor ||
        compareNames(a.name, b2.name) ||
        compareIds(a.partyId, b2.partyId) ||
        b2.oldestDays - a.oldestDays,
    )
    .slice(0, AGING_TOP_PARTIES)
    .map((p) => ({ ...p }));

  const side: AgingSide = {
    totalMinor,
    openCount: [...byKey.values()].reduce((n, b) => n + b.count, 0),
    buckets: AGING_BUCKET_KEYS.map((key) => ({ key, ...byKey.get(key)! })),
    topParties,
  };
  if (opts.withPastDue) {
    side.pastDueMinor = pastDueMinor;
    side.pastDueCount = pastDueCount;
  }
  return side;
}

function compareNames(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // no-party sorts after named parties
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prompt 49 (§6) — deterministic tie-break when two same-name parties tie:
 * the authoritative ids order the groups (never merges them). */
function compareIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
