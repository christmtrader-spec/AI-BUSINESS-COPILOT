/**
 * scripts/r93-aging-groups-unit.ts — R93 PURE-LAW HARNESS (persists).
 *
 * Proves the aging-details TABLE per-party sub-grouping
 * (src/lib/aging-groups.ts — the presentation twin of the R89 board):
 *
 *  [1] PARTITION EXACTNESS (the mirror law) — over crafted AND randomized
 *      populations: every item appears EXACTLY once; each group's
 *      count/outstanding/oldest reconcile with its own items; the sum of
 *      group subtotals === the flat sum; the sum of counts === items.length.
 *  [2] BOARD-ORDER EQUIVALENCE — the group order is the SAME ORDER the R89
 *      rollupRank produces over the same population (rollupAccumulate →
 *      rollupRank vs groupAgingItemsByParty: same partyId/name/count/
 *      outstanding/oldest sequence). The board and the table can never
 *      disagree — the comparator lives in ONE place (compareAgingGroups).
 *  [3] THE TIE CHAIN — money DESC → name asc (null reads "", the unassigned
 *      group sorts FIRST on equal money) → id asc; FA names compare by code
 *      points; deterministic across repeated runs (no reliance on sort
 *      stability).
 *  [4] SERVER ORDER PRESERVED — within a group the caller's row order is
 *      VERBATIM (same references, same sequence — the signed-cursor order
 *      is the server's authority; the client never re-sorts rows).
 *  [5] THE UNASSIGNED GROUP — partyId null is its own honest group (key ""),
 *      never merged into a fabricated party; it ranks by its own money.
 *  [6] HONEST EDGES — empty → []; single item; single party; big integers
 *      stay exact (no float drift); the function is clock/tz-free (same
 *      input, same output, always).
 *  [7] CLIENT-SAFE BY CONSTRUCTION — the module has ZERO import statements
 *      (no Prisma, no server modules can leak into the client bundle) and
 *      the view consumes THE pure function (no second grouping law in the
 *      view: no inline .sort( over groups, no re-implemented comparator).
 *
 * Run: npx tsx scripts/r93-aging-groups-unit.ts   (exit 0 = all green)
 */

import { readFileSync } from "node:fs";
import {
  compareAgingGroups,
  groupAgingItemsByParty,
  type AgingGroupableItem,
  type AgingPartyGroup,
} from "../src/lib/aging-groups";
import { rollupAccumulate, rollupRank } from "../src/lib/aging-details";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

type Row = AgingGroupableItem & { ref: string };

function row(ref: string, partyId: string | null, partyName: string | null, outstandingMinor: number, ageDays: number): Row {
  return { ref, partyId, partyName, outstandingMinor, ageDays };
}

function flatSum(items: readonly Row[]): number {
  return items.reduce((n, r) => n + r.outstandingMinor, 0);
}

// ---------------------------------------------------------------------------
// [1] PARTITION EXACTNESS — the mirror law over ANY rows the caller passes.
// ---------------------------------------------------------------------------
function assertPartition(name: string, items: Row[]) {
  const groups = groupAgingItemsByParty(items);
  const once = new Map<string, number>();
  let groupCount = 0;
  let groupMoney = 0;
  for (const g of groups) {
    groupCount += g.count;
    groupMoney += g.outstandingMinor;
    // per-group reconcile with its OWN items
    ok(`${name}: group ${g.partyId ?? "unassigned"} count === items.length`, g.count === g.items.length, `${g.count} vs ${g.items.length}`);
    const itemMoney = g.items.reduce((n, r) => n + r.outstandingMinor, 0);
    ok(`${name}: group ${g.partyId ?? "unassigned"} outstanding reconciles`, g.outstandingMinor === itemMoney, `${g.outstandingMinor} vs ${itemMoney}`);
    const maxAge = g.items.reduce((m, r) => Math.max(m, r.ageDays), 0);
    ok(`${name}: group ${g.partyId ?? "unassigned"} oldest === max age`, g.oldestDays === maxAge, `${g.oldestDays} vs ${maxAge}`);
    const key = g.partyId ?? "";
    ok(`${name}: every item in group ${key} carries the party`, g.items.every((r) => (r.partyId ?? "") === key));
    for (const r of g.items) once.set(r.ref, (once.get(r.ref) ?? 0) + 1);
  }
  ok(`${name}: every item EXACTLY once`, [...once.values()].every((n) => n === 1) && once.size === items.length, `${once.size} vs ${items.length}`);
  ok(`${name}: sum of group subtotals === flat sum`, groupMoney === flatSum(items), `${groupMoney} vs ${flatSum(items)}`);
  ok(`${name}: sum of group counts === items.length`, groupCount === items.length, `${groupCount} vs ${items.length}`);
}

// crafted population: 3 parties + unassigned, mixed ages/money
const crafted: Row[] = [
  row("INV-1", "c-akar", "Akar Trading", 1_300_000, 65),
  row("INV-2", "c-bahar", "Bahar Co", 900_000, 12),
  row("INV-3", "c-akar", "Akar Trading", 250_000, 40),
  row("EXP-9", null, null, 50_000, 3),
  row("INV-4", "c-akar", "Akar Trading", 100_000, 90),
  row("INV-5", "c-bahar", "Bahar Co", 10_000, 61),
];
assertPartition("crafted", crafted);

// randomized populations (deterministic LCG — no Math.random in a proof)
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}
for (const seed of [7, 42, 2026]) {
  const rnd = lcg(seed);
  const items: Row[] = Array.from({ length: 60 }, (_, i) => {
    const partyRoll = rnd();
    const partyId = partyRoll < 0.2 ? null : `p-${Math.floor(rnd() * 5)}`;
    const partyName = partyId === null ? null : ["Akar", "Bahar", "Cyrus", "Dena", "Erand"][Number(partyId.slice(2))];
    return row(`r${seed}-${i}`, partyId, partyId === null ? null : `${partyName} ${Math.floor(rnd() * 3)}`, Math.floor(rnd() * 1_000_000), Math.floor(rnd() * 120));
  });
  assertPartition(`rand${seed}`, items);
}

// ---------------------------------------------------------------------------
// [2] BOARD-ORDER EQUIVALENCE — the table groups in the SAME order the R89
// rollupRank produces over the same population (the ONE comparator law).
// ---------------------------------------------------------------------------
{
  const populations: Row[][] = [crafted, ...[7, 42].map((seed) => {
    const rnd = lcg(seed);
    return Array.from({ length: 40 }, (_, i) => row(`e${seed}-${i}`, rnd() < 0.25 ? null : `p-${Math.floor(rnd() * 4)}`, rnd() < 0.25 ? null : `Party ${Math.floor(rnd() * 4)}`, Math.floor(rnd() * 800_000), Math.floor(rnd() * 100)));
  })];
  for (const [pi, pop] of populations.entries()) {
    const groups = groupAgingItemsByParty(pop);
    const acc = new Map();
    for (const r of pop) rollupAccumulate(acc, r, true);
    const board = rollupRank(acc, 999);
    const sameOrder =
      groups.length === board.groups.length &&
      groups.every((g, i) => {
        const b = board.groups[i]!;
        return g.partyId === b.partyId && g.partyName === b.partyName && g.count === b.count && g.outstandingMinor === b.outstandingMinor && g.oldestDays === b.oldestDays;
      });
    ok(`board-equivalence[${pi}]: table order === rollupRank order (5 fields, all groups)`, sameOrder);
  }
  // the cap law stays the BOARD's concern: the table shows every party of the page
  {
    const pop: Row[] = Array.from({ length: 20 }, (_, i) => row(`m${i}`, `p-${i}`, `Party ${i}`, 100 + i, i));
    const groups = groupAgingItemsByParty(pop);
    ok("no-cap: the table groups EVERY party present in the page", groups.length === 20);
  }
}

// ---------------------------------------------------------------------------
// [3] THE TIE CHAIN — money DESC → name asc (null = "" sorts FIRST) → id asc.
// ---------------------------------------------------------------------------
{
  // money decides
  let g = groupAgingItemsByParty([row("a", "p1", "A", 100, 1), row("b", "p2", "B", 900, 2), row("c", "p1", "A", 50, 3)]);
  ok("tie[1]: money DESC first", g[0]!.partyId === "p2" && g[1]!.partyId === "p1");
  // name asc on equal money
  g = groupAgingItemsByParty([row("a", "p2", "Bahar", 500, 1), row("b", "p1", "Akar", 500, 2)]);
  ok("tie[2]: name asc on equal money", g[0]!.partyId === "p1");
  // unassigned ("" name) sorts BEFORE named parties on equal money
  g = groupAgingItemsByParty([row("a", "p1", "Akar", 500, 1), row("b", null, null, 500, 2)]);
  ok("tie[3]: unassigned sorts first on equal money", g[0]!.partyId === null);
  // FA names compare by CODE POINTS (ی ۰ 六 vs Arabic Yeh variants)
  g = groupAgingItemsByParty([row("a", "p2", "شیوه", 100, 1), row("b", "p1", "شیراز", 100, 1)]);
  const faFirst = compareAgingGroups(g[1]!, g[0]!) > 0 && g[0]!.partyName !== g[1]!.partyName;
  ok("tie[4]: FA names deterministic by code points", faFirst, `${g.map((x) => x.partyName).join("|")}`);
  // id asc breaks a full name tie
  g = groupAgingItemsByParty([row("a", "p-b", "Same", 100, 1), row("b", "p-a", "Same", 100, 1)]);
  ok("tie[5]: id asc breaks a name tie", g[0]!.partyId === "p-a");
  // determinism across runs
  const runs = Array.from({ length: 5 }, () =>
    groupAgingItemsByParty(crafted).map((x) => x.partyId ?? "").join(","),
  );
  ok("tie[6]: deterministic across repeated runs", new Set(runs).size === 1, runs[0]);
}

// ---------------------------------------------------------------------------
// [4] SERVER ORDER PRESERVED — within a group the caller's sequence is
// verbatim (the signed-cursor order is the server's authority).
// ---------------------------------------------------------------------------
{
  const items: Row[] = [
    row("INV-3", "c-akar", "Akar", 10, 40), // server order: 40d first
    row("INV-1", "c-akar", "Akar", 20, 65),
    row("INV-4", "c-akar", "Akar", 30, 90),
    row("INV-2", "c-bahar", "Bahar", 5, 12),
  ];
  const g = groupAgingItemsByParty(items);
  const akar = g.find((x) => x.partyId === "c-akar")!;
  ok("server-order: group rows are the input subsequence VERBATIM", akar.items.map((r) => r.ref).join(",") === "INV-3,INV-1,INV-4", akar.items.map((r) => r.ref).join(","));
  ok("server-order: same object references (no re-sort, no copy)", akar.items[0] === items[0] && akar.items[2] === items[2]);
  // note: the group's oldest (90) is a READING of the rows, not a re-sort
  ok("server-order: oldest is max age, not the last row's age", akar.oldestDays === 90);
}

// ---------------------------------------------------------------------------
// [5] THE UNASSIGNED GROUP — its own honest group, never fabricated.
// ---------------------------------------------------------------------------
{
  const g = groupAgingItemsByParty([row("a", null, null, 100, 5), row("b", null, null, 200, 9), row("c", "p1", "Akar", 50, 1)]);
  const un = g.find((x) => x.partyId === null)!;
  ok("unassigned: own group with null party", !!un && un.partyName === null && un.count === 2 && un.outstandingMinor === 300 && un.oldestDays === 9);
  ok("unassigned: never merged into a named party", g.length === 2);
}

// ---------------------------------------------------------------------------
// [6] HONEST EDGES.
// ---------------------------------------------------------------------------
{
  ok("edge: empty → []", groupAgingItemsByParty([]).length === 0);
  const one = groupAgingItemsByParty([row("a", "p1", "A", 1, 0)]);
  ok("edge: single item → one group", one.length === 1 && one[0]!.count === 1 && one[0]!.oldestDays === 0);
  const single = groupAgingItemsByParty([row("a", "p1", "A", 5, 1), row("b", "p1", "A", 6, 2)]);
  ok("edge: single party multi-items → one group", single.length === 1 && single[0]!.outstandingMinor === 11);
  // big integers stay EXACT (integer minor units, no float drift)
  const big: Row[] = Array.from({ length: 9 }, (_, i) => row(`b${i}`, "p1", "A", 1_000_000_000_007, i));
  const bg = groupAgingItemsByParty(big);
  ok("edge: big integers exact", bg[0]!.outstandingMinor === 9_000_000_000_063, String(bg[0]!.outstandingMinor));
  // clock/tz-free: same input twice → deep-equal arrangement
  const a = JSON.stringify(groupAgingItemsByParty(crafted));
  const b = JSON.stringify(groupAgingItemsByParty(crafted));
  ok("edge: pure (no clock, no tz) — same input, same output", a === b);
}

// ---------------------------------------------------------------------------
// [7] CLIENT-SAFE BY CONSTRUCTION + the view consumes THE pure function.
// ---------------------------------------------------------------------------
{
  const libSrc = readFileSync("src/lib/aging-groups.ts", "utf8");
  ok("client-safety: the module has ZERO import statements", !/^import\s/m.test(libSrc));
  const viewSrc = readFileSync("src/modules/balances/aging-details-view.tsx", "utf8");
  ok("view: consumes the ONE pure grouping function", viewSrc.includes("groupAgingItemsByParty("));
  ok("view: no second grouping law (no inline .sort( over groups)", !viewSrc.includes(".sort("));
  ok("view: grouping is presentation-only (never enters the hash)", !/group.*viewToHash|viewToHash.*group/i.test(viewSrc));
  ok("view: export stays flat (no group params in the export mutation)", !/exportParams\.set\("group/.test(viewSrc));
  ok("view: honest page-scope note is wired", viewSrc.includes("groupsPageScope"));
}

// ---------------------------------------------------------------------------
console.log(`\nr93-aging-groups-unit: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
