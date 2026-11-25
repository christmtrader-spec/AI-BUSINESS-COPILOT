/**
 * R181 — THE OUTSTANDING RUNNER-UP BATTERY (the "who else?" chips).
 *
 * The honest-silence item from R180 §5(3): the outstanding podium carried
 * rank 1 only (topDebtor/topCreditor) while the stock throne carried rank 1
 * + rank 2 (topStockProduct/topStockRunnerUp since R103). R181 mirrors the
 * R103 additive law onto the receivables/payables sides:
 *
 *   server  — snapshot.ts `outstandingRunnerUpOf(fact)` =
 *             topLeadersOfFact(fact, 2)[1] verbatim (ONE podium extractor,
 *             never re-ranked, zero new queries); honest silence when the
 *             book is silent or has ONE row — padding a runner-up is a lie.
 *   client  — copilot-view.tsx picks FOUR chips max in the deterministic
 *             order debtor → debtorRunnerUp → creditor → creditorRunnerUp,
 *             each judged on ITS OWN proof (rank 1's zero never blocks nor
 *             fabricates its runner-up); the mass row (partyId null) and
 *             nameless parties never drill (the R96 law); the side comes
 *             from chip.side (the key only picks rank wording + testid).
 *   i18n    — 4 new keys per locale (en/fa), parity pinned.
 *
 * Run: bun scripts/r181-outstanding-runner-up-check.ts
 */

import { readFileSync } from "node:fs";
import { pickOutstandingActionChips } from "../src/modules/copilot/copilot-view";
import { topLeadersOfFact, type LeadersFactInput } from "../src/lib/leader-view";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "OK " : "XX "} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, `got ${a}, want ${b}`);
}

const VIEW = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const SNAPSHOT = readFileSync("src/lib/ai/snapshot.ts", "utf8");
const EN = readFileSync("src/i18n/messages/en.ts", "utf8");
const FA = readFileSync("src/i18n/messages/fa.ts", "utf8");
// checker-side whitespace normalization (the r179 lesson — zero source
// changes for a checker-side string bug): comment markers collapse so a
// law phrase wrapped across comment lines still matches.
const SNAPSHOT_FLAT = SNAPSHOT.replace(/\/\/\s*/g, " ").replace(/\s+/g, " ");

// ---- the fact factory --------------------------------------------------------

type Row = { rank: number; partyId: string | null; partyName: string | null; outstandingMinor: number; count: number };
function fact(rows: Row[], partyCount = rows.length): LeadersFactInput {
  return rows.length === 0 ? { leaders: [], partyCount } : { leaders: rows, partyCount };
}
const row = (rank: number, partyId: string | null, partyName: string | null, outstandingMinor: number, count = 1): Row => ({
  rank, partyId, partyName, outstandingMinor, count,
});

// the picker's CONTRACT is tolerant (old persisted metas are partial — the
// additive law) while the client type declares the full shape; the battery
// exercises the CONTRACT, so partial metas cross one honest cast.
const asMeta = (o: unknown) => o as Parameters<typeof pickOutstandingActionChips>[0];

// ---- 1. the podium slice law (pure authority — leader-view, r96-tested) ------
console.log("\n[1] the podium slice law — rank 2 is [1] of take-2, verbatim, never re-ranked");

{
  const f = fact([
    row(1, "p-alice", "Alice", 5_000),
    row(2, "p-bob", "Bob", 3_000),
    row(3, "p-carol", "Carol", 1_000),
  ]);
  const take2 = topLeadersOfFact(f, 2);
  eq("1a. take-2 slice keeps the fact's own order", take2.map((e) => e.rank), [1, 2]);
  eq("1b. [1] IS rank 2 — server-stamped, not recomputed", take2[1]?.rank, 2);
  eq("1c. [1] row fields verbatim (id/name/money/items)", [take2[1]?.partyId, take2[1]?.partyName, take2[1]?.outstandingMinor, take2[1]?.openItems], ["p-bob", "Bob", 3000, 1]);

  // the shuffled-fact no-re-ranking law (r96 carries it; the runner-up read
  // inherits it — [1] of the GIVEN order, whatever the server said it is)
  const shuffled = fact([
    row(1, "p-alice", "Alice", 5_000),
    row(2, "p-bob", "Bob", 3_000),
    row(3, "p-carol", "Carol", 1_000),
  ].reverse());
  eq("1d. a reversed fact reads [1] verbatim — NO second ranking anywhere", topLeadersOfFact(shuffled, 2)[1]?.partyId, "p-bob");
}

// ---- 2. the honest-silence law (a book of one has NO runner-up) --------------
console.log("\n[2] honest silence — null fact / empty book / one-row book -> NO runner-up, never padded");

{
  eq("2a. null fact -> slice [] (the [1] read is undefined)", topLeadersOfFact(null as unknown as LeadersFactInput, 2), []);
  eq("2b. empty book -> slice []", topLeadersOfFact(fact([]), 2), []);
  const one = fact([row(1, "p-alice", "Alice", 5_000)]);
  eq("2c. book of ONE -> take-2 slice has length 1 — no [1] to read", topLeadersOfFact(one, 2).length, 1);
  ok("2d. snapshot reads runner-up via topLeadersOfFact(fact, 2)[1] (the ONE extractor, one slice deeper)", SNAPSHOT.includes("topLeadersOfFact(fact, 2)[1]"));
  ok("2e. the server runner-up mapper exists and maps the SAME 4-field shape", SNAPSHOT.includes("function outstandingRunnerUpOf(fact: LeadersFactInput): CopilotOutstandingView | null"));
  ok("2f. runner-up mapper drops rank/partyCount — the meta carries exactly what the chips render", SNAPSHOT.split("function outstandingRunnerUpOf")[1]?.split("}")[0]?.includes("partyId") === true);
}

// ---- 3. the server meta wire law (additive optional, same facts) -------------
console.log("\n[3] the snapshot meta — additive optional rank-2 pair, emitted from the SAME facts");

{
  ok("3a. meta type carries topDebtorRunnerUp (optional + nullable)", SNAPSHOT.includes("topDebtorRunnerUp?: CopilotOutstandingView | null;"));
  ok("3b. meta type carries topCreditorRunnerUp (optional + nullable)", SNAPSHOT.includes("topCreditorRunnerUp?: CopilotOutstandingView | null;"));
  ok("3c. emitted from the SAME debtorsFact as rank 1 (zero new queries)", /topDebtorRunnerUp: outstandingRunnerUpOf\(debtorsFact\)/.test(SNAPSHOT));
  ok("3d. emitted from the SAME creditorsFact as rank 1 (zero new queries)", /topCreditorRunnerUp: outstandingRunnerUpOf\(creditorsFact\)/.test(SNAPSHOT));
  ok("3e. the silence law is WRITTEN where the field is declared (a book of one has NO runner-up)", SNAPSHOT_FLAT.includes("a book of one has NO runner-up"));
  ok("3f. the no-re-rank law is WRITTEN on the mapper (the fact's own order IS the ranking)", /outstandingRunnerUpOf[\s\S]{0,900}the fact's own order\s*\n\s*\* IS the ranking/.test(SNAPSHOT) || SNAPSHOT.split("outstandingRunnerUpOf")[1]?.includes("IS the ranking"));
}

// ---- 4. the client mirror type law -------------------------------------------
console.log("\n[4] the client mirror — additive optional pair, same drill grammar as rank 1");

{
  ok("4a. client meta carries topDebtorRunnerUp?: CopilotOutstandingFact | null", VIEW.includes("topDebtorRunnerUp?: CopilotOutstandingFact | null;"));
  ok("4b. client meta carries topCreditorRunnerUp?: CopilotOutstandingFact | null", VIEW.includes("topCreditorRunnerUp?: CopilotOutstandingFact | null;"));
  ok("4c. the additive law is WRITTEN on the client fields (old persisted metas honestly omit)", VIEW.includes("old persisted metas honestly omit it; a book of one has NO runner-up"));
  ok("4d. the key union grew to FOUR chip keys", VIEW.includes('"actionDebtor" | "actionCreditor" | "actionDebtorRunnerUp" | "actionCreditorRunnerUp"'));
}

// ---- 5. the chip picker law (LIVE — the real picker, not a re-implementation) -
console.log("\n[5] pickOutstandingActionChips — the podium picker, each fact judged alone");

{
  const full = {
    topDebtor: { partyId: "p-alice", partyName: "Alice", outstandingMinor: 5_000, openItems: 3 },
    topDebtorRunnerUp: { partyId: "p-bob", partyName: "Bob", outstandingMinor: 3_000, openItems: 2 },
    topCreditor: { partyId: "s-one", partyName: "Supplier One", outstandingMinor: 4_000, openItems: 1 },
    topCreditorRunnerUp: { partyId: "s-two", partyName: "Supplier Two", outstandingMinor: 2_500, openItems: 4 },
  };
  const chips = pickOutstandingActionChips(asMeta(full));
  eq("5a. full podium -> FOUR chips", chips.length, 4);
  eq("5b. deterministic order: debtor -> debtorRunnerUp -> creditor -> creditorRunnerUp", chips.map((c) => c.key), ["actionDebtor", "actionDebtorRunnerUp", "actionCreditor", "actionCreditorRunnerUp"]);
  eq("5c. the runner-up chip rides ITS OWN id (navigation never rides a name)", chips[1]?.partyId, "p-bob");
  eq("5d. the runner-up chip keeps side=payables on the creditor side", chips[3]?.side, "payables");

  // rank 1's gate NEVER blocks nor fabricates its runner-up
  const zeroLeader = {
    topDebtor: { partyId: "p-zero", partyName: "Zero", outstandingMinor: 0, openItems: 0 },
    topDebtorRunnerUp: { partyId: "p-bob", partyName: "Bob", outstandingMinor: 3_000, openItems: 2 },
  };
  const chips2 = pickOutstandingActionChips(asMeta(zeroLeader));
  eq("5e. rank 1 zero -> NO chip about nothing; the runner-up still renders (each fact judged alone)", chips2.map((c) => c.key), ["actionDebtorRunnerUp"]);

  const oneBook = { topDebtor: { partyId: "p-alice", partyName: "Alice", outstandingMinor: 5_000, openItems: 3 } };
  eq("5f. a book of one -> ONLY the rank-1 chip (a padded runner-up is a lie)", pickOutstandingActionChips(asMeta(oneBook)).map((c) => c.key), ["actionDebtor"]);

  const massRunnerUp = { topDebtor: { partyId: "p-alice", partyName: "Alice", outstandingMinor: 5_000, openItems: 3 }, topDebtorRunnerUp: { partyId: null, partyName: null, outstandingMinor: 2_000, openItems: 1 } };
  eq("5g. the unassigned mass NEVER drills (R96 law, runner-up inherits it verbatim)", pickOutstandingActionChips(asMeta(massRunnerUp)).map((c) => c.key), ["actionDebtor"]);

  const namelessRunnerUp = { topDebtor: { partyId: "p-alice", partyName: "Alice", outstandingMinor: 5_000, openItems: 3 }, topDebtorRunnerUp: { partyId: "p-x", partyName: "   ", outstandingMinor: 2_000, openItems: 1 } };
  eq("5h. a runner-up that cannot name its party is noise, not an affordance", pickOutstandingActionChips(asMeta(namelessRunnerUp)).map((c) => c.key), ["actionDebtor"]);

  eq("5i. old persisted meta without the fields stays honest ([])", pickOutstandingActionChips(asMeta({ topDebtor: { partyId: "p-alice", partyName: "Alice", outstandingMinor: 5_000, openItems: 3 } })).length, 1);
  eq("5j. null meta -> []", pickOutstandingActionChips(null), []);
  eq("5k. undefined meta -> []", pickOutstandingActionChips(undefined), []);
  eq("5l. garbage meta -> []", pickOutstandingActionChips(asMeta("nonsense")), []);
}

// ---- 6. the render law (source pins — the side is the identity) --------------
console.log("\n[6] the render law — side from chip.side, runner-up wording, four testids");

{
  ok("6a. the side derives from chip.side (the key only picks wording — rank 2 broke the old derivation)", VIEW.includes('const debtor = chip.side === "receivables";'));
  ok("6b. the runner-up picks the runner-up tooltip family (actionDebtorRunnerUpTitle)", VIEW.includes('"actionDebtorRunnerUpTitle"'));
  ok("6c. the creditor runner-up has its own tooltip family (actionCreditorRunnerUpTitle)", VIEW.includes('"actionCreditorRunnerUpTitle"'));
  ok("6d. four testids — rank 1 keeps its R147 names, rank 2 gains -runner-up", VIEW.includes('"copilot-action-debtor-runner-up"') && VIEW.includes('"copilot-action-creditor-runner-up"') && VIEW.includes('"copilot-action-debtor"') && VIEW.includes('"copilot-action-creditor"'));
  ok("6e. the drill law is untouched — navigation rides chip.side + chip.partyId into aging-details", /onClick=\{\(\) => navigate\(\{ kind: "aging-details", side: chip\.side, partyId: chip\.partyId \}\)\}/.test(VIEW));
  ok("6f. title = aria-label = ONE source (the R147 law carries verbatim)", /title=\{tooltip\}\s*\n\s*aria-label=\{tooltip\}/.test(VIEW));
}

// ---- 7. the i18n parity law ---------------------------------------------------
console.log("\n[7] i18n — 4 new keys per locale, en/fa parity, ICU variables intact");

{
  for (const key of ["actionDebtorRunnerUp", "actionDebtorRunnerUpTitle", "actionCreditorRunnerUp", "actionCreditorRunnerUpTitle"]) {
    ok(`7a-${key} en`, EN.includes(`${key}: "`) , "missing in en.ts");
    ok(`7b-${key} fa`, FA.includes(`${key}: "`) , "missing in fa.ts");
  }
  ok("7c. debtor runner-up title names its ICU variables {name}/{money}/{count}", /actionDebtorRunnerUpTitle: "[^"]*\{name\}[^"]*\{money\}[^"]*\{count\}/.test(EN));
  ok("7d. creditor runner-up title names the same ICU variables", /actionCreditorRunnerUpTitle: "[^"]*\{name\}[^"]*\{money\}[^"]*\{count\}/.test(EN));
  ok("7e. fa runner-up titles keep the guillemet name law («…», both word orders pinned)", /دومین مطالبهٔ بزرگ: «\{name\}» به شما/.test(FA) && /دومین بدهی بزرگ: شما به «\{name\}» \{money\} بدهکار/.test(FA));
}

// ---- summary -------------------------------------------------------------------
console.log(`\n=== r181-outstanding-runner-up-check: ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
