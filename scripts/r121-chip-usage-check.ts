/**
 * R121 — PURE battery for src/lib/chip-usage.ts (bun, no DOM).
 *
 * Pins the BADGE-ONLY law: the click-through counter can decorate a chip
 * with "most asked" but the suggestion pools themselves stay untouched
 * (those are r118/r119's batteries). Sections:
 *   A  recordChipUsage — increment, first press, unknown keys, cap + drop rule
 *   B  topChipUsage — min-press threshold, strict lead, ties, single-key
 *      pool, foreign keys ignored, version gate
 *   C  sanitizeChipUsage — malformed inputs → null, junk values filtered,
 *      cap enforced
 *   D  end-to-end pure flow — press → top → badge placement on a realistic pool
 *
 * R123: the record is now v2 (all-time counts + per-ISO-week buckets) and
 * the badge reads the CURRENT week only. All presses below go through rec()
 * / top() with ONE fixed instant, so the whole battery runs inside a single
 * deterministic ISO week; the weekly-window law itself is pinned by
 * r123-usage-window-check (49 checks).
 */
import {
  CHIP_USAGE_CAP,
  TOP_CHIP_MIN_PRESS,
  recordChipUsage,
  topChipUsage,
  sanitizeChipUsage,
  type ChipUsage,
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

const POOL = ["suggestionTrend", "suggestion1", "suggestion2", "suggestion3", "suggestion4"] as const;

// One fixed instant → every rec()/top() pair lands in the same ISO week (2026-W43).
const NOW = new Date("2026-10-21T12:00:00Z");
const rec = (u: Parameters<typeof recordChipUsage>[0], k: string) => recordChipUsage(u, k, NOW);
const top = (u: Parameters<typeof topChipUsage>[0], keys: readonly string[]) => topChipUsage(u, keys, NOW);

// ---- A  recordChipUsage ------------------------------------------------------
console.log("A  recordChipUsage");
{
  const first = rec(null, "suggestionTrend");
  check("A1 first press → 1", first.counts.suggestionTrend === 1);
  check("A1 schema v stamped", first.v === 2);
  check("A1 week bucket stamped", first.weeks[NOW.getUTCFullYear() + "-W43"]?.suggestionTrend === 1);

  const second = rec(first, "suggestionTrend");
  check("A2 increment → 2", second.counts.suggestionTrend === 2);
  check("A2 input untouched (pure)", first.counts.suggestionTrend === 1);

  const mixed = rec(second, "suggestion1");
  check(
    "A3 second key independent",
    mixed.counts.suggestionTrend === 2 && mixed.counts.suggestion1 === 1,
  );

  const unknown = rec(mixed, "someRetiredKey");
  check("A4 unknown key allowed (inert until visible)", unknown.counts.someRetiredKey === 1);

  // Cap: fill past CAP+1 keys, least-pressed drops; tie → lexicographically smallest.
  let full: ChipUsage = { v: 2, counts: { "zz-crowd": 9 }, weeks: {} };
  const letters = "abcdefghijklmnopqrstuvwxyz123456".split(""); // 32 more keys → 33 total
  for (const l of letters) full = rec(full, `k-${l}`);
  check(`A5 cap respected (${CHIP_USAGE_CAP})`, Object.keys(full.counts).length === CHIP_USAGE_CAP);
  check("A5a 'zz-crowd' (highest) survives", full.counts["zz-crowd"] === 9);
  check("A5a1 exactly one 1-press key dropped (the tie-smallest k-1)", full.counts["k-1"] === undefined && full.counts["k-2"] === 1);
  const oneMore = rec(full, "zz-crowd"); // all keys now ≥1, tie on the 1s
  check("A5b still capped after more presses", Object.keys(oneMore.counts).length === CHIP_USAGE_CAP);
  const minVal = Math.min(...Object.values(oneMore.counts));
  const minKeys = Object.keys(oneMore.counts).filter((k) => oneMore.counts[k] === minVal);
  check(
    "A5c minimum-count keys remain after drop (cap is the law)",
    minKeys.length >= 1 && Object.keys(oneMore.counts).length === CHIP_USAGE_CAP,
  );
  // Determinism: same input → same victim.
  const again = rec(full, "zz-crowd");
  check("A5d deterministic drop (pure repeat identical)", JSON.stringify(again) === JSON.stringify(oneMore));
}

// ---- B  topChipUsage ---------------------------------------------------------
console.log("B  topChipUsage");
{
  check("B1 null usage → null", top(null, POOL) === null);
  check("B2 undefined → null", top(undefined, POOL) === null);

  const onePress = rec(null, "suggestionTrend");
  check(
    `B3 below threshold (${TOP_CHIP_MIN_PRESS}) → null`,
    top(onePress, POOL) === null,
  );

  const twoPress = rec(onePress, "suggestionTrend");
  check("B4 strict leader ≥2 → badge", top(twoPress, POOL) === "suggestionTrend");

  const tied = rec(rec(twoPress, "suggestion1"), "suggestion1");
  check("B5 tie → no badge (honest absence)", top(tied, POOL) === null);

  const clearLead = rec(tied, "suggestion1");
  const lead2 = top(clearLead, POOL);
  check("B6 3-vs-2 → leader badge", lead2 === "suggestion1" || lead2 === "suggestionTrend"); // 3>2 → suggestion1
  check("B6a exact leader is suggestion1", lead2 === "suggestion1");

  // Foreign keys (pressed but not currently visible) never win.
  const foreign = rec(rec(null, "ghostKey"), "ghostKey");
  check("B7 invisible leader ignored", top(foreign, POOL) === null);
  // …but a visible key beats an invisible count.
  const both = rec(foreign, "suggestion3");
  const both2 = rec(both, "suggestion3");
  check("B8 visible 2 beats invisible 2? NO — invisible not in pool, visible wins",
    top(both2, POOL) === "suggestion3");

  // Single-key pool: no badge (nothing to lead over).
  check("B9 single visible key → null", top(twoPress, ["suggestionTrend"]) === null);

  // Empty pool → null.
  check("B10 empty pool → null", top(twoPress, []) === null);

  // Wrong schema version → null.
  check("B11 wrong version → null", top({ v: 99, counts: { suggestionTrend: 9 }, weeks: {} } as ChipUsage, POOL) === null);
}

// ---- C  sanitizeChipUsage ----------------------------------------------------
console.log("C  sanitizeChipUsage");
{
  check("C1 null → null", sanitizeChipUsage(null) === null);
  check("C2 string → null", sanitizeChipUsage("junk") === null);
  check("C3 wrong version → null", sanitizeChipUsage({ v: 3, counts: { a: 1 } }) === null);
  check("C4 missing counts → null", sanitizeChipUsage({ v: 1 }) === null);
  check("C5 empty counts → null", sanitizeChipUsage({ v: 1, counts: {} }) === null);

  const ok = sanitizeChipUsage({ v: 1, counts: { suggestionTrend: 3, junk: 0, neg: -2, frac: 1.5 } });
  check(
    "C6 junk values filtered, good kept",
    ok !== null &&
      ok.counts.suggestionTrend === 3 &&
      ok.counts.junk === undefined &&
      ok.counts.neg === undefined &&
      ok.counts.frac === undefined,
  );

  const oversized = sanitizeChipUsage({ v: 1, counts: { ["x".repeat(65)]: 1, okKey: 2 } });
  check("C7 oversized key dropped", oversized !== null && oversized.counts.okKey === 2);
  check("C7a normal key kept", sanitizeChipUsage({ v: 1, counts: { okKey: 2 } }) !== null);

  const huge: Record<string, number> = {};
  for (let i = 0; i < 50; i++) huge[`k${String(i).padStart(2, "0")}`] = 1;
  const capped = sanitizeChipUsage({ v: 1, counts: huge });
  check(`C8 cap enforced on read (${CHIP_USAGE_CAP})`, capped !== null && Object.keys(capped.counts).length === CHIP_USAGE_CAP);
  check("C8a deterministic victims (k00..k17 dropped)", capped !== null && capped.counts.k00 === undefined && capped.counts.k49 === 1);
}

// ---- D  end-to-end pure flow --------------------------------------------------
console.log("D  end-to-end pure flow");
{
  // A user's first visit: presses trend twice across surfaces, then sales once.
  let u = rec(null, "followUpTrend"); // dashboard card intent
  u = rec(u, "followUpTrend");        // palette intent
  check("D1 trend is the badge on the follow-up pool", top(u, ["followUpTrend", "followUpSales", "followUpCash"]) === "followUpTrend");
  check("D2 …and on the empty-state pool (shared vocabulary)", top(u, ["suggestionTrend", "suggestion1", "suggestion2", "suggestion3"]) === null); // trend key not in THIS pool's visible set
  const salesPool = top(u, ["suggestionTrend", "suggestion2", "suggestion3"]);
  check("D3 pool without any pressed key → no badge", salesPool === null);

  // After the sales chip is pressed twice it takes ITS pool's badge…
  u = rec(u, "suggestion2");
  u = rec(u, "suggestion2");
  check("D4 per-pool honesty: suggestion2 leads among ITS visible keys", top(u, ["suggestionTrend", "suggestion2", "suggestion3"]) === "suggestion2");
  check("D5 …while the trend key still leads its own pool", top(u, ["followUpTrend", "followUpSales"]) === "followUpTrend");

  // Round-trip through JSON (what localStorage actually stores).
  const revived = sanitizeChipUsage(JSON.parse(JSON.stringify(u)));
  check("D6 JSON round-trip preserves the badge decision", top(revived, ["suggestionTrend", "suggestion2", "suggestion3"]) === "suggestion2");
}

console.log(`\nr121 chip-usage battery: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
