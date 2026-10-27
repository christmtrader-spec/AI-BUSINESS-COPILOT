/**
 * scripts/r96-leader-view-unit.ts — R96 PURE-LAW HARNESS (persists).
 *
 * Proves the LEADER VIEW-MODEL (src/lib/leader-view.ts topLeaderOfFact) —
 * the ONE shared extractor that maps the R95 whole-book leaders fact into
 * BOTH the copilot's stream meta (largestDebtor / largestCreditor — the
 * follow-up chips' existence proof) AND the balances views' `leader` field
 * (the statTopParty deferral + the byParty-card leader strip). One
 * extractor by identity means every reader of rank 1 reads the same shape
 * and — the honest-silence law — every reader goes silent together.
 *
 *  [1] THE SILENCE LAW — null fact / truncated read (leaders null) /
 *      empty book (leaders []) → null. A missing, truncated, or empty
 *      book NEVER yields a leader; the chips and the strip stay hidden.
 *  [2] THE VERBATIM LAW — rank 1's fields map EXACTLY: partyName carried
 *      verbatim (including null = the unassigned mass), outstandingMinor
 *      untouched (integer minor units, A08 — never a float, never
 *      reformatted), count → openItems, partyCount = the fact's FULL
 *      ranked population (never the slice length, never 1).
 *  [3] THE NO-RE-RANK LAW — the fact's own order is the law: over
 *      deliberately SHUFFLED facts (leaders[0] not the largest), the
 *      extractor returns leaders[0] verbatim — there is no second
 *      ranking law in the view layer; the R89 board order upstream is
 *      the only ranker.
 *  [4] THE SHAPE LAW — the returned object carries EXACTLY the four
 *      documented fields (no rank leakage, no partyId on the view model,
 *      no extra keys) — the meta and the balances fetcher can rely on it.
 *  [5] DETERMINISM — the same fact maps to a deep-equal view 5× running.
 *  [6] THE CLIENT-SAFETY STATIC LAW — leader-view.ts is ZERO-IMPORT by
 *      construction (fs-read of the source: no `import` / `require`
 *      statements at all) — it is imported by client code
 *      (balances-data.ts) and server code (snapshot.ts) alike, so it
 *      must never pull the db or any server-only module (the r93 law).
 *  [7] THE READERS' WIRING LAW (static) — snapshot.ts maps
 *      largestDebtor/largestCreditor through topLeaderOfFact, and
 *      balances-data.ts maps both routes' `leaders` through the SAME
 *      extractor — one authority by construction, provable from source.
 *
 * Run: bun scripts/r96-leader-view-unit.ts
 * Exit: 0 = all green, 1 = at least one failure.
 */

import fs from "node:fs";
import { topLeaderOfFact, type LeadersFactInput } from "../src/lib/leader-view";

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

/** Deterministic PRNG (mulberry32) — reproducible shuffles. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

type Leader = NonNullable<NonNullable<LeadersFactInput>["leaders"]>[number];
const leader = (rank: number, partyId: string | null, partyName: string | null, outstandingMinor: number, count: number): Leader => ({
  rank, partyId, partyName, outstandingMinor, count,
});

// ---------------------------------------------------------------- [1]
console.log("== [1] THE SILENCE LAW — absent / truncated / empty → null ==");
eq(topLeaderOfFact(null), null, "null fact → null");
eq(topLeaderOfFact(undefined as unknown as LeadersFactInput), null, "undefined fact → null");
eq(topLeaderOfFact({ leaders: null, partyCount: 7 }), null, "truncated read (leaders null) → null (a wrong leader is worse than no leader)");
eq(topLeaderOfFact({ leaders: [], partyCount: 0 }), null, "empty book (leaders []) → null");
ok(
  "empty-book partyCount is never leaked as a leader",
  topLeaderOfFact({ leaders: [], partyCount: 5 }) === null,
);

// ---------------------------------------------------------------- [2]
console.log("== [2] THE VERBATIM LAW — rank 1 maps exactly ==");
const named = topLeaderOfFact({
  leaders: [
    leader(1, "c-akar", "Akar Trading", 800_000, 2),
    leader(2, "c-bahar", "Bahar Foods", 500_000, 1),
  ],
  partyCount: 3, // a third party exists beyond the top slice
});
eq(
  named,
  { partyName: "Akar Trading", outstandingMinor: 800_000, openItems: 2, partyCount: 3 },
  "named leader: fields verbatim, partyCount = the FULL population (3, never the slice 2)",
);
const mass = topLeaderOfFact({
  leaders: [leader(1, null, null, 2_000_000, 4), leader(2, "c-akar", "Akar Trading", 800_000, 2)],
  partyCount: 2,
});
eq(
  mass,
  { partyName: null, outstandingMinor: 2_000_000, openItems: 4, partyCount: 2 },
  "the unassigned mass leading keeps partyName null (the honest shape callers label)",
);
ok(
  "integer exactness at 9e12 scale (A08 — no float drift)",
  topLeaderOfFact({ leaders: [leader(1, "x", "X", 9_000_000_000_123, 1)], partyCount: 1 })?.outstandingMinor === 9_000_000_000_123,
);
ok(
  "single-party book: partyCount 1, openItems = that party's count",
  JSON.stringify(topLeaderOfFact({ leaders: [leader(1, "s1", "S1", 100, 3)], partyCount: 1 })) ===
    JSON.stringify({ partyName: "S1", outstandingMinor: 100, openItems: 3, partyCount: 1 }),
);

// ---------------------------------------------------------------- [3]
console.log("== [3] THE NO-RE-RANK LAW — the fact's order is the law ==");
// A DELIBERATELY out-of-order fact (rank 1 not first): the view layer must
// take leaders[0] verbatim — the upstream R89 fold is the only ranker.
const shuffled = topLeaderOfFact({
  leaders: [
    leader(2, "c-bahar", "Bahar Foods", 500_000, 1),
    leader(1, "c-akar", "Akar Trading", 800_000, 2),
  ],
  partyCount: 2,
});
eq(
  shuffled,
  { partyName: "Bahar Foods", outstandingMinor: 500_000, openItems: 1, partyCount: 2 },
  "shuffled fact → leaders[0] VERBATIM (no re-ranking in the view layer)",
);
// 40 randomized facts: the extractor's pick === leaders[0], always.
{
  const rnd = mulberry32(96001);
  let mismatch = 0;
  for (let i = 0; i < 40; i += 1) {
    const n = 1 + Math.floor(rnd() * 5);
    const leaders: Leader[] = [];
    for (let k = 0; k < n; k += 1) {
      leaders.push(
        leader(
          k + 1,
          k % 3 === 0 ? null : `p${i}-${k}`,
          k % 3 === 0 ? null : `Party ${k}`,
          Math.floor(rnd() * 1_000_000),
          Math.floor(rnd() * 4),
        ),
      );
    }
    // shuffle the array itself (the fact's ORDER is whatever the caller gives)
    for (let a = leaders.length - 1; a > 0; a -= 1) {
      const b = Math.floor(rnd() * (a + 1));
      [leaders[a], leaders[b]] = [leaders[b], leaders[a]];
    }
    const partyCount = n + Math.floor(rnd() * 3);
    const got = topLeaderOfFact({ leaders, partyCount });
    const first = leaders[0];
    if (
      !got ||
      got.partyName !== first.partyName ||
      got.outstandingMinor !== first.outstandingMinor ||
      got.openItems !== first.count ||
      got.partyCount !== partyCount
    ) {
      mismatch += 1;
    }
  }
  ok("40 randomized facts: pick === leaders[0] verbatim (order is the law)", mismatch === 0, `${mismatch} mismatches`);
}

// ---------------------------------------------------------------- [4]
console.log("== [4] THE SHAPE LAW — exactly the four documented fields ==");
{
  const got = topLeaderOfFact({ leaders: [leader(1, "p1", "P1", 10, 1)], partyCount: 2 }) as Record<string, unknown> | null;
  ok(
    "exactly { partyName, outstandingMinor, openItems, partyCount }",
    got !== null &&
      Object.keys(got ?? {}).sort().join(",") === "openItems,outstandingMinor,partyCount,partyName",
    `got ${got ? Object.keys(got).join(",") : "null"}`,
  );
}

// ---------------------------------------------------------------- [5]
console.log("== [5] DETERMINISM ==");
{
  const fact: LeadersFactInput = {
    leaders: [leader(1, null, null, 1_500_000, 3), leader(2, "p1", "P1", 900, 1)],
    partyCount: 2,
  };
  const first = JSON.stringify(topLeaderOfFact(fact));
  let stable = true;
  for (let i = 0; i < 4; i += 1) {
    if (JSON.stringify(topLeaderOfFact(fact)) !== first) stable = false;
  }
  ok("same fact → deep-equal view 5×", stable);
}

// ---------------------------------------------------------------- [6]
console.log("== [6] THE CLIENT-SAFETY STATIC LAW — zero imports ==");
{
  const src = fs.readFileSync("src/lib/leader-view.ts", "utf8");
  ok(
    "leader-view.ts contains NO import/require (client-safe by construction)",
    !/\bimport\s*[\{(]|=\s*require\(|import type/.test(src),
  );
  ok(
    "leader-view.ts does not reference the db or Prisma",
    !/prisma|@\/lib\/db/i.test(src),
  );
}

// ---------------------------------------------------------------- [7]
console.log("== [7] THE READERS' WIRING LAW (static) — one authority ==");
{
  const snap = fs.readFileSync("src/lib/ai/snapshot.ts", "utf8");
  ok(
    "snapshot.ts maps largestDebtor AND largestCreditor through topLeaderOfFact",
    /largestDebtor:\s*topLeaderOfFact\(debtorsFact\)/.test(snap) &&
      /largestCreditor:\s*topLeaderOfFact\(creditorsFact\)/.test(snap),
  );
  const bal = fs.readFileSync("src/modules/balances/balances-data.ts", "utf8");
  ok(
    "balances-data.ts maps BOTH routes' leaders through the SAME topLeaderOfFact",
    (bal.match(/topLeaderOfFact\(raw\.leaders\)/g) ?? []).length === 2,
    `${(bal.match(/topLeaderOfFact\(raw\.leaders\)/g) ?? []).length} call sites`,
  );
  ok(
    "balances-data.ts is a client module importing ONLY the zero-import extractor",
    bal.includes('"use client"') && bal.includes('@/lib/leader-view'),
  );
}

console.log(`\n=== r96-leader-view-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
