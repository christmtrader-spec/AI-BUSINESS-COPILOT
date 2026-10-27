/**
 * Copilot suggestion intelligence — PURE module (no React, no i18n runtime).
 *
 * Extracted from copilot-view.tsx in R118 so the two suggestion pools can be
 * unit-tested headlessly (scripts/r118-suggestion-battery.ts imports this
 * file directly under bun). The view maps the returned KEYS to translated
 * copy + lucide icons; everything below is deterministic logic only.
 *
 * Two pools share one law (r10 + R117): a chip is only proposed when its
 * subject actually exists in the data — "only propose restock when there is
 * something to restock", "only ask about trends when an honest percentage
 * exists".
 */

// ---- Live server counts ------------------------------------------------------

/** The cached reports/summary payload the view fetches (["reports","summary","30"]). */
export type SummaryLite = {
  kpis?: { salesCount?: number; expensesCount?: number };
  outstanding?: { receivableCount?: number };
  inventory?: { lowStockCount?: number };
  topProducts?: unknown[];
  /** R117 — the previous-window comparison block. The trend chip is proposed
   *  ONLY when at least one pct is honestly quotable (L8: the server returns
   *  null on a ≤0 baseline — never surface a question whose answer would be a
   *  fabricated percentage). */
  trend?: { revenueChangePct?: number | null };
};

/** Normalized counts every relevance predicate reads (null = not loaded yet). */
export type SuggestionCounts = {
  receivableCount: number;
  lowStockCount: number;
  salesCount: number;
  expensesCount: number;
  topProducts: number;
  hasTrendPct: boolean;
};

// ---- Follow-up pool -----------------------------------------------------------

/**
 * Context-aware follow-up pool. The chips are UI suggestions only — they
 * never touch data. Deterministic: keyword match on the answer text picks
 * the lead chip; the rest rotate by conversation length so repeated
 * answers surface different prompts.
 */
export const FOLLOW_UP_KEYS = [
  "followUpOutstanding",
  "followUpLowStock",
  "followUpExpenses",
  "followUpTrend",
  "followUpSales",
  "followUpCash",
  "followUpProducts",
  "followUpPayments",
  "followUpSummary",
] as const;

export type FollowUpKey = (typeof FOLLOW_UP_KEYS)[number];

export const FOLLOW_UP_MATCHERS: Array<{ key: FollowUpKey; re: RegExp }> = [
  { key: "followUpOutstanding", re: /owe|outstanding|receivable|بدهکار|بدهی|طلب/i },
  { key: "followUpLowStock", re: /low.?stock|restock|inventory|موجودی|انبار|شارژ/i },
  { key: "followUpExpenses", re: /expense|spend|cost|هزینه|خرج/i },
  // R117 — trend answers lead with the trend probe. MUST sit BEFORE
  // followUpSales: a trend answer always names "revenue/sales", and the
  // first matching key wins. The regex is trend-specific (compare/vs/
  // growth/previous N days) so ordinary sales answers never hit it.
  { key: "followUpTrend", re: /compare|\btrend|\bgrowth|\bvs\b|previous (7|30|90) days|روند|رشد|مقایسه|نسبت به/i },
  { key: "followUpSales", re: /sale|revenue|invoice|فروش|درآمد|فاکتور/i },
  { key: "followUpCash", re: /cash|payment|collected|نقد|پرداخت|دریافتی/i },
  { key: "followUpProducts", re: /product|best.?seller|top|محصول|پرفروش/i },
];

/** Relevance law: is this follow-up subject honest to ask about right now? */
export function followUpRelevant(
  key: FollowUpKey,
  counts: SuggestionCounts | null,
): boolean {
  if (!counts) return true; // counts not loaded yet — keep the neutral default
  switch (key) {
    case "followUpOutstanding":
      return counts.receivableCount > 0;
    case "followUpLowStock":
      return counts.lowStockCount > 0;
    case "followUpExpenses":
      return counts.expensesCount > 0;
    case "followUpProducts":
      return counts.topProducts > 0;
    case "followUpTrend":
      return counts.hasTrendPct;
    case "followUpSales":
      return true;
    case "followUpCash":
    case "followUpPayments":
    case "followUpSummary":
      return true;
  }
}

export function pickFollowUps(
  answer: string,
  conversationLength: number,
  counts: SuggestionCounts | null = null,
): FollowUpKey[] {
  // R118 — the lead now obeys the SAME relevance law as the pool. Before
  // this fix the first regex match bypassed followUpRelevant, so rule 6d's
  // RAW fallback answer ("Revenue was $200 compared to $246 in the previous
  // window") — which still contains "compared to the previous 30 days" —
  // surfaced the trend chip EXACTLY when its percentage would be a
  // fabrication. The lead is the first matcher that both matches the answer
  // AND is honest to propose; an irrelevant lead is dropped, never silently
  // promoted to a different subject.
  const lead = FOLLOW_UP_MATCHERS.find(
    (m) => m.re.test(answer) && followUpRelevant(m.key, counts),
  )?.key;
  const pool = FOLLOW_UP_KEYS.filter(
    (k) => k !== lead && followUpRelevant(k, counts),
  );
  const rotate = conversationLength % Math.max(1, pool.length);
  const rotated = [...pool.slice(rotate), ...pool.slice(0, rotate)];
  const picked = rotated.slice(0, lead ? 2 : 3);
  return lead ? [lead, ...picked] : picked;
}

// ---- Empty-state pool ----------------------------------------------------------

/**
 * R119 — the DASHBOARD's copilot card may ask the trend question only when
 * an honest percentage exists. Same law as both pools, now on a third
 * surface (the summary the dashboard already fetches carries the trend
 * block): a null/absent pct means the previous window was zero or negative,
 * so a "how did revenue change" question would be answered with a fabricated
 * percentage — the chip must not exist. Pure so
 * scripts/r119-intent-check.ts can pin it headlessly.
 */
export function dashboardTrendQuestion(
  summary:
    | { trend?: { revenueChangePct?: number | null } }
    | null
    | undefined,
): boolean {
  return summary?.trend?.revenueChangePct != null;
}

/**
 * Empty-state suggestions (the first screen, before any conversation).
 * `relevant` decides ordering (relevant-first) and, with `hideable`, whether
 * the chip may disappear entirely — purely-unhelpful chips ("who owes" with
 * 0 open invoices, "restock" with nothing low, a trend question with no
 * honest baseline) stay hidden until the data supports them.
 *
 * suggestionTrend (R118, R117 candidate ①) sits FIRST: when an honest
 * comparison exists it is the freshest insight the copilot can offer, and
 * the relevant-first sort promotes it to the lead chip.
 */
export const EMPTY_STATE_SUGGESTIONS = [
  { key: "suggestionTrend", relevant: (c: SuggestionCounts) => c.hasTrendPct, hideable: true },
  { key: "suggestion1", relevant: (c: SuggestionCounts) => c.receivableCount > 0, hideable: true },
  { key: "suggestion2", relevant: (_c: SuggestionCounts) => true, hideable: false },
  { key: "suggestion3", relevant: (c: SuggestionCounts) => c.expensesCount > 0, hideable: false },
  { key: "suggestion4", relevant: (c: SuggestionCounts) => c.topProducts > 0, hideable: false },
  { key: "suggestion5", relevant: (c: SuggestionCounts) => c.lowStockCount > 0, hideable: true },
  { key: "suggestion6", relevant: (_c: SuggestionCounts) => true, hideable: false },
] as const;

export type SuggestionKey = (typeof EMPTY_STATE_SUGGESTIONS)[number]["key"];

/**
 * R125 — the full copilot counter vocabulary: every key the badge law could
 * ever decorate across BOTH pools (empty-state + follow-ups). One source of
 * truth for the Settings → Data readout and the copilot's local insights
 * panel — a key outside this list is retired (honest raw numbers, never a
 * leader).
 */
export const COPILOT_USAGE_VOCAB = [
  ...EMPTY_STATE_SUGGESTIONS.map((s) => s.key),
  ...FOLLOW_UP_KEYS,
] as const;

/**
 * Returns the visible suggestions, relevant-first (stable, deterministic),
 * each with its relevance flag so the view can style never-relevant-but-
 * visible chips (hideable: false) as muted.
 */
export function pickEmptyStateSuggestions(
  counts: SuggestionCounts | null,
): Array<{ key: SuggestionKey; relevant: boolean }> {
  const items = EMPTY_STATE_SUGGESTIONS.map((s) => ({
    key: s.key as SuggestionKey,
    relevant: counts ? s.relevant(counts) : true,
    hideable: s.hideable,
  }));
  const visible = items.filter((i) => i.relevant || !i.hideable);
  return [
    ...visible.filter((i) => i.relevant),
    ...visible.filter((i) => !i.relevant),
  ].map(({ key, relevant }) => ({ key, relevant }));
}
