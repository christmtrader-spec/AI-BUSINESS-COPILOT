/**
 * scripts/r94-party-rank-unit.ts — R94 PURE-LAW HARNESS (persists).
 *
 * Proves the 360 RANK CITATION (src/lib/party-aging.ts partyRankFromBookRows)
 * — where a party stands among the book's parties by open balance, ranked by
 * the EXACT R89 board law:
 *
 *  [1] THE IDENTITY LAW — the rank order IS the rollupRank order: over
 *      crafted AND randomized populations, partyRankFromBookRows' implied
 *      order (ranking each party in turn) is IDENTICAL to
 *      rollupAccumulate → rollupRank(acc, ∞) over the same rows — the
 *      citation and the board can never disagree (one comparator by
 *      identity, never a second ranking law).
 *  [2] THE RANK ARITHMETIC — 1-based position; partyCount = the ranked
 *      population size; money decides, ties broken by the board's chain.
 *  [3] THE CLOSED/NOISE GUARD — zero/negative/non-finite outstanding rows
 *      never compete (the buildAgingSide population law); a party held up
 *      ONLY by settled rows is honestly absent (null).
 *  [4] THE UNASSIGNED MASS — partyId-null rows fold into their own honest
 *      group and DO compete (the board shows that money); a named party
 *      behind an anonymous mass ranks BEHIND it, and partyCount includes it.
 *  [5] HONEST SILENCE — empty book, absent focus, foreign id → null.
 *  [6] BIG-INTEGER EXACTNESS — 9e12-scale sums rank exactly (A08).
 *  [7] DETERMINISM — same rows, same winner, every run (5× repeat).
 *
 * Run: bun scripts/r94-party-rank-unit.ts
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
import { partyRankFromBookRows, type PartyRankBookRow } from "../src/lib/party-aging";

type Row = PartyRankBookRow;
const row = (partyId: string | null, partyName: string | null, outstandingMinor: number): Row => ({
  partyId,
  partyName,
  outstandingMinor,
});

/** The board's own full order over the same rows — the authority to match. */
function boardOrder(rows: Row[]): Array<{ partyId: string | null; outstandingMinor: number }> {
  const acc: AgingRollupAccumulator = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.outstandingMinor) || r.outstandingMinor <= 0) continue;
    rollupAccumulate(acc, { partyId: r.partyId, partyName: r.partyName, outstandingMinor: r.outstandingMinor, ageDays: 0 }, true);
  }
  return rollupRank(acc, Number.MAX_SAFE_INTEGER).groups.map((g) => ({
    partyId: g.partyId,
    outstandingMinor: g.outstandingMinor,
  }));
}

/** The rank fact for every NAMED party (the 360 never cites the unassigned
 *  mass — a focus id is always a real customer/supplier id), as the panel
 *  would read it. */
function impliedOrder(rows: Row[]): Array<{ partyId: string | null; rank: number }> {
  const parties = new Map<string, { partyId: string; partyName: string | null }>();
  for (const r of rows) {
    if (r.partyId === null) continue; // not citable — no id exists
    if (!parties.has(r.partyId)) parties.set(r.partyId, { partyId: r.partyId, partyName: r.partyName });
  }
  const out: Array<{ partyId: string | null; rank: number }> = [];
  for (const p of parties.values()) {
    const fact = partyRankFromBookRows(rows, p.partyId);
    const open = rows.some((r) => r.partyId === p.partyId && r.outstandingMinor > 0);
    if (open && fact) out.push({ partyId: p.partyId, rank: fact.rank });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// ---------------------------------------------------------------------------
// [1] THE IDENTITY LAW — the rank order IS the board's order
// ---------------------------------------------------------------------------
console.log("\n[1] the identity law — partyRankFromBookRows ranks EXACTLY as rollupRank");

{
  const rows: Row[] = [
    row("c1", "Akar", 500),
    row("c2", "Bahar", 2_000),
    row("c3", "Chinar", 500),
    row(null, null, 900),
    row("c2", "Bahar", 300), // same party, second row — folded into one group
  ];
  const board = boardOrder(rows).filter((g) => g.partyId !== null);
  const implied = impliedOrder(rows);
  eq(board.map((g) => g.partyId), implied.map((g) => g.partyId), "order identical (named parties): Bahar → Akar → Chinar; the unassigned mass takes rank 2");
  const bahar = partyRankFromBookRows(rows, "c2");
  eq(bahar, { rank: 1, partyCount: 4 }, "Bahar rank 1 of 4 (the unassigned group counts in M)");
}

{
  // Randomized populations — 40 books × 12 parties, the identity law every time.
  let seed = 94001;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let mismatches = 0;
  for (let i = 0; i < 40; i++) {
    const rows: Row[] = [];
    const parties = Math.max(2, Math.floor(rnd() * 12));
    for (let p = 0; p < parties; p++) {
      const id = `p${p}`;
      const name = rnd() > 0.7 ? null : `Party ${p}`;
      const nRows = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < nRows; k++) {
        const money = Math.floor(rnd() * 1_000_000);
        rows.push(row(rnd() > 0.85 ? null : id, rnd() > 0.85 ? null : name, money));
      }
    }
    const board = boardOrder(rows).map((g) => g.partyId ?? "").filter((id) => id !== "");
    const implied = impliedOrder(rows).map((g) => g.partyId ?? "");
    if (JSON.stringify(board) !== JSON.stringify(implied)) mismatches++;
  }
  eq(mismatches, 0, "40 randomized books: the implied order === the board order every time");
}

// ---------------------------------------------------------------------------
// [2] THE RANK ARITHMETIC — money decides, ties by the board's chain
// ---------------------------------------------------------------------------
console.log("\n[2] the rank arithmetic");

{
  const rows: Row[] = [
    row("a", "Akar", 100),
    row("b", "Bahar", 300),
    row("c", "Chinar", 200),
  ];
  eq(partyRankFromBookRows(rows, "a"), { rank: 3, partyCount: 3 }, "smallest → rank 3 of 3");
  eq(partyRankFromBookRows(rows, "b"), { rank: 1, partyCount: 3 }, "largest → rank 1 of 3");
  eq(partyRankFromBookRows(rows, "c"), { rank: 2, partyCount: 3 }, "middle → rank 2 of 3");
}

{
  // Tie on money → name asc (the board's chain: money desc → name → id).
  const rows: Row[] = [
    row("x", "Zahra", 500),
    row("y", "Akar", 500),
  ];
  eq(partyRankFromBookRows(rows, "y"), { rank: 1, partyCount: 2 }, "tie broken by name asc — Akar first");
  eq(partyRankFromBookRows(rows, "x"), { rank: 2, partyCount: 2 }, "Zahra second on the same money");
}

{
  // Tie on money AND name → id asc (two same-name parties never merge — §6).
  const rows: Row[] = [
    row("id-b", "Akar", 700),
    row("id-a", "Akar", 700),
  ];
  eq(partyRankFromBookRows(rows, "id-a"), { rank: 1, partyCount: 2 }, "name+money tie broken by id asc");
}

{
  // Money folds across rows of ONE party before ranking (Σ total − paid).
  const rows: Row[] = [
    row("a", "Akar", 100),
    row("a", "Akar", 100),
    row("b", "Bahar", 150),
  ];
  eq(partyRankFromBookRows(rows, "a"), { rank: 1, partyCount: 2 }, "Akar's 100+100 outranks Bahar's 150");
}

// ---------------------------------------------------------------------------
// [3] THE CLOSED/NOISE GUARD
// ---------------------------------------------------------------------------
console.log("\n[3] the closed/noise guard — settled money never competes");

{
  const rows: Row[] = [
    row("a", "Akar", 0), // fully settled open row — noise
    row("b", "Bahar", 250),
    row("c", "Chinar", -40), // negative noise (defensive)
    row("d", "Dadgar", Number.NaN), // non-finite noise (defensive)
  ];
  eq(partyRankFromBookRows(rows, "a"), null, "a party held up only by settled rows is absent — honest null");
  eq(partyRankFromBookRows(rows, "b"), { rank: 1, partyCount: 1 }, "Bahar ranks 1 of 1 — the noise never entered the population");
  eq(partyRankFromBookRows(rows, "c"), null, "negative balance absent");
  eq(partyRankFromBookRows(rows, "d"), null, "non-finite balance absent");
}

{
  // A party with a settled row AND an open row: only the open money counts.
  const rows: Row[] = [
    row("a", "Akar", 0),
    row("a", "Akar", 400),
    row("b", "Bahar", 300),
  ];
  eq(partyRankFromBookRows(rows, "a"), { rank: 1, partyCount: 2 }, "Akar's settled row ignored, open 400 ranks first");
}

// ---------------------------------------------------------------------------
// [4] THE UNASSIGNED MASS — anonymous balances compete, the board shows them
// ---------------------------------------------------------------------------
console.log("\n[4] the unassigned mass competes (the board's own order)");

{
  const rows: Row[] = [
    row("a", "Akar", 500),
    row(null, null, 900), // walk-in money — bigger than Akar
    row("b", "Bahar", 100),
  ];
  eq(partyRankFromBookRows(rows, "a"), { rank: 2, partyCount: 3 }, "Akar ranks BEHIND the anonymous mass — honest");
  eq(partyRankFromBookRows(rows, "b"), { rank: 3, partyCount: 3 }, "Bahar third of 3");
}

// ---------------------------------------------------------------------------
// [5] HONEST SILENCE
// ---------------------------------------------------------------------------
console.log("\n[5] honest silence — empty book / absent focus / foreign id");

eq(partyRankFromBookRows([], "a"), null, "empty book → null");
eq(partyRankFromBookRows([row("a", "Akar", 500)], "foreign-id"), null, "foreign id → null (no leak, no fabricated rank)");
eq(partyRankFromBookRows([row("a", "Akar", 500)], "b"), null, "absent id → null");

// ---------------------------------------------------------------------------
// [6] BIG-INTEGER EXACTNESS (A08)
// ---------------------------------------------------------------------------
console.log("\n[6] big-integer exactness");

{
  const rows: Row[] = [
    row("a", "Akar", 4_000_000_000_000),
    row("b", "Bahar", 4_000_000_000_000 + 1),
    row("c", "Chinar", 9_000_000_000_000),
  ];
  eq(partyRankFromBookRows(rows, "c"), { rank: 1, partyCount: 3 }, "9e12 outranks 4e12+1 — exact at the trillions");
  eq(partyRankFromBookRows(rows, "a"), { rank: 3, partyCount: 3 }, "1 minor unit decides rank 2 vs 3 — exact");
}

// ---------------------------------------------------------------------------
// [7] DETERMINISM
// ---------------------------------------------------------------------------
console.log("\n[7] determinism — same rows, same fact, every run");

{
  const rows: Row[] = [
    row("c1", "اکبر", 1_000),
    row("c2", "اکبر", 1_000),
    row("c3", "Bahar", 1_000),
    row(null, null, 2_000),
  ];
  const first = partyRankFromBookRows(rows, "c1");
  let stable = true;
  for (let i = 0; i < 5; i++) {
    if (JSON.stringify(partyRankFromBookRows(rows, "c1")) !== JSON.stringify(first)) stable = false;
  }
  ok("5× repeat: identical fact", stable);
  // The board's comparator is localeCompare: under the default ICU collation
  // Latin script sorts BEFORE Arabic script, so "Bahar" precedes the اکبر
  // pair at equal money — and the unassigned mass (2000) outranks all three.
  // The engine follows the board EXACTLY — that IS the law under test.
  eq(first, { rank: 3, partyCount: 4 }, "c1 second of the اکبر pair (Bahar first by collation, mass first by money)");
  eq(partyRankFromBookRows(rows, "c2"), { rank: 4, partyCount: 4 }, "c2 last of the pair (id asc on the name tie)");
}

// ---------------------------------------------------------------------------
console.log(`\n=== r94-party-rank-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
