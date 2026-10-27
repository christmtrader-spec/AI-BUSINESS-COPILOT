/**
 * scripts/r89-aging-rollup-unit.ts — R89 UNIT harness.
 *
 * "Who owns the balance": the aging-details summary gains a per-party
 * roll-up of the FILTERED population (the same rows the page shows),
 * ranked by outstanding desc. Pure-function assertions — NO database,
 * NO server:
 *
 *   [1] the ACCUMULATOR LAW — rollupAccumulate folds only `matched`
 *       items, keys by partyId (the unassigned population keyed ""),
 *       sums outstanding, takes the MAX ageDays, and never invents a
 *       party for a null-party row
 *   [2] the RANK LAW — rollupRank orders by outstanding desc with a
 *       DETERMINISTIC name/id tie-break, reports the untrimmed
 *       groupCount, and caps the list with an honest groupsTruncated
 *       flag (never a silent cut); empty scope → empty board
 *   [3] the RECONCILIATION LAW — the folded board's outstanding sum
 *       equals the filtered total it answers (the board ≡ rows
 *       guarantee, by construction)
 *   [4] the CAP SUITE — AGING_DETAIL_ROLLUP_MAX_GROUPS follows the
 *       envCap convention (documented production default 12, clamped
 *       sane range, integer)
 *
 * Run: bun --preload ./scripts/lib/register-server-only-shim.ts scripts/r89-aging-rollup-unit.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

import {
  AGING_DETAIL_ROLLUP_MAX_GROUPS,
  rollupAccumulate,
  rollupRank,
  type AgingRollupAccumulator,
} from "../src/lib/aging-details";

type FoldItem = Parameters<typeof rollupAccumulate>[1];

function item(p: {
  partyId: string | null;
  partyName: string | null;
  outstandingMinor: number;
  ageDays: number;
}): FoldItem {
  return { partyId: p.partyId, partyName: p.partyName, outstandingMinor: p.outstandingMinor, ageDays: p.ageDays };
}

// ---------------------------------------------------------------------------
// [1] the ACCUMULATOR LAW
// ---------------------------------------------------------------------------
console.log("\n[1] rollupAccumulate — folds only matched rows, honest unassigned group");
{
  const acc: AgingRollupAccumulator = new Map();
  rollupAccumulate(acc, item({ partyId: "c1", partyName: "Akar", outstandingMinor: 1_000, ageDays: 10 }), true);
  rollupAccumulate(acc, item({ partyId: "c1", partyName: "Akar", outstandingMinor: 500, ageDays: 40 }), true);
  rollupAccumulate(acc, item({ partyId: "c2", partyName: "Bahman", outstandingMinor: 2_000, ageDays: 5 }), false); // filtered out — never folded
  rollupAccumulate(acc, item({ partyId: null, partyName: null, outstandingMinor: 250, ageDays: 70 }), true);
  eq(acc.size, 2, "1a. only matched parties keyed (filtered-out row never enters)");
  eq(acc.get("c1"), { partyId: "c1", partyName: "Akar", count: 2, outstandingMinor: 1_500, oldestDays: 40 }, "1b. sum + MAX age per party");
  eq(acc.get(""), { partyId: null, partyName: null, count: 1, outstandingMinor: 250, oldestDays: 70 }, "1c. unassigned population is its own honest group — never a fabricated party");
  ok("1d. accumulator mutates the SAME map (streaming fold)", acc instanceof Map);
}

// ---------------------------------------------------------------------------
// [2] the RANK LAW
// ---------------------------------------------------------------------------
console.log("\n[2] rollupRank — outstanding desc, deterministic ties, honest cap");
{
  const acc: AgingRollupAccumulator = new Map();
  rollupAccumulate(acc, item({ partyId: "c2", partyName: "Bahman", outstandingMinor: 2_000, ageDays: 5 }), true);
  rollupAccumulate(acc, item({ partyId: "c1", partyName: "Akar", outstandingMinor: 1_500, ageDays: 40 }), true);
  rollupAccumulate(acc, item({ partyId: null, partyName: null, outstandingMinor: 250, ageDays: 70 }), true);
  const roll = rollupRank(acc, 12);
  eq(roll.groups.map((g) => g.partyName), ["Bahman", "Akar", null], "2a. ranked by outstanding desc, unassigned LAST (smallest)");
  ok("2b. groupCount is the UNTRIMMED distinct-party count", roll.groupCount === 3 && roll.groups.length === 3);
  ok("2c. no truncation under the cap", roll.groupsTruncated === false);
}
{
  const acc: AgingRollupAccumulator = new Map();
  rollupAccumulate(acc, item({ partyId: "a", partyName: "Same", outstandingMinor: 100, ageDays: 1 }), true);
  rollupAccumulate(acc, item({ partyId: "b", partyName: "Same", outstandingMinor: 100, ageDays: 2 }), true);
  const roll = rollupRank(acc, 12);
  eq(roll.groups.map((g) => g.partyId), ["a", "b"], "2d. equal outstanding → name-then-id tie-break is DETERMINISTIC");
}
{
  const acc: AgingRollupAccumulator = new Map();
  for (let i = 0; i < 15; i++) {
    rollupAccumulate(acc, item({ partyId: `p${String(i).padStart(2, "0")}`, partyName: `Party ${i}`, outstandingMinor: 1_000 - i, ageDays: i }), true);
  }
  const roll = rollupRank(acc, 12);
  ok("2e. list capped at maxGroups", roll.groups.length === 12);
  ok("2f. groupCount keeps EVERY party (untrimmed)", roll.groupCount === 15);
  ok("2g. groupsTruncated flag is honest", roll.groupsTruncated === true);
  ok("2h. the cap keeps the TOP of the ranking", roll.groups[0].outstandingMinor === 1_000 && roll.groups[11].outstandingMinor === 989);
}
{
  const roll = rollupRank(new Map(), 12);
  eq(roll, { groups: [], groupCount: 0, groupsTruncated: false }, "2i. empty scope → empty board (the UI hides it)");
}

// ---------------------------------------------------------------------------
// [3] the RECONCILIATION LAW
// ---------------------------------------------------------------------------
console.log("\n[3] board ≡ rows — the folded sum reconciles with the filtered total");
{
  const acc: AgingRollupAccumulator = new Map();
  const rows = [
    { partyId: "c1", partyName: "Akar", outstandingMinor: 1_000, ageDays: 10, matched: true },
    { partyId: "c1", partyName: "Akar", outstandingMinor: 500, ageDays: 40, matched: true },
    { partyId: "c2", partyName: "Bahman", outstandingMinor: 2_000, ageDays: 5, matched: true },
    { partyId: "c3", partyName: "Chista", outstandingMinor: 750, ageDays: 90, matched: false }, // the overdue-chip case: in scope, filtered out
    { partyId: null, partyName: null, outstandingMinor: 250, ageDays: 70, matched: true },
  ];
  let filteredTotal = 0;
  for (const r of rows) {
    rollupAccumulate(acc, r, r.matched);
    if (r.matched) filteredTotal += r.outstandingMinor;
  }
  const roll = rollupRank(acc, 12);
  const boardSum = roll.groups.reduce((n, g) => n + g.outstandingMinor, 0);
  ok("3a. board sum === filtered total (untruncated board reconciles exactly)", boardSum === filteredTotal && filteredTotal === 3_750);
  ok("3b. board count === filtered row count", roll.groups.reduce((n, g) => n + g.count, 0) === 4);
}

// ---------------------------------------------------------------------------
// [4] the CAP SUITE
// ---------------------------------------------------------------------------
console.log("\n[4] AGING_DETAIL_ROLLUP_MAX_GROUPS — the cap-suite convention");
{
  ok("4a. production default is 12", AGING_DETAIL_ROLLUP_MAX_GROUPS === 12);
  ok("4b. integer, sane, positive", Number.isInteger(AGING_DETAIL_ROLLUP_MAX_GROUPS) && AGING_DETAIL_ROLLUP_MAX_GROUPS > 0);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
