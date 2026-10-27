/**
 * R125 — PURE battery for the copilot's LOCAL usage-insights panel (bun, no DOM).
 * The panel is the one place the copilot product speaks about the user's own
 * usage WITHOUT the AI — the fact sheet below must be exactly as honest as
 * the badges it mirrors:
 *   A  shape + honest empties (null inputs, v1 records)
 *   B  week-over-week rows — inclusion (this/last week only), WoW arithmetic,
 *      row totals (all-time), retirement honesty
 *   C  the leader is the BADGE LAW's answer — strict lead, ≥2, current week,
 *      ties decorate nothing, retired keys never lead, pool isolation
 *   D  totals + anyData across both surfaces (copilot presses never leak
 *      into the quick surface and vice versa)
 *   E  weekId/prevWeekId lockstep with weekSeriesIds (boundaries incl.
 *      the 53-week year), sorting law (week desc, prevWeek desc, key asc)
 *   F  purity — same inputs, deep-equal outputs, no mutation
 */
import {
  TOP_CHIP_MIN_PRESS,
  isoWeekId,
  recordChipUsage,
  sanitizeChipUsage,
  usageInsights,
  weekSeriesIds,
  QUICK_ACTION_KEYS,
  type ChipUsage,
  type UsageInsights,
} from "../src/lib/chip-usage";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const WED = new Date("2026-10-21T12:00:00Z"); // 2026-W43
const FRI27 = new Date("2027-01-01T12:00:00Z"); // week 2026-W53

const COPILOT_KEYS = [
  "suggestionTrend",
  "suggestion1",
  "suggestion2",
  "suggestion3",
  "suggestion4",
  "suggestion5",
  "suggestion6",
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

/** Build a v2 record from per-week buckets + all-time counts. */
function rec(
  counts: Record<string, number>,
  weeks: Record<string, Record<string, number>>,
): ChipUsage {
  return { v: 2, counts, weeks };
}

/** Deep equal (rows are plain data). */
function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- A  shape + honest empties ------------------------------------------------

{
  const ins = usageInsights(null, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("A1 weekId is the current ISO week", ins.weekId === "2026-W43", ins.weekId);
  check("A2 prevWeekId is the previous ISO week", ins.prevWeekId === "2026-W42", ins.prevWeekId);
  check("A3 null inputs → zeroed copilot surface", ins.copilot.rows.length === 0 && ins.copilot.weekTotal === 0 && ins.copilot.prevWeekTotal === 0);
  check("A4 null inputs → zeroed quick surface", ins.quick.rows.length === 0 && ins.quick.weekTotal === 0);
  check("A5 null leaders on empties", ins.copilot.leader === null && ins.quick.leader === null);
  check("A6 anyData false on empties", ins.anyData === false);
  check("A7 grand totals zero", ins.weekTotal === 0 && ins.prevWeekTotal === 0);

  // A v1 record (migrated: totals kept, weeks empty) stays honest — no week
  // attribution may be invented, so it is weekly-silence.
  const v1 = sanitizeChipUsage({ v: 1, counts: { suggestion2: 9 } });
  check("A8 v1 sanitizes to a v2 with empty weeks", v1 !== null && Object.keys(v1.weeks).length === 0);
  const insV1 = usageInsights(v1, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("A9 v1 → no rows, anyData false", insV1.copilot.rows.length === 0 && insV1.anyData === false);
  check("A10 v1 → leader null (weekly law)", insV1.copilot.leader === null);
}

// ---- B  week-over-week rows ----------------------------------------------------

{
  // This week: trend ×2, suggestion2 ×1. Last week: suggestion2 ×3, suggestion3 ×1.
  const u = rec(
    { suggestionTrend: 5, suggestion2: 4, suggestion3: 1 },
    {
      "2026-W43": { suggestionTrend: 2, suggestion2: 1 },
      "2026-W42": { suggestion2: 3, suggestion3: 1 },
      "2026-W30": { suggestion2: 7 }, // older week — outside the WoW story
    },
  );
  const ins = usageInsights(u, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  const rows = ins.copilot.rows;
  check("B1 rows = this-week ∪ last-week keys", rows.length === 3, JSON.stringify(rows.map((r) => r.key)));
  check("B2 older weeks excluded from rows", !rows.some((r) => r.key === "suggestion5"));

  const trend = rows.find((r) => r.key === "suggestionTrend");
  const s2 = rows.find((r) => r.key === "suggestion2");
  const s3 = rows.find((r) => r.key === "suggestion3");
  check("B3 trend: week 2, prevWeek 0, total 5", !!trend && trend.week === 2 && trend.prevWeek === 0 && trend.total === 5);
  check("B4 suggestion2: week 1, prevWeek 3, total 4", !!s2 && s2.week === 1 && s2.prevWeek === 3 && s2.total === 4);
  check("B5 suggestion3: week 0, prevWeek 1, total 1", !!s3 && s3.week === 0 && s3.prevWeek === 1 && s3.total === 1);
  check("B6 surface weekTotal 3 / prevWeekTotal 4", ins.copilot.weekTotal === 3 && ins.copilot.prevWeekTotal === 4);
  check("B7 anyData true with any recent activity", ins.anyData === true);

  // prev-week-only activity still counts (the WoW story needs last week).
  const prevOnly = rec({}, { "2026-W42": { followUpSales: 2 } });
  const insPrev = usageInsights(prevOnly, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("B8 prev-week-only → anyData true", insPrev.anyData === true);
  check("B9 prev-week-only row: week 0, prevWeek 2", deepEq(insPrev.copilot.rows, [{ key: "followUpSales", week: 0, prevWeek: 2, total: 0 }]));
  check("B10 prev-week-only → no leader (current-week law)", insPrev.copilot.leader === null);
  check("B11 all-time total 0 shown honestly (not fabricated)", insPrev.copilot.rows[0].total === 0);
}

// ---- C  the leader is the BADGE LAW's answer -----------------------------------

{
  // Strict lead of 2 this week → leader.
  const lead = rec({ suggestion2: 2 }, { "2026-W43": { suggestion2: 2, suggestion3: 1 } });
  const insLead = usageInsights(lead, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("C1 strict weekly lead of 2 → leader", insLead.copilot.leader === "suggestion2");

  // Tie → nothing.
  const tie = rec({}, { "2026-W43": { suggestion2: 2, suggestion3: 2 } });
  const insTie = usageInsights(tie, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("C2 weekly tie → leader null", insTie.copilot.leader === null);

  // Single press → nothing.
  const one = rec({}, { "2026-W43": { suggestion2: 1 } });
  const insOne = usageInsights(one, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check(`C3 single press (< ${TOP_CHIP_MIN_PRESS}) → leader null`, insOne.copilot.leader === null);

  // All-time giant cannot buy a badge.
  const giant = rec({ suggestion2: 99 }, { "2026-W42": { suggestion2: 99 } });
  const insGiant = usageInsights(giant, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("C4 99 all-time presses, 0 this week → leader null", insGiant.copilot.leader === null);

  // A retired key (outside visibleKeys) shows its numbers but never leads —
  // even when it strictly leads the raw counts.
  const retired = rec({}, { "2026-W43": { "ghost-chip": 5, suggestion2: 2 } });
  const insRet = usageInsights(retired, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("C5 retired key appears in rows with honest numbers", insRet.copilot.rows.some((r) => r.key === "ghost-chip" && r.week === 5));
  check("C6 retired key can never lead", insRet.copilot.leader === "suggestion2");

  // Quick-action surface uses ITS OWN keys: a copilot press must not elect it.
  const qa = rec({}, { "2026-W43": { "new-payment": 2 } });
  const insQa = usageInsights(null, qa, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("C7 quick leader from the quick namespace only", insQa.quick.leader === "new-payment" && insQa.copilot.leader === null);
  check("C8 quick rows isolated from copilot surface", insQa.copilot.rows.length === 0 && insQa.quick.rows.length === 1);

  // Fewer than 2 visible keys can never elect (topChipUsage law).
  const insTiny = usageInsights(rec({}, { "2026-W43": { "new-payment": 3 } }), null, { copilot: COPILOT_KEYS, quick: ["new-payment"] }, WED);
  check("C9 single-key pool → no leader", insTiny.quick.leader === null);
}

// ---- D  totals + anyData across both surfaces ----------------------------------

{
  const cop = rec({}, { "2026-W43": { suggestion2: 2 }, "2026-W42": { suggestion2: 1 } });
  const qa = rec({}, { "2026-W43": { "new-payment": 2, "new-expense": 1 }, "2026-W42": { "new-payment": 4 } });
  const ins = usageInsights(cop, qa, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("D1 copilot weekTotal 2 / prevWeek 1", ins.copilot.weekTotal === 2 && ins.copilot.prevWeekTotal === 1);
  check("D2 quick weekTotal 3 / prevWeek 4", ins.quick.weekTotal === 3 && ins.quick.prevWeekTotal === 4);
  check("D3 grand weekTotal 5 / prevWeek 5", ins.weekTotal === 5 && ins.prevWeekTotal === 5);
  check("D4 anyData true", ins.anyData === true);
  check("D5 quick rows sorted week desc then key", deepEq(ins.quick.rows.map((r) => r.key), ["new-payment", "new-expense"]));

  // Cross-surface leak check: copilot presses never land in the quick totals.
  const leak = usageInsights(rec({}, { "2026-W43": { suggestion2: 7 } }), null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("D6 copilot presses stay in the copilot surface", leak.quick.weekTotal === 0 && leak.copilot.weekTotal === 7);
}

// ---- E  weekId lockstep + sorting law -------------------------------------------

{
  const ins = usageInsights(null, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  const series = weekSeriesIds(WED);
  check("E1 weekId = last of weekSeriesIds", ins.weekId === series[series.length - 1]);
  check("E2 prevWeekId = second-to-last of weekSeriesIds", ins.prevWeekId === series[series.length - 2]);

  const ins27 = usageInsights(null, null, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, FRI27);
  check("E3 53-week-year boundary: weekId 2026-W53", ins27.weekId === "2026-W53", ins27.weekId);
  check("E4 boundary prevWeekId 2026-W52", ins27.prevWeekId === "2026-W52", ins27.prevWeekId);

  // Sorting: week desc → prevWeek desc → key asc.
  const u = rec(
    {},
    {
      "2026-W43": { b: 3, c: 3, a: 1 },
      "2026-W42": { a: 2, c: 1 },
    },
  );
  const insSort = usageInsights(u, null, { copilot: ["a", "b", "c"], quick: QUICK_ACTION_KEYS }, WED);
  check("E5 sort law week desc, prevWeek desc, key asc", deepEq(insSort.copilot.rows.map((r) => r.key), ["c", "b", "a"]), JSON.stringify(insSort.copilot.rows.map((r) => r.key)));
}

// ---- F  purity ------------------------------------------------------------------

{
  const cop = rec({ suggestion2: 3 }, { "2026-W43": { suggestion2: 2 }, "2026-W42": { suggestion2: 1 } });
  const qa = rec({}, { "2026-W43": { "new-payment": 2 } });
  const copFrozen = JSON.parse(JSON.stringify(cop)) as ChipUsage;
  const qaFrozen = JSON.parse(JSON.stringify(qa)) as ChipUsage;
  const ins1 = usageInsights(cop, qa, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  const snap1 = JSON.stringify(ins1);
  const ins2 = usageInsights(cop, qa, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  check("F1 deterministic — same inputs, same fact sheet", JSON.stringify(ins2) === snap1);
  check("F2 inputs unmutated", deepEq(cop, copFrozen) && deepEq(qa, qaFrozen));
  const ins3: UsageInsights = usageInsights(cop, qa, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED);
  ins3.copilot.rows.push({ key: "mutation-attempt", week: 1, prevWeek: 0, total: 0 });
  check("F3 output mutation does not leak between calls", JSON.stringify(usageInsights(cop, qa, { copilot: COPILOT_KEYS, quick: QUICK_ACTION_KEYS }, WED)) === snap1);
  void isoWeekId; // imported for parity with the r124 battery; exercised via weekSeriesIds
}

console.log(`\nr125-usage-insights-check: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
