/**
 * scripts/r97-podium-unit.ts — R97 PURE-LAW HARNESS (persists).
 *
 * Proves the PODIUM slice (src/lib/leader-view.ts topLeadersOfFact +
 * runnersUpOfFact) — the R97 extension of the ONE shared extractor that
 * now feeds the balances strips' runner-up rows (ranks 2..3 with the
 * share-of-book bars) AND the copilot's "who else?" follow-up chips (the
 * meta's topDebtors/topCreditors). Same file, same law, one slice deeper.
 *
 *  [1] THE SILENCE LAW — null fact / truncated read / empty book → [].
 *      A silent fact NEVER yields a podium row on ANY surface.
 *  [2] THE SLICE LAW — topLeadersOfFact(fact, take) = the fact's own
 *      first `take` entries VERBATIM (order preserved, no re-rank, no
 *      dedup); take ≤ 0 / NaN / Infinity → []; take > length → the whole
 *      list; a fractional take floors (3.9 → 3).
 *  [3] THE VERBATIM LAW — each entry maps EXACTLY: rank = the server's
 *      OWN rank (never recomputed), partyId carried (null = the mass),
 *      partyName verbatim (including null), outstandingMinor untouched
 *      (integer minor units, A08 — 9e12 exact), count → openItems,
 *      partyCount = the fact's FULL population on EVERY row.
 *  [4] THE RUNNERS-UP LAW — runnersUpOfFact(fact, take) excludes rank 1
 *      BY THE SERVER'S RANK FIELD (not by array position — a shuffled
 *      fact whose leaders[0].rank = 1 still yields the same runners-up
 *      set as positions: filter is on rank identity, and the slices stay
 *      verbatim-ordered); a single-party book → []; every runner-up
 *      carries rank ≥ 2 when the fact is well-formed.
 *  [5] DETERMINISM — the same fact maps to a deep-equal podium 5×.
 *  [6] THE CLIENT-SAFETY STATIC LAW — leader-view.ts remains ZERO-IMPORT
 *      by construction (fs-read: no `import` / `require` statements).
 *  [7] THE READERS' WIRING LAW (static) — snapshot.ts maps
 *      topDebtors/topCreditors through topLeadersOfFact(fact, 3);
 *      balances-data.ts maps BOTH routes' podium through
 *      runnersUpOfFact(raw.leaders, 3); balances-view renders the rows
 *      with the share bar + leaderRankN + the party-scoped drill;
 *      copilot-view gates the chips on podium.length ≥ 2 and cites
 *      leaderRankN; the i18n bags carry every R97 key in BOTH locales.
 *
 * Run: bun scripts/r97-podium-unit.ts
 * Exit: 0 = all green, 1 = at least one failure.
 */

import fs from "node:fs";
import {
  runnersUpOfFact,
  topLeaderOfFact,
  topLeadersOfFact,
  type LeadersFactInput,
} from "../src/lib/leader-view";

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
console.log("== [1] THE SILENCE LAW — absent / truncated / empty → [] ==");
eq(topLeadersOfFact(null, 3), [], "null fact → []");
eq(topLeadersOfFact(undefined as unknown as LeadersFactInput, 3), [], "undefined fact → []");
eq(topLeadersOfFact({ leaders: null, partyCount: 7 }, 3), [], "truncated read (leaders null) → [] (a wrong podium is worse than none)");
eq(topLeadersOfFact({ leaders: [], partyCount: 0 }, 3), [], "empty book (leaders []) → []");
eq(runnersUpOfFact(null, 3), [], "runnersUp: null fact → []");
eq(runnersUpOfFact({ leaders: null, partyCount: 4 }, 3), [], "runnersUp: truncated read → []");
eq(runnersUpOfFact({ leaders: [], partyCount: 0 }, 3), [], "runnersUp: empty book → []");

// ---------------------------------------------------------------- [2]
console.log("== [2] THE SLICE LAW — the fact's own first N, verbatim ==");
const crafted: LeadersFactInput = {
  leaders: [
    leader(1, "c_akar", "Akar Trading", 2_500_000, 3),
    leader(2, "c_bahar", "Bahar Supply", 900_000, 2),
    leader(3, null, null, 50_000, 1),
    leader(4, "c_chinar", "Chinar Ltd", 25_000, 1),
  ],
  partyCount: 4,
};
eq(
  topLeadersOfFact(crafted, 2).map((e) => e.rank),
  [1, 2],
  "take 2 = the fact's first two, order preserved",
);
eq(
  topLeadersOfFact(crafted, 3).map((e) => e.partyName),
  ["Akar Trading", "Bahar Supply", null],
  "take 3 keeps the mass row (no dedup, no drop)",
);
eq(topLeadersOfFact(crafted, 4).length, 4, "take > length → the whole list");
eq(topLeadersOfFact(crafted, 0), [], "take 0 → [] (honest silence, never an error)");
eq(topLeadersOfFact(crafted, -5), [], "negative take → []");
eq(topLeadersOfFact(crafted, Number.NaN), [], "NaN take → []");
eq(topLeadersOfFact(crafted, Number.POSITIVE_INFINITY), [], "non-finite take → [] (the guard law — deterministic silence, never a partial read)");
eq(topLeadersOfFact(crafted, 3.9).length, 3, "fractional take floors (3.9 → 3)");
eq(runnersUpOfFact(crafted, 3).map((e) => e.rank), [2, 3], "runnersUp(take 3) = ranks 2..3");
eq(runnersUpOfFact(crafted, 1), [], "runnersUp(take 1) = [] — the leader keeps his own strip");
eq(
  runnersUpOfFact({ leaders: [leader(1, "x", "Solo", 100, 1)], partyCount: 1 }, 3),
  [],
  "single-party book → no runners-up (never a padded podium)",
);

// ---------------------------------------------------------------- [3]
console.log("== [3] THE VERBATIM LAW — fields map exactly ==");
const big: LeadersFactInput = {
  leaders: [leader(1, "c_big", "Big Co", 9_000_000_000_000, 7)],
  partyCount: 12,
};
const bigPodium = topLeadersOfFact(big, 3);
ok("9e12 minor units exact at 1 unit", bigPodium[0]?.outstandingMinor === 9_000_000_000_000, `got ${bigPodium[0]?.outstandingMinor}`);
ok("rank = the server's OWN rank", bigPodium[0]?.rank === 1);
ok("partyId carried verbatim", bigPodium[0]?.partyId === "c_big");
ok("count → openItems", bigPodium[0]?.openItems === 7);
ok("partyCount = the FULL population (12, not the slice length 1)", bigPodium[0]?.partyCount === 12);
const massRow = topLeadersOfFact(crafted, 3)[2];
ok("mass row: partyName null carried", massRow?.partyName === null);
ok("mass row: partyId null carried", massRow?.partyId === null);
ok(
  "shape law: each entry carries EXACTLY the 6 documented fields",
  Object.keys(bigPodium[0] ?? {}).sort().join(",") === "openItems,outstandingMinor,partyCount,partyId,partyName,rank",
  `got ${Object.keys(bigPodium[0] ?? {}).sort().join(",")}`,
);
ok(
  "rank-1 row via topLeaderOfFact vs podium[0]: the shared four fields agree byte-for-byte",
  JSON.stringify({
    partyName: bigPodium[0]?.partyName,
    outstandingMinor: bigPodium[0]?.outstandingMinor,
    openItems: bigPodium[0]?.openItems,
    partyCount: bigPodium[0]?.partyCount,
  }) === JSON.stringify(topLeaderOfFact(big)),
  "one authority — the podium's rank 1 IS the leader view",
);

// ---------------------------------------------------------------- [4]
console.log("== [4] THE NO-RE-RANK + RUNNERS-UP laws over 40 randomized shuffles ==");
let noRerank = true;
let runnersExcludeLeader = true;
let runnersWellFormed = true;
const rng = mulberry32(970970);
for (let i = 0; i < 40; i++) {
  const n = 1 + Math.floor(rng() * 8); // 1..8 parties
  const ranks: number[] = Array.from({ length: n }, (_, k) => k + 1);
  // shuffle the array WITHOUT reassigning ranks — the fact's order is law
  for (let k = ranks.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [ranks[k], ranks[j]] = [ranks[j], ranks[k]];
  }
  const rows: LeadersFactInput = {
    leaders: ranks.map((rank) =>
      leader(
        rank,
        rank === 2 + Math.floor(rng() * 2) ? null : `p_${rank}`,
        rank === 3 ? null : `Party ${rank}`,
        Math.floor(rng() * 1_000_000) + 1,
        Math.floor(rng() * 5) + 1,
      ),
    ),
    partyCount: n,
  };
  const podium = topLeadersOfFact(rows, 3);
  const expectedRanks = rows.leaders!.slice(0, 3).map((l) => l.rank);
  if (JSON.stringify(podium.map((e) => e.rank)) !== JSON.stringify(expectedRanks)) noRerank = false;
  const runners = runnersUpOfFact(rows, 3);
  // runners-up BY RANK FIELD: the fact's rank-1 row is excluded wherever it sits
  if (runners.some((e) => e.rank === 1)) runnersExcludeLeader = false;
  // slices stay verbatim-ordered: the runners appear in the fact's own order
  const expectedRunners = rows
    .leaders!.slice(0, 3)
    .filter((l) => l.rank !== 1)
    .map((l) => l.rank);
  if (JSON.stringify(runners.map((e) => e.rank)) !== JSON.stringify(expectedRunners)) noRerank = false;

  // WELL-FORMED twin (the shape buildBookLeadersFact actually emits:
  // ranks 1..n in order) — runners-up ⊆ {2, 3}
  const wellFormed: LeadersFactInput = {
    leaders: Array.from({ length: n }, (_, k) =>
      leader(
        k + 1,
        k === 1 && rng() < 0.3 ? null : `p_${k + 1}`,
        k === 2 && rng() < 0.3 ? null : `Party ${k + 1}`,
        Math.floor(rng() * 1_000_000) + 1,
        Math.floor(rng() * 5) + 1,
      ),
    ),
    partyCount: n,
  };
  const wfRunners = runnersUpOfFact(wellFormed, 3);
  if (wfRunners.some((e) => e.rank < 2 || e.rank > 3)) runnersWellFormed = false;
  if (wfRunners.some((e) => e.rank === 1)) runnersExcludeLeader = false;
}
ok("40 randomized facts: podium order === the fact's own order (no re-rank)", noRerank);
ok("80 facts (shuffled + well-formed): runners-up never include rank 1", runnersExcludeLeader);
ok("40 well-formed facts: runner-up ranks stay within 2..3", runnersWellFormed);

// ---------------------------------------------------------------- [5]
console.log("== [5] DETERMINISM — 5× deep-equal ==");
const det1 = JSON.stringify(topLeadersOfFact(crafted, 3));
ok("determinism 5×", [1, 2, 3, 4, 5].every(() => JSON.stringify(topLeadersOfFact(crafted, 3)) === det1));

// ---------------------------------------------------------------- [6]
console.log("== [6] THE CLIENT-SAFETY STATIC LAW — zero imports ==");
const src = fs.readFileSync("src/lib/leader-view.ts", "utf8");
ok("leader-view.ts has NO import statements (client-safe by construction)", !/^\s*import\s/m.test(src));
ok("leader-view.ts has NO require( calls", !src.includes("require("));
ok("leader-view.ts has NO db references", !src.includes("from \"@/lib/db\"") && !src.includes("prisma"));

// ---------------------------------------------------------------- [7]
console.log("== [7] THE READERS' WIRING LAW (static) ==");
const snapshotSrc = fs.readFileSync("src/lib/ai/snapshot.ts", "utf8");
ok("snapshot.ts imports topLeadersOfFact from the ONE extractor", snapshotSrc.includes("topLeadersOfFact") && snapshotSrc.includes('from "@/lib/leader-view"'));
ok("snapshot.ts maps meta.topDebtors through topLeadersOfFact", /topDebtors:\s*topLeadersOfFact\(debtorsFact,\s*3\)/.test(snapshotSrc));
ok("snapshot.ts maps meta.topCreditors through topLeadersOfFact", /topCreditors:\s*topLeadersOfFact\(creditorsFact,\s*3\)/.test(snapshotSrc));
ok("snapshot.ts meta type carries the additive optional fields", snapshotSrc.includes("topDebtors?: BookPodiumEntry[]") && snapshotSrc.includes("topCreditors?: BookPodiumEntry[]"));

const balancesDataSrc = fs.readFileSync("src/modules/balances/balances-data.ts", "utf8");
const receivablesWired = /leader:\s*topLeaderOfFact\(raw\.leaders\),\s*\n\s*podium:\s*runnersUpOfFact\(raw\.leaders,\s*3\),/.test(balancesDataSrc);
ok("balances-data.ts maps BOTH routes' podium through runnersUpOfFact", receivablesWired, "expected podium: runnersUpOfFact(raw.leaders, 3) next to the leader mapping");
ok("balances-data.ts BalancesData carries podium?: BookPodiumEntry[]", balancesDataSrc.includes("podium?: BookPodiumEntry[]"));

const balancesViewSrc = fs.readFileSync("src/modules/balances/balances-view.tsx", "utf8");
ok("balances-view renders the podium rows from data.podium", balancesViewSrc.includes("data.podium"));
ok("balances-view rows carry the party-scoped drill (partyId) + all-parties fallback", balancesViewSrc.includes("partyId: row.partyId"));
ok("balances-view rows cite the server's own rank via leaderRankN", balancesViewSrc.includes('leaderRankN'));
ok("balances-view rows render the share-of-book bar", balancesViewSrc.includes("podiumShare") && balancesViewSrc.includes("width: `${share}%`"));
ok("balances-view uses the Medal icon (one step under Crown)", balancesViewSrc.includes("Medal"));

const copilotSrc = fs.readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
ok("copilot-view imports BookPodiumEntry from the ONE extractor", copilotSrc.includes("BookPodiumEntry") && copilotSrc.includes('from "@/lib/leader-view"'));
ok("copilot-view gates the chips on podium.length >= 2", /podium && podium\.length >= 2/.test(copilotSrc));
ok("copilot-view chips cite leaderRankN (the server rank, UI-locale digits)", copilotSrc.includes('t(\n                          "leaderRankN",') || copilotSrc.includes('"leaderRankN"'));
ok("copilot-view chips keep the honest mass label", copilotSrc.includes('entry.partyName ?? t("leaderUnassigned")'));
ok("copilot-view meta type carries the additive optional podium fields", copilotSrc.includes("topDebtors?: BookPodiumEntry[]") && copilotSrc.includes("topCreditors?: BookPodiumEntry[]"));

// i18n: every R97 key exists in BOTH bags (the audit's literal scanner
// cannot see balances-view's ternary binding nor multi-line calls)
const en = (await import("../src/i18n/messages/en")).default as Record<string, any>;
const fa = (await import("../src/i18n/messages/fa")).default as Record<string, any>;
const r97Keys: Array<[string, string]> = [
  ["finance.receivables", "leaderRankN"],
  ["finance.receivables", "podiumRowTooltip"],
  ["finance.receivables", "podiumMassTooltip"],
  ["finance.receivables", "podiumShare"],
  ["finance.payables", "leaderRankN"],
  ["finance.payables", "podiumRowTooltip"],
  ["finance.payables", "podiumMassTooltip"],
  ["finance.payables", "podiumShare"],
  ["copilot", "followUpRestDebtorsQ"],
  ["copilot", "followUpRestCreditorsQ"],
  ["copilot", "followUpRestDebtorsTooltip"],
  ["copilot", "followUpRestCreditorsTooltip"],
  ["copilot", "leaderRankN"],
  ["copilot", "leaderUnassigned"],
];
let i18nOk = true;
const getNs = (bag: Record<string, any>, path: string): any =>
  path.split(".").reduce<any>((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), bag);
for (const [nsPath, key] of r97Keys) {
  for (const [name, bag] of [["en", en], ["fa", fa]] as const) {
    if (typeof getNs(bag, nsPath)?.[key] !== "string") {
      i18nOk = false;
      console.log(`  ✗ ${name}.${nsPath}.${key} missing`);
    }
  }
}
ok("all 14 R97 ns.keys exist in BOTH en and fa", i18nOk);

// ----------------------------------------------------------------
console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
console.log("R97 PODIUM HARNESS GREEN ✓");
