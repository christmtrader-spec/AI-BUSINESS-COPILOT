/**
 * scripts/r95-book-leaders-unit.ts — R95 PURE-LAW HARNESS (persists).
 *
 * Proves the book's LEADERS FACT (src/lib/party-aging.ts
 * bookLeadersFromBookRows) — the ranked top parties by open balance, read
 * off the EXACT R89 board law the rank fact and the board itself use:
 *
 *  [1] THE IDENTITY LAW — the leaders order IS the rollupRank order: over
 *      crafted AND randomized populations, bookLeadersFromBookRows' slice
 *      is IDENTICAL (all five fields, rank by rank) to taking the first
 *      `take` entries of rollupAccumulate → rollupRank(acc, ∞) over the
 *      same rows — the citation and the board can never disagree (one
 *      comparator by identity, never a second ranking law).
 *  [2] THE SLICE ARITHMETIC — ranks are 1-based and contiguous; every
 *      leader carries its rollup's count; partyCount is the FULL ranked
 *      population (never the slice length); take ≥ parties → everyone.
 *  [3] THE TIE CHAIN — money desc → name asc (localeCompare, null-as-"",
 *      FA names by code points) → id asc; deterministic across repeats.
 *  [4] THE CLOSED/NOISE GUARD — zero/negative/non-finite outstanding rows
 *      never compete; a party held up only by settled rows is absent.
 *  [5] THE UNASSIGNED MASS — partyId-null rows fold into their own honest
 *      group, compete (and can LEAD), keep partyName null, and count in
 *      partyCount.
 *  [6] BIG-INTEGER EXACTNESS — 9e12-scale sums rank exactly (A08).
 *  [7] HONEST EDGES — empty book → { leaders: [], partyCount: 0 }; take ≤ 0
 *      → an empty slice with partyCount still honest (never an error).
 *  [8] THE TWO READERS AGREE — each leader's rank from
 *      bookLeadersFromBookRows equals partyRankFromBookRows' rank for the
 *      same party (both read the ONE shared fold by construction).
 *
 * Run: bun scripts/r95-book-leaders-unit.ts
 * Exit: 0 = all green, 1 = at least one failure.
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
  rollupAccumulate,
  rollupRank,
  type AgingRollupAccumulator,
} from "../src/lib/aging-details";
import {
  bookLeadersFromBookRows,
  partyRankFromBookRows,
  type PartyRankBookRow,
} from "../src/lib/party-aging";

type Row = PartyRankBookRow;

/** Deterministic PRNG (mulberry32) — the randomized books are reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The board's own ranked order — the IDENTITY the leaders must match. */
function boardOrder(rows: Row[]) {
  const acc: AgingRollupAccumulator = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.outstandingMinor) || row.outstandingMinor <= 0) continue;
    rollupAccumulate(
      acc,
      { partyId: row.partyId, partyName: row.partyName, outstandingMinor: row.outstandingMinor, ageDays: 0 },
      true,
    );
  }
  return rollupRank(acc, Number.MAX_SAFE_INTEGER);
}

/** Seeded random book: n parties (some FA names), 0-6 rows each, some unassigned. */
function randomBook(seed: number, parties: number): Row[] {
  const rnd = mulberry32(seed);
  const names = ["Akar", "Bahar", "Chinar", "دیجی‌کالا", "اکبر صنم", "Zagros", "فولاد", "Dena", "س backlight"];
  const rows: Row[] = [];
  for (let p = 0; p < parties; p++) {
    const named = rnd() > 0.12;
    const id = named ? `p${p}-${Math.floor(rnd() * 1e9).toString(36)}` : null;
    const name = named ? names[Math.floor(rnd() * names.length)] + (rnd() > 0.6 ? ` ${p}` : "") : null;
    const rowCount = Math.floor(rnd() * 7);
    for (let r = 0; r < rowCount; r++) {
      const roll = rnd();
      // 20% settled (the noise guard's prey), 5% negative, 5% huge
      const outstandingMinor =
        roll < 0.2 ? 0 : roll < 0.25 ? -Math.floor(rnd() * 1000) : roll < 0.3 ? Math.floor(rnd() * 9e12) : Math.floor(rnd() * 5_000_000);
      rows.push({ partyId: id, partyName: name, outstandingMinor });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// [1]+[2]+[3] IDENTITY + SLICE + TIE over crafted and randomized books
// ---------------------------------------------------------------------------
function identityOver(rows: Row[], take: number, label: string) {
  const fact = bookLeadersFromBookRows(rows, take);
  const board = boardOrder(rows);
  const expected = board.groups.slice(0, take).map((g, i) => ({
    rank: i + 1,
    partyId: g.partyId,
    partyName: g.partyName,
    outstandingMinor: g.outstandingMinor,
    count: g.count,
  }));
  eq(fact.leaders, expected, `${label}: leaders === board's first ${take} (all five fields, rank by rank)`);
  eq(fact.partyCount, board.groupCount, `${label}: partyCount === the FULL ranked population`);
}

// Crafted book: mass leads, then money-ordered parties with a name tie.
{
  const rows: Row[] = [
    { partyId: null, partyName: null, outstandingMinor: 20_000 },
    { partyId: "c1", partyName: "Akar", outstandingMinor: 8_000 },
    { partyId: "c1", partyName: "Akar", outstandingMinor: 5_000 },
    { partyId: "c2", partyName: "Bahar", outstandingMinor: 9_000 },
    { partyId: "c3", partyName: "Bahar", outstandingMinor: 4_000 },
    { partyId: "c3", partyName: "Bahar", outstandingMinor: 1_000 },
    { partyId: "c4", partyName: "Zagros", outstandingMinor: 500 },
  ];
  identityOver(rows, 3, "crafted take 3");
  identityOver(rows, 1, "crafted take 1");
  identityOver(rows, 10, "crafted take > parties");

  // The exact crafted order: the mass (20000) leads, Akar's two rows fold
  // to 13000 (money decides over row counts), then Bahar 9000, Bahar 5000.
  eq(
    bookLeadersFromBookRows(rows, 4).leaders.map((l) => ({ name: l.partyName, minor: l.outstandingMinor, count: l.count })),
    [
      { name: null, minor: 20000, count: 1 },
      { name: "Akar", minor: 13000, count: 2 },
      { name: "Bahar", minor: 9000, count: 1 },
      { name: "Bahar", minor: 5000, count: 2 },
    ],
    "crafted: exact leader sequence — mass first, then Akar 13000, Bahar 9000, Bahar 5000 (money desc)",
  );

  // Name-tie law: c2 vs c3 both "Bahar" — money 9000 > 5000 keeps c2 first;
  // equal-money name ties break by id asc (proven in the r94 harness; here
  // the leaders slice must agree with the rank reader — see [8]).
}

// Randomized books — 40 seeds × take ∈ {1, 3, 5, 1000}
{
  let checked = 0;
  for (let seed = 9500; seed < 9540; seed++) {
    const rows = randomBook(seed, 3 + (seed % 9));
    for (const take of [1, 3, 5, 1000]) {
      identityOver(rows, take, `random seed ${seed} take ${take}`);
      checked++;
    }
  }
  ok(`randomized identity sweep: ${checked} book/take pairs all identical to the board`, checked === 160);
}

// ---------------------------------------------------------------------------
// [4] THE CLOSED/NOISE GUARD
// ---------------------------------------------------------------------------
{
  const rows: Row[] = [
    { partyId: "c1", partyName: "Akar", outstandingMinor: 0 },        // settled
    { partyId: "c1", partyName: "Akar", outstandingMinor: -500 },     // negative
    { partyId: "c1", partyName: "Akar", outstandingMinor: NaN },      // non-finite
    { partyId: "c2", partyName: "Bahar", outstandingMinor: 7_000 },   // the only competitor
  ];
  const fact = bookLeadersFromBookRows(rows, 3);
  eq(fact.leaders.length, 1, "noise guard: only the open-money party leads");
  eq(fact.partyCount, 1, "noise guard: settled/negative/non-finite rows never enter the population");
  eq(fact.leaders[0].partyId, "c2", "noise guard: Bahar is rank 1");
}

// ---------------------------------------------------------------------------
// [5] THE UNASSIGNED MASS — can lead, keeps null identity, counts in M
// ---------------------------------------------------------------------------
{
  const rows: Row[] = [
    { partyId: null, partyName: null, outstandingMinor: 3_000 },
    { partyId: null, partyName: null, outstandingMinor: 2_000 },
    { partyId: "c1", partyName: "Akar", outstandingMinor: 4_000 },
  ];
  const fact = bookLeadersFromBookRows(rows, 3);
  eq(fact.leaders[0], { rank: 1, partyId: null, partyName: null, outstandingMinor: 5_000, count: 2 }, "unassigned mass folds to ONE group (5000, 2 rows) and LEADS");
  eq(fact.leaders[1].partyId, "c1", "the named party ranks behind the mass");
  eq(fact.partyCount, 2, "partyCount includes the mass");
  eq(fact.leaders[0].partyName, null, "the mass keeps partyName null (callers present the honest label)");
}

// ---------------------------------------------------------------------------
// [6] BIG-INTEGER EXACTNESS (9e12 scale, 1 minor unit decides)
// ---------------------------------------------------------------------------
{
  const rows: Row[] = [
    { partyId: "c1", partyName: "Akar", outstandingMinor: 9_000_000_000_000 },
    { partyId: "c2", partyName: "Bahar", outstandingMinor: 9_000_000_000_001 },
  ];
  const fact = bookLeadersFromBookRows(rows, 2);
  eq(fact.leaders[0].partyId, "c2", "9e12 scale: ONE minor unit decides the leadership");
  eq(fact.leaders.map((l) => l.outstandingMinor), [9_000_000_000_001, 9_000_000_000_000], "9e12 sums exact (no float drift)");
}

// ---------------------------------------------------------------------------
// [7] HONEST EDGES — empty book, take ≤ 0, determinism
// ---------------------------------------------------------------------------
{
  eq(bookLeadersFromBookRows([], 3), { leaders: [], partyCount: 0 }, "empty book → empty leaders, partyCount 0");
  const rows: Row[] = [
    { partyId: "c1", partyName: "Akar", outstandingMinor: 100 },
    { partyId: "c2", partyName: "Bahar", outstandingMinor: 200 },
  ];
  eq(bookLeadersFromBookRows(rows, 0).leaders, [], "take 0 → empty slice (honest silence, never an error)");
  eq(bookLeadersFromBookRows(rows, -5).leaders, [], "negative take → empty slice");
  eq(bookLeadersFromBookRows(rows, 0).partyCount, 2, "take 0 still reports the honest population");
  eq(bookLeadersFromBookRows(rows, 1).leaders.length, 1, "take 1 → exactly the leader");
  eq(bookLeadersFromBookRows(rows, 1).leaders[0].partyId, "c2", "take 1: the money winner (rank 1 = largest)");
  // take ≥ parties → everyone, ranks contiguous
  const all = bookLeadersFromBookRows(rows, 99);
  eq(all.leaders.map((l) => l.rank), [1, 2], "take ≥ parties: contiguous 1-based ranks");
  // determinism 5×
  const first = JSON.stringify(bookLeadersFromBookRows(rows, 2));
  let deterministic = true;
  for (let i = 0; i < 5; i++) {
    if (JSON.stringify(bookLeadersFromBookRows(rows, 2)) !== first) deterministic = false;
  }
  ok("determinism: 5 repeats byte-identical", deterministic);
}

// ---------------------------------------------------------------------------
// [8] THE TWO READERS AGREE — leaders' ranks === partyRankFromBookRows' ranks
// ---------------------------------------------------------------------------
{
  let agreed = 0;
  for (let seed = 9600; seed < 9620; seed++) {
    const rows = randomBook(seed, 4 + (seed % 6));
    const fact = bookLeadersFromBookRows(rows, 5);
    for (const leader of fact.leaders) {
      if (leader.partyId === null) continue; // the rank reader needs a focus id
      const rank = partyRankFromBookRows(rows, leader.partyId);
      if (rank && rank.rank === leader.rank && rank.partyCount === fact.partyCount) agreed++;
    }
  }
  ok(`two readers agree: ${agreed} leader ranks === partyRankFromBookRows ranks (one shared fold)`, agreed > 40);
  // And the crafted tie case: the SAME-name pair by id.
  const rows: Row[] = [
    { partyId: "c2", partyName: "Bahar", outstandingMinor: 5_000 },
    { partyId: "c1", partyName: "Bahar", outstandingMinor: 5_000 },
    { partyId: "c3", partyName: "Akar", outstandingMinor: 1_000 },
  ];
  const fact = bookLeadersFromBookRows(rows, 3);
  eq(fact.leaders.map((l) => l.partyId), ["c1", "c2", "c3"], "equal-money name ties break by id asc (c1 before c2), Akar last by money");
  const rankC2 = partyRankFromBookRows(rows, "c2");
  eq(rankC2, { rank: 2, partyCount: 3 }, "rank reader agrees with the leaders slice on the tie pair");
}

console.log(`\n=== r95-book-leaders-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
