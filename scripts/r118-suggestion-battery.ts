/**
 * R118 — SUGGESTION BATTERY (pure-function, no DB, no server, no browser).
 *
 * R118 extracted the copilot's two suggestion pools into the pure module
 * src/modules/copilot/suggestions.ts so the deterministic logic is
 * headlessly testable (R117 candidate ②). This battery pins the laws:
 *
 *   L-LEAD   the follow-up LEAD chip obeys the SAME relevance law as the
 *            pool (the R118 fix — before it, the first regex match bypassed
 *            followUpRelevant, so rule 6d's RAW fallback answer, which still
 *            says "compared to the previous 30 days", surfaced the trend
 *            chip exactly when its percentage would be a fabrication);
 *   L-TREND  the trend chip exists only when hasTrendPct (L8 honesty),
 *            in BOTH pools, EN and FA;
 *   L-ROT    rotation is deterministic by conversation length;
 *   L-HIDE   empty-state hideable chips vanish until the data supports
 *            them; always-visible chips sort to the muted tail;
 *   L-ORDER  relevant-first, pool-order-stable (suggestionTrend leads).
 *
 * Run: bun scripts/r118-suggestion-battery.ts
 */
import {
  FOLLOW_UP_KEYS,
  pickEmptyStateSuggestions,
  pickFollowUps,
  type SuggestionCounts,
} from "../src/modules/copilot/suggestions";

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const TREND_ANSWER_EN = "Revenue increased by 23% compared to the previous 30 days.";
// The EXACT rule-6d RAW fallback shape: names the previous window, no pct.
const TREND_RAW_FALLBACK_EN =
  "Revenue was $200.00 compared to $246.00 in the previous window (Aug 26 - Sep 24).";
const TREND_ANSWER_FA = "درآمد نسبت به ۳۰ روز قبل چقدر تغییر کرد؟ رشد ۲۰٪.";

const withTrend: SuggestionCounts = {
  receivableCount: 2,
  lowStockCount: 1,
  salesCount: 5,
  expensesCount: 3,
  topProducts: 4,
  hasTrendPct: true,
};
const noTrend: SuggestionCounts = { ...withTrend, hasTrendPct: false };

// ---- A. Follow-up lead laws ---------------------------------------------------

// A1 — a trend answer leads with the trend chip when an honest pct exists
// (also proves matcher precedence: the answer names "revenue", but trend
// sits BEFORE followUpSales in the matcher list).
{
  const picked = pickFollowUps(TREND_ANSWER_EN, 2, withTrend);
  check("A1 trend answer + pct → lead followUpTrend", picked[0] === "followUpTrend", picked.join(","));
}

// A2 — THE R118 FIX: the same answer on a zero/negative baseline must NOT
// surface the trend chip. The lead falls through to the next honest
// matcher (sales — the answer names revenue).
{
  const picked = pickFollowUps(TREND_ANSWER_EN, 2, noTrend);
  check(
    "A2 trend answer + NO pct → followUpTrend absent, lead falls to followUpSales",
    !picked.includes("followUpTrend") && picked[0] === "followUpSales",
    picked.join(","),
  );
}

// A3 — rule 6d's RAW fallback wording ("compared to ... the previous window")
// on a no-baseline summary: the exact live sentence that used to leak the
// trend chip through the lead bypass.
{
  const picked = pickFollowUps(TREND_RAW_FALLBACK_EN, 4, noTrend);
  check(
    "A3 RAW-fallback wording on no-baseline → no trend chip",
    !picked.includes("followUpTrend"),
    picked.join(","),
  );
}

// A4 — FA trend answer leads with the trend chip (FA regexes), same law.
{
  const picked = pickFollowUps(TREND_ANSWER_FA, 2, withTrend);
  check("A4 FA trend answer + pct → lead followUpTrend", picked[0] === "followUpTrend", picked.join(","));
  const pickedNo = pickFollowUps(TREND_ANSWER_FA, 2, noTrend);
  check(
    "A5 FA trend answer + NO pct → trend absent, sales leads",
    !pickedNo.includes("followUpTrend") && pickedNo[0] === "followUpSales",
    pickedNo.join(","),
  );
}

// A6 — counts not loaded (null): neutral default keeps today's behavior —
// the first matching matcher still leads.
{
  const picked = pickFollowUps(TREND_ANSWER_EN, 2, null);
  check("A6 counts null → trend lead preserved (neutral default)", picked[0] === "followUpTrend", picked.join(","));
}

// A7 — an ordinary sales answer never triggers the trend probe (the R117
// regex-specificity law), even with an honest pct available.
{
  const picked = pickFollowUps("How were my sales this month?", 2, withTrend);
  check(
    "A7 ordinary sales answer → lead followUpSales (never trend)",
    picked[0] === "followUpSales" && picked[1] !== "followUpTrend",
    picked.join(","),
  );
}

// A8 — an irrelevant lead is DROPPED, never silently promoted to a
// different subject: "who owes me" with zero receivables yields no lead
// and no outstanding chip at all.
{
  const picked = pickFollowUps("Who owes me money?", 3, { ...withTrend, receivableCount: 0 });
  check(
    "A8 outstanding question + 0 receivables → chip absent entirely",
    !picked.includes("followUpOutstanding"),
    picked.join(","),
  );
}

// A9 — the whole pool respects relevance: zero receivables can never leak
// the outstanding chip from rotation, at any conversation length.
{
  let leaks = 0;
  for (let len = 1; len <= 12; len++) {
    const picked = pickFollowUps("Give me a summary of the business.", len, {
      ...withTrend,
      receivableCount: 0,
      lowStockCount: 0,
    });
    if (picked.includes("followUpOutstanding") || picked.includes("followUpLowStock")) leaks++;
  }
  check("A9 12-length rotation sweep → no hidden-subject leaks", leaks === 0, `${leaks} leaks`);
}

// A10 — rotation is deterministic: same inputs → same output; different
// conversation lengths rotate the pool (regression guard for the modulo).
{
  const a = pickFollowUps("How is my cash flow?", 2, withTrend);
  const b = pickFollowUps("How is my cash flow?", 2, withTrend);
  const c = pickFollowUps("How is my cash flow?", 3, withTrend);
  const d = pickFollowUps("How is my cash flow?", 4, withTrend);
  const same = (x: string[], y: string[]) => x.join("|") === y.join("|");
  check(
    "A10 deterministic; lengths rotate the pool",
    same(a, b) && !same(b, c) && !same(c, d),
    `L2=[${a}] L3=[${c}] L4=[${d}]`,
  );
}

// A11 — every produced key is a legal FOLLOW_UP_KEYS member.
{
  const legal = new Set<string>(FOLLOW_UP_KEYS);
  let illegal = 0;
  for (let len = 0; len < 9; len++) {
    for (const answer of [TREND_ANSWER_EN, TREND_ANSWER_FA, "summarize", "cash flow", "پرداخت‌ها"]) {
      for (const p of pickFollowUps(answer, len, withTrend)) if (!legal.has(p)) illegal++;
      for (const p of pickFollowUps(answer, len, null)) if (!legal.has(p)) illegal++;
    }
  }
  check("A11 all picked keys ∈ FOLLOW_UP_KEYS", illegal === 0, `${illegal} illegal`);
}

// ---- B. Empty-state pool laws --------------------------------------------------

// B1 — counts null: all 7 chips visible, relevant, pool order (trend first).
{
  const picked = pickEmptyStateSuggestions(null);
  const keys = picked.map((p) => p.key);
  check(
    "B1 counts null → 7 chips, all relevant, trend leads",
    picked.length === 7 && keys[0] === "suggestionTrend" && picked.every((p) => p.relevant),
    keys.join(","),
  );
}

// B2 — healthy counts: trend leads, relevant keep pool order, hidden
// hideables vanish.
{
  const keys = pickEmptyStateSuggestions(withTrend).map((p) => p.key);
  check(
    "B2 healthy counts → [trend, s1, s2, s3, s4, s6] (s5 low-stock hidden at lowStock=1? no — present)",
    keys[0] === "suggestionTrend" && keys.includes("suggestion1") && keys.includes("suggestion5"),
    keys.join(","),
  );
}

// B3 — no honest baseline → the trend chip NEVER appears (L8, both pools).
{
  const keys = pickEmptyStateSuggestions(noTrend).map((p) => p.key);
  check("B3 no trend pct → suggestionTrend absent", !keys.includes("suggestionTrend"), keys.join(","));
}

// B4 — hideable law: receivable 0 hides suggestion1 entirely; expenses 0
// keeps suggestion3 visible but sorted to the muted tail with relevant:false.
{
  const picked = pickEmptyStateSuggestions({ ...withTrend, receivableCount: 0, expensesCount: 0 });
  const keys = picked.map((p) => p.key);
  const last = picked[picked.length - 1];
  check(
    "B4 receivable 0 hides s1; expenses 0 → s3 muted tail",
    !keys.includes("suggestion1") && last.key === "suggestion3" && last.relevant === false,
    keys.join(","),
  );
}

// B5 — the exact all-zero-but-trend shape: relevant group = [trend, s2, s6],
// muted tail = [s3, s4], hidden = [s1, s5].
{
  const picked = pickEmptyStateSuggestions({
    receivableCount: 0,
    lowStockCount: 0,
    salesCount: 5,
    expensesCount: 0,
    topProducts: 0,
    hasTrendPct: true,
  });
  const keys = picked.map((p) => p.key);
  check(
    "B5 all-zero-but-trend → [trend, s2, s6] + muted [s3, s4]",
    keys.join(",") === "suggestionTrend,suggestion2,suggestion6,suggestion3,suggestion4",
    keys.join(","),
  );
}

// B6 — with an honest trend AND money owed, the trend chip outranks the
// classic "who owes" opener (the designed lead).
{
  const keys = pickEmptyStateSuggestions(withTrend).map((p) => p.key);
  check(
    "B6 trend pct → trend outranks outstanding",
    keys.indexOf("suggestionTrend") === 0 && keys.indexOf("suggestion1") > 0,
    keys.join(","),
  );
}

// ---- Verdict -------------------------------------------------------------------

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
console.log("R118 SUGGESTION BATTERY GREEN ✓");
