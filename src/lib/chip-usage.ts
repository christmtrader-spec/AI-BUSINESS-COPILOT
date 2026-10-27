/**
 * Copilot suggestion click-through analytics — R121 (R118 candidate ②,
 * reopened in R120). PURE core + thin localStorage wrappers.
 *
 * THE LAW — BADGE-ONLY: the counter records which suggestion chips users
 * actually press (both pools + cross-surface intent asks, keyed by the i18n
 * suggestion key) and may ONLY decorate a chip with a "most asked" badge.
 * It NEVER reorders, hides, or adds chips — the pools stay the deterministic
 * relevance-ordered law of suggestions.ts (battery-pinned in r118/r119).
 *
 * R122 — the SAME pure core now also drives the dashboard quick-action
 * toolbar: the three action keys below are the only keys that counter can
 * ever see, and the badge reads "most used" instead of "most asked". The
 * two counters live in SEPARATE storage namespaces (a copilot press must
 * never elect a quick action and vice versa), and the reset affordance in
 * Settings → Data clears BOTH for the active business in this browser.
 *
 * R123 — WEEKLY WINDOW + HONEST NUMBERS: the badge law now reads a per-week
 * bucket (ISO-8601 weeks, Monday start) instead of the all-time counts, so
 * "most asked/used" always means "this week" — a chip that led last month
 * no longer wears a badge it no longer earns. All-time counts survive in
 * `counts` for the honest-numbers readout in Settings → Data. Migration law:
 * v1 flat records (no week attribution possible) keep their all-time totals
 * but start with EMPTY week buckets — they can never claim a weekly badge.
 * Old weeks beyond WEEKS_KEPT are pruned on every write (bounded storage).
 *
 * Privacy: the counters live in THIS browser's localStorage, scoped per
 * business, holding only anonymous press counts of suggestion/action keys —
 * no question text, no network calls. Clearing conversations does not clear
 * them (they are not conversation data); Settings → Data offers an explicit
 * reset, and a normal "clear site data" removes them too.
 *
 * Display rule (topChipUsage): a chip earns the badge only when it is the
 * STRICT leader among the currently visible keys with at least
 * TOP_CHIP_MIN_PRESS presses IN THE CURRENT WEEK — a tie or a single press
 * shows nothing, so a fresh week looks exactly like the pre-R121 UI (honest
 * absence).
 */

/**
 * R122 — the dashboard quick-action vocabulary: the ONLY keys the
 * quick-action badge may ever decorate. The toolbar row is role-gated as a
 * whole, so whenever it renders at all, exactly these keys are visible.
 */
export const QUICK_ACTION_KEYS = [
  "new-sale",
  "new-payment",
  "new-expense",
] as const;

export type QuickActionKey = (typeof QUICK_ACTION_KEYS)[number];

/**
 * R125 — quick-action key → its toolbar label message in the `dashboard`
 * namespace (pure data, shared by the readout and the copilot's local
 * insights panel so every surface speaks the toolbar's exact voice).
 */
export const QUICK_ACTION_LABEL_KEYS: Record<
  QuickActionKey,
  "quickNewInvoice" | "quickRecordPayment" | "quickNewExpense"
> = {
  "new-sale": "quickNewInvoice",
  "new-payment": "quickRecordPayment",
  "new-expense": "quickNewExpense",
};

/**
 * R125 — the R122 subject-hue law as pure data: one bar/badge hue per quick
 * action, shared by the Settings → Data readout and the copilot's insights
 * panel so a key never changes color between surfaces.
 */
export const QUICK_ACTION_BAR_CLASSES: Record<QuickActionKey, string> = {
  "new-sale": "bg-teal-600 dark:bg-teal-500",
  "new-payment": "bg-emerald-600 dark:bg-emerald-500",
  "new-expense": "bg-rose-600 dark:bg-rose-500",
};

/** Storage schema version — v2 adds per-week buckets; v1 records migrate (totals kept, weeks empty). */
const SCHEMA_VERSION = 2;

/**
 * R123 — how many ISO-week buckets a record keeps. Older weeks are pruned
 * on every write, so storage stays bounded forever (8 weeks ≈ two months of
 * "this week" context; the all-time totals in `counts` are unaffected).
 */
export const WEEKS_KEPT = 8;

/**
 * R124 — the readout's longitudinal window: one cell per week in the
 * Settings → Data sparkline. Kept IDENTICAL to WEEKS_KEPT on purpose — the
 * sparkline shows exactly the history the record retains, no more, no less
 * (the battery pins the lockstep).
 */
export const SPARK_WEEKS = WEEKS_KEPT;

/** Hard cap on tracked keys (all-time AND per-week): dropping the least-pressed (ties → smallest key) keeps the record bounded forever. */
export const CHIP_USAGE_CAP = 32;

/** A chip needs at least this many presses before it may wear the badge. */
export const TOP_CHIP_MIN_PRESS = 2;

export type ChipUsage = {
  v: number;
  /** All-time press counts (the v1 semantics, preserved through migration). */
  counts: Record<string, number>;
  /** R123 — per-ISO-week buckets: weekId ("2026-W43") → key → presses that week. */
  weeks: Record<string, Record<string, number>>;
};

/**
 * R123 — PURE: the ISO-8601 week id of `d` ("2026-W43"). Weeks start Monday;
 * the year in the id is the ISO week-numbering year (a late-December Monday
 * can belong to next year's W01). Zero-padded, so lexicographic order equals
 * chronological order — that is what makes pruneWeeks deterministic.
 */
export function isoWeekId(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * PURE: cap a count map at CHIP_USAGE_CAP keys, dropping the least-pressed
 * (deterministic tie-break: lexicographically smallest). Shared by the
 * all-time counts and every weekly bucket — one drop rule everywhere.
 */
function capCounts(counts: Record<string, number>): Record<string, number> {
  const keys = Object.keys(counts);
  while (keys.length > CHIP_USAGE_CAP) {
    let drop = keys[0];
    for (const k of keys) {
      if (counts[k] < counts[drop] || (counts[k] === counts[drop] && k < drop)) {
        drop = k;
      }
    }
    delete counts[drop];
    keys.splice(keys.indexOf(drop), 1);
  }
  return counts;
}

/**
 * PURE: keep only the WEEKS_KEPT most recent week buckets (weekIds are
 * zero-padded "YYYY-Www", so string sort is chronological).
 */
function pruneWeeks(weeks: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const ids = Object.keys(weeks).sort();
  const keep = new Set(ids.slice(-WEEKS_KEPT));
  const out: Record<string, Record<string, number>> = {};
  for (const id of ids) {
    if (keep.has(id)) out[id] = weeks[id];
  }
  return out;
}

/**
 * Pure: return usage with `key` incremented once — in the all-time counts
 * AND in the current ISO-week's bucket (both capped; old weeks pruned).
 * When the all-time map outgrows CHIP_USAGE_CAP the least-pressed key is
 * dropped (deterministic tie-break: lexicographically smallest). Unknown
 * keys are allowed — the badge law filters against visible keys at display
 * time, so a retired suggestion's count simply sits inert.
 */
export function recordChipUsage(
  prev: ChipUsage | null | undefined,
  key: string,
  now: Date = new Date(),
): ChipUsage {
  // Defensive: a v1-shaped in-memory record migrates on its next press.
  const safe = prev && prev.v === SCHEMA_VERSION ? prev : sanitizeChipUsage(prev);
  const counts: Record<string, number> = { ...(safe?.counts ?? {}) };
  counts[key] = (counts[key] ?? 0) + 1;
  const weeks: Record<string, Record<string, number>> = {};
  for (const [id, bucket] of Object.entries(safe?.weeks ?? {})) {
    weeks[id] = { ...bucket };
  }
  const weekId = isoWeekId(now);
  weeks[weekId] = { ...(weeks[weekId] ?? {}) };
  weeks[weekId][key] = (weeks[weekId][key] ?? 0) + 1;
  return {
    v: SCHEMA_VERSION,
    counts: capCounts(counts),
    weeks: pruneWeeks(Object.fromEntries(Object.entries(weeks).map(([id, b]) => [id, capCounts(b)]))),
  };
}

/**
 * Pure: the single chip that earns the "most asked" badge, or null.
 * R123 — candidates are ONLY the currently visible keys and ONLY the
 * CURRENT ISO-week's presses; the winner must have ≥ TOP_CHIP_MIN_PRESS
 * presses and STRICTLY more than the runner-up — a tie decorates nothing
 * (the pool stays exactly as the relevance law ordered it). All-time
 * counts NEVER elect a badge: last month's champion starts every week at
 * zero, like everyone else.
 */
export function topChipUsage(
  usage: ChipUsage | null | undefined,
  visibleKeys: readonly string[],
  now: Date = new Date(),
): string | null {
  if (!usage || usage.v !== SCHEMA_VERSION || !usage.counts || !usage.weeks) return null;
  if (visibleKeys.length < 2) return null;
  const bucket = usage.weeks[isoWeekId(now)];
  if (!bucket) return null;
  const ranked = [...visibleKeys]
    .map((k) => ({ k, n: bucket[k] ?? 0 }))
    .sort((a, b) => b.n - a.n || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (top.n < TOP_CHIP_MIN_PRESS) return null;
  if (top.n <= runnerUp.n) return null;
  return top.k;
}

/**
 * R123 — Pure: the honest-numbers readout for Settings → Data. Returns the
 * all-time counts and the CURRENT week's counts side by side (null for
 * malformed input). The readout shows raw numbers — never a reorder law.
 */
export function usageBreakdown(
  usage: ChipUsage | null | undefined,
  now: Date = new Date(),
): { total: Record<string, number>; weekId: string; week: Record<string, number>; weeks: Record<string, Record<string, number>> } | null {
  if (!usage || usage.v !== SCHEMA_VERSION || !usage.counts || !usage.weeks) return null;
  const weekId = isoWeekId(now);
  return {
    total: { ...usage.counts },
    weekId,
    week: { ...(usage.weeks[weekId] ?? {}) },
    // R124 — the raw per-week history for the sparkline (read-only use).
    weeks: usage.weeks,
  };
}

/**
 * R124 — PURE: the SPARK_WEEKS week ids ending at the week containing
 * `now`, OLDEST → NEWEST (the natural DOM order; flex row mirrors it for
 * RTL so the timeline flows right-to-left with the locale). Week starts are
 * Mondays, so stepping back 7 days at a time from the current week's
 * Monday is exact across month and year boundaries.
 */
export function weekSeriesIds(now: Date = new Date()): string[] {
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - (day - 1)); // Monday of the current ISO week
  const out: string[] = [];
  for (let i = SPARK_WEEKS - 1; i >= 0; i--) {
    const d = new Date(t);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(isoWeekId(d));
  }
  return out;
}

/**
 * R124 — PURE: how many times `key` was pressed in the CURRENT week — the
 * honest number behind a "most asked/used" badge tooltip. Zero for absent
 * weeks/keys and for malformed or pre-v2 records (honest absence).
 */
export function weekCount(
  usage: ChipUsage | null | undefined,
  key: string,
  now: Date = new Date(),
): number {
  if (!usage || usage.v !== SCHEMA_VERSION || !usage.weeks) return 0;
  return usage.weeks[isoWeekId(now)]?.[key] ?? 0;
}

/** PURE (internal): sanitize one weekly bucket with the same law as counts. */
function sanitizeBucket(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, n] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 64) continue;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) continue;
    out[k] = Math.min(n, 1_000_000);
  }
  return capCounts(out);
}

/**
 * Pure: validate unknown localStorage input into a safe ChipUsage, or null.
 * Accepts v1 flat records (migrated: totals kept, week buckets empty — old
 * presses have no week attribution and can never claim a weekly badge) and
 * v2 records (buckets sanitized per-week, junk filtered, caps enforced,
 * weeks pruned to WEEKS_KEPT). Anything malformed — wrong version,
 * non-object, junk values, non-object weeks — returns null (honest
 * absence, the UI simply shows no badge).
 */
export function sanitizeChipUsage(raw: unknown): ChipUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const cand = raw as { v?: unknown; counts?: unknown; weeks?: unknown };
  if (cand.v !== 1 && cand.v !== SCHEMA_VERSION) return null;
  if (typeof cand.counts !== "object" || cand.counts === null) return null;
  const counts: Record<string, number> = {};
  for (const [k, n] of Object.entries(cand.counts as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 64) continue;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) continue;
    counts[k] = Math.min(n, 1_000_000);
  }
  if (Object.keys(counts).length === 0) return null;
  // v1 → migrate with empty weeks; v2 → sanitize each bucket; malformed
  // weeks container → null (a corrupt v2 is not silently "fixed").
  let weeks: Record<string, Record<string, number>> = {};
  if (cand.v === SCHEMA_VERSION && cand.weeks !== undefined) {
    if (typeof cand.weeks !== "object" || cand.weeks === null) return null;
    weeks = {};
    for (const [id, bucket] of Object.entries(cand.weeks as Record<string, unknown>)) {
      if (!/^\d{4}-W\d{2}$/.test(id)) return null;
      weeks[id] = sanitizeBucket(bucket);
    }
  }
  return {
    v: SCHEMA_VERSION,
    counts: capCounts(counts),
    weeks: pruneWeeks(weeks),
  };
}

// ---- localStorage wrappers (browser-only, best-effort) -----------------------

const storageKey = (businessId: string) => `abc:copilot:chip-usage:${businessId}`;
const quickActionStorageKey = (businessId: string) =>
  `abc:quick-actions:usage:${businessId}`;

/** Best-effort read — null on missing/malformed data or when storage is unavailable (SSR, private mode). */
export function readChipUsage(businessId: string): ChipUsage | null {
  try {
    const raw = window.localStorage.getItem(storageKey(businessId));
    if (!raw) return null;
    return sanitizeChipUsage(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Best-effort write — silently ignored when storage is unavailable; a badge-only feature must never break the chat. */
export function writeChipUsage(businessId: string, usage: ChipUsage): void {
  try {
    window.localStorage.setItem(storageKey(businessId), JSON.stringify(usage));
  } catch {
    /* quota / private mode — the in-memory badge still works this session */
  }
}

/** R122 — quick-action counter: same law, SEPARATE storage namespace so a copilot press can never elect a quick action. */
export function readQuickActionUsage(businessId: string): ChipUsage | null {
  try {
    const raw = window.localStorage.getItem(quickActionStorageKey(businessId));
    if (!raw) return null;
    return sanitizeChipUsage(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** R122 — best-effort write for the quick-action counter; failure only costs the badge, never the action itself. */
export function writeQuickActionUsage(businessId: string, usage: ChipUsage): void {
  try {
    window.localStorage.setItem(quickActionStorageKey(businessId), JSON.stringify(usage));
  } catch {
    /* quota / private mode — the in-memory badge still works this session */
  }
}

/**
 * R122 — Settings → Data reset: remove BOTH counters for this business in
 * THIS browser. Best-effort each removal (quota/private-mode safe); the
 * next press simply starts counting again from zero. Badges are
 * decoration, so there is nothing to broadcast — every surface re-reads on
 * mount and shows honest absence immediately.
 */
export function clearUsageAnalytics(businessId: string): void {
  try {
    window.localStorage.removeItem(storageKey(businessId));
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.removeItem(quickActionStorageKey(businessId));
  } catch {
    /* ignore */
  }
}

// ---- R125 — the copilot's LOCAL self-knowledge -------------------------------

export type UsageInsightRow = {
  key: string;
  /** Presses in the current ISO week. */
  week: number;
  /** Presses in the previous ISO week (the week-over-week story). */
  prevWeek: number;
  /** All-time presses (may be 0 when the cap dropped the key from counts). */
  total: number;
};

export type UsageInsightSurface = {
  rows: UsageInsightRow[];
  /** Sum of this week's presses on this surface. */
  weekTotal: number;
  /** Sum of last week's presses on this surface. */
  prevWeekTotal: number;
  /**
   * The badge-law winner over `visibleKeys` — the SAME answer topChipUsage
   * gives the badges, so the panel's "most pressed" line can never disagree
   * with what a badge actually decorates (or with an honest tie/absence).
   */
  leader: string | null;
};

export type UsageInsights = {
  weekId: string;
  prevWeekId: string;
  copilot: UsageInsightSurface;
  quick: UsageInsightSurface;
  weekTotal: number;
  prevWeekTotal: number;
  /** True when EITHER surface saw presses this week or last week. */
  anyData: boolean;
};

/**
 * R125 — PURE: the fact sheet behind the copilot's "Usage on this device"
 * panel. Both counters are DEVICE-local (never networked), so this panel is
 * the one place the copilot product can speak about the user's own usage
 * without the AI: the numbers are computed here, rendered client-side, and
 * clearly fenced from AI answers.
 *
 * Honesty laws carried over unchanged:
 *  - Rows are keys pressed THIS week or LAST week (a week-over-week story);
 *    older keys stay in the Settings → Data readout, which owns all-time.
 *  - The leader per surface is topChipUsage over the caller's visible keys —
 *    one badge law everywhere (strict leader, ≥ TOP_CHIP_MIN_PRESS, current
 *    week only; ties decorate nothing).
 *  - Week ids come from weekSeriesIds (lockstep with the readout's sparkline
 *    window), so prevWeekId is exactly the bucket the record retains.
 *  - A retired key (no longer in visibleKeys) still shows its honest numbers
 *    but can never lead.
 */
export function usageInsights(
  copilotUsage: ChipUsage | null | undefined,
  quickUsage: ChipUsage | null | undefined,
  visibleKeys: { copilot: readonly string[]; quick: readonly string[] },
  now: Date = new Date(),
): UsageInsights {
  const series = weekSeriesIds(now);
  const weekId = series[series.length - 1];
  const prevWeekId = series[series.length - 2];

  const surface = (
    usage: ChipUsage | null | undefined,
    keys: readonly string[],
  ): UsageInsightSurface => {
    const weekBucket = (usage && usage.v === SCHEMA_VERSION && usage.weeks?.[weekId]) || {};
    const prevBucket = (usage && usage.v === SCHEMA_VERSION && usage.weeks?.[prevWeekId]) || {};
    const rowKeys = Array.from(
      new Set([...Object.keys(weekBucket), ...Object.keys(prevBucket)]),
    );
    const rows = rowKeys
      .map((key) => ({
        key,
        week: weekBucket[key] ?? 0,
        prevWeek: prevBucket[key] ?? 0,
        total: usage?.counts?.[key] ?? 0,
      }))
      .sort(
        (a, b) =>
          b.week - a.week ||
          b.prevWeek - a.prevWeek ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
    return {
      rows,
      weekTotal: rows.reduce((n, r) => n + r.week, 0),
      prevWeekTotal: rows.reduce((n, r) => n + r.prevWeek, 0),
      leader: topChipUsage(usage, keys, now),
    };
  };

  const copilot = surface(copilotUsage, visibleKeys.copilot);
  const quick = surface(quickUsage, visibleKeys.quick);
  return {
    weekId,
    prevWeekId,
    copilot,
    quick,
    weekTotal: copilot.weekTotal + quick.weekTotal,
    prevWeekTotal: copilot.prevWeekTotal + quick.prevWeekTotal,
    anyData: copilot.weekTotal + copilot.prevWeekTotal + quick.weekTotal + quick.prevWeekTotal > 0,
  };
}
