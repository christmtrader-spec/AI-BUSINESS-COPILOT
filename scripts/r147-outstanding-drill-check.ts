/**
 * scripts/r147-outstanding-drill-check.ts — R147 harness.
 *
 * The OUTSTANDING DRILL: the copilot's grounded answers grow TWO chips
 * (debtor → receivables aging board, creditor → payables aging board) that
 * drill into the §16/§18 aging-details view by STABLE party id — the
 * biggest-loom item since R144. AND the FOURTH ?ask= producer: the balances
 * boards hand the copilot an honest whole-book question.
 *
 *   [1] the SERVER META LAW (snapshot.ts) — topDebtor/topCreditor ride the
 *       ONE podium extractor (topLeadersOfFact — never a second ranking),
 *       sliced to exactly what the chips render; optional+nullable
 *       (additive — old metas stay honest); ZERO new queries.
 *   [2] the PICKER LAW (unit) — gates per chip: non-blank partyId (the
 *       drill rides the ID, never the name), non-blank partyName,
 *       outstandingMinor > 0, openItems > 0; deterministic order
 *       debtor → creditor; old metas / null meta → []; a silent debtor
 *       never blocks a proven creditor (the stock-chips independence law).
 *   [3] the DRILL LAW (component source) — the navigate payload carries
 *       { kind: "aging-details", side, partyId } and NOTHING else (no
 *       bucket — the fact carries no age; no pastDue — it would silently
 *       filter the landing); ONE tooltip source (title = aria-label);
 *       fmtMoney + fmtCount INSIDE the component; the app's OWN nav
 *       iconography (HandCoins / ArrowUpRight); honest silence on empty.
 *   [4] the i18n LAW — EN/FA symmetric chip keys + question keys; the FA
 *       strings are pure Persian (no Latin after placeholder strip); the
 *       generic askCopilotLabel/askCopilotHint stay byte-identical (R145).
 *   [5] the FOURTH PRODUCER LAW (balances-view source) — the ask pill gated
 *       on the board's own data presence (!error && data?.topLeader), the
 *       family pill geometry VERBATIM (byte-equal to the reorder panel),
 *       the kind-scoped question, seed-not-send (no send verb), ONE
 *       tooltip source, the singular testid.
 *   [6] the REGRESSION PIN — the R144 ask grammar spot re-run; the R145/R146
 *       producers untouched; the composer cap authority intact.
 *
 * Run: bun scripts/r147-outstanding-drill-check.ts
 */

import { readFileSync } from "node:fs";
import {
  pickOutstandingActionChips,
} from "../src/modules/copilot/copilot-view";
import { hashToView, viewToHash, sameView, type AppView } from "../src/store/app-store";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, `got ${a}, want ${b}`);
}

const VIEW = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const SNAPSHOT = readFileSync("src/lib/ai/snapshot.ts", "utf8");
const BALANCES = readFileSync("src/modules/balances/balances-view.tsx", "utf8");
const EN = readFileSync("src/i18n/messages/en.ts", "utf8");
const FA = readFileSync("src/i18n/messages/fa.ts", "utf8");
const REORDER = readFileSync("src/modules/reports/reorder-panel.tsx", "utf8");
const VALUATION = readFileSync("src/modules/reports/inventory-valuation-panel.tsx", "utf8");

// ---- the fact factory --------------------------------------------------------

type FactLike = {
  partyId: string | null;
  partyName: string | null;
  outstandingMinor: number;
  openItems: number;
};

type MetaLike = Parameters<typeof pickOutstandingActionChips>[0];

function meta(fields: {
  topDebtor?: FactLike | null;
  topCreditor?: FactLike | null;
}): MetaLike {
  return { ...(fields as object) } as MetaLike;
}

const DEBTOR: FactLike = {
  partyId: "c1111111-1111-4111-8111-111111111111",
  partyName: "Acme Trading",
  outstandingMinor: 42_000,
  openItems: 3,
};
const CREDITOR: FactLike = {
  partyId: "s2222222-2222-4222-8222-222222222222",
  partyName: "Globex Supply",
  outstandingMinor: 17_500,
  openItems: 2,
};

// ==== [1] the SERVER META LAW =================================================

console.log("\n[1] SERVER META LAW (snapshot.ts)");

ok(
  "[1a] the meta imports the ONE podium extractor beside the name-only view",
  /import \{ topLeaderOfFact, topLeadersOfFact, type LeadersFactInput \} from "@\/lib\/leader-view";/.test(SNAPSHOT),
);
ok(
  "[1b] CopilotOutstandingView carries exactly the four chip fields",
  /export type CopilotOutstandingView = \{\s*\n\s*partyId: string \| null;\s*\n\s*partyName: string \| null;\s*\n\s*outstandingMinor: number;\s*\n\s*openItems: number;\s*\n\};/.test(SNAPSHOT),
);
{
  const block = SNAPSHOT.match(/function outstandingViewOf\(fact: LeadersFactInput\): CopilotOutstandingView \| null \{[\s\S]*?\n\}/)?.[0] ?? "";
  ok("[1c] the extractor reads rank 1 through topLeadersOfFact (never a second ranking)", block.includes("topLeadersOfFact(fact, 1)[0]"));
  ok("[1d] the extractor slices to the four chip fields (rank/partyCount dropped)", block.includes("partyId: first.partyId") && block.includes("openItems: first.openItems") && !block.includes("rank") && !block.includes("partyCount"));
  ok("[1e] a silent fact maps to null (honest silence)", block.includes("if (!first) return null;"));
}
ok(
  "[1f] meta fields are optional+nullable (the additive law — old metas honest)",
  /topDebtor\?: CopilotOutstandingView \| null;/.test(SNAPSHOT) &&
    /topCreditor\?: CopilotOutstandingView \| null;/.test(SNAPSHOT),
);
ok(
  "[1g] the meta build reads BOTH facts through the ONE extractor",
  /topDebtor: outstandingViewOf\(debtorsFact\),/.test(SNAPSHOT) &&
    /topCreditor: outstandingViewOf\(creditorsFact\),/.test(SNAPSHOT),
);
{
  const metaBlock = SNAPSHOT.match(/const meta: CopilotSnapshotMeta = \{[\s\S]*?\n  \};/)?.[0] ?? "";
  ok("[1h] ZERO new queries — the meta block reuses the existing fact names only", !metaBlock.includes("findMany") && !metaBlock.includes("db."));
}

// ==== [2] the PICKER LAW (unit) ===============================================

console.log("\n[2] PICKER LAW (unit)");

eq("[2a] null meta → []", pickOutstandingActionChips(null), []);
eq("[2b] undefined meta → []", pickOutstandingActionChips(undefined), []);
eq("[2c] an OLD persisted meta without the fields → []", pickOutstandingActionChips(meta({})), []);
eq("[2d] explicit nulls → []", pickOutstandingActionChips(meta({ topDebtor: null, topCreditor: null })), []);
{
  const chips = pickOutstandingActionChips(meta({ topDebtor: DEBTOR, topCreditor: CREDITOR }));
  eq("[2e] both proven facts → TWO chips", chips.length, 2);
  eq(
    "[2f] deterministic order debtor → creditor",
    chips.map((c) => c.key),
    ["actionDebtor", "actionCreditor"],
  );
  eq(
    "[2g] the side mapping receivables/payables",
    chips.map((c) => c.side),
    ["receivables", "payables"],
  );
  eq("[2h] the debtor's fact rides VERBATIM", chips[0], { key: "actionDebtor", side: "receivables", partyId: DEBTOR.partyId, partyName: DEBTOR.partyName, outstandingMinor: 42000, openItems: 3 });
  eq("[2i] the creditor's fact rides VERBATIM", chips[1], { key: "actionCreditor", side: "payables", partyId: CREDITOR.partyId, partyName: CREDITOR.partyName, outstandingMinor: 17500, openItems: 2 });
}
{
  const noId = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, partyId: null } }));
  ok("[2j] the unassigned mass (partyId null) NEVER drills", noId.length === 0);
  const blankId = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, partyId: "   " } }));
  ok("[2k] a blank party id never drills", blankId.length === 0);
  const noName = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, partyName: null } }));
  ok("[2l] a nameless party renders no chip (a chip that cannot name its party is noise)", noName.length === 0);
  const blankName = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, partyName: "" } }));
  ok("[2m] a blank party name renders no chip", blankName.length === 0);
}
{
  const zero = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, outstandingMinor: 0 } }));
  ok("[2n] zero outstanding renders no chip (no chip about nothing)", zero.length === 0);
  const neg = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, outstandingMinor: -5 } }));
  ok("[2o] negative outstanding renders no chip", neg.length === 0);
  const nan = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, outstandingMinor: Number.NaN } }));
  ok("[2p] a NaN outstanding renders no chip", nan.length === 0);
  const noItems = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, openItems: 0 } }));
  ok("[2q] zero open items renders no chip", noItems.length === 0);
  const nanItems = pickOutstandingActionChips(meta({ topDebtor: { ...DEBTOR, openItems: Number.NaN } }));
  ok("[2r] a NaN open-item count renders no chip", nanItems.length === 0);
}
{
  const onlyCreditor = pickOutstandingActionChips(meta({ topDebtor: null, topCreditor: CREDITOR }));
  eq(
    "[2s] a silent debtor never blocks a proven creditor (independence)",
    onlyCreditor.map((c) => c.key),
    ["actionCreditor"],
  );
  const onlyDebtor = pickOutstandingActionChips(meta({ topDebtor: DEBTOR, topCreditor: undefined }));
  eq(
    "[2t] an absent creditor never blocks a proven debtor",
    onlyDebtor.map((c) => c.key),
    ["actionDebtor"],
  );
}

// ==== [3] the DRILL LAW (component source) ====================================

console.log("\n[3] DRILL LAW (component source)");

{
  const comp = VIEW.match(/function OutstandingActionChips\(\{[\s\S]*?\n\}\n\n\/\/ ---- View/)?.[0] ?? "";
  ok("[3a] the component exists and renders the container testid", comp.includes('data-testid="copilot-outstanding-chips"'));
  ok(
    "[3b] the drill rides the STABLE id into the §16/§18 view",
    /navigate\(\{ kind: "aging-details", side: chip\.side, partyId: chip\.partyId \}\)/.test(comp),
  );
  {
    const onClick = comp.match(/onClick=\{\(\) => navigate\([^)]*\)\}/)?.[0] ?? "";
    ok("[3c] NO bucket on the navigation (the fact carries no age — never fabricated)", !onClick.includes("bucket"));
    ok("[3d] NO pastDue on the navigation (never a silent filter on the landing)", !onClick.includes("pastDue"));
  }
  ok(
    "[3e] ONE tooltip source — title and aria-label read the same variable",
    /title=\{tooltip\}/.test(comp) && /aria-label=\{tooltip\}/.test(comp),
  );
  ok(
    "[3f] the money formats INSIDE the component (fmtMoney — never a raw number)",
    comp.includes("fmtMoney(business, chip.outstandingMinor)"),
  );
  ok(
    "[3g] the count formats through the ONE-locale formatter (fmtCount — never a raw ICU number)",
    comp.includes("fmtCount(uiLocale, chip.openItems)"),
  );
  ok(
    "[3h] the icons mirror the app's OWN nav iconography",
    comp.includes("<HandCoins") && comp.includes("<ArrowUpRight"),
  );
  ok(
    "[3i] honest silence — the empty picker renders null",
    /const chips = pickOutstandingActionChips\(meta\);\s*\n\s*if \(chips\.length === 0\) return null;/.test(comp),
  );
  ok(
    "[3j] the hue family: emerald for the debtor, rose for the creditor",
    comp.includes("border-emerald-600/30") && comp.includes("border-rose-600/30"),
  );
  ok(
    "[3k] singular per-chip testids",
    comp.includes('"copilot-action-debtor"') && comp.includes('"copilot-action-creditor"'),
  );
  ok(
    "[3n] the motion-safety law on the new chips (transition-colors + motion-reduce:transition-none)",
    comp.includes("transition-colors motion-reduce:transition-none"),
  );
  ok(
    "[3l] the chips render under the transcript (the fourth family, after the perf chips)",
    /<PerfActionChips meta=\{m\.meta\} business=\{business\} \/>\s*\) : null\}\s*\{\/\* R147[\s\S]*?\*\/\}\s*\{!m\.failed && m\.meta \? \(\s*\n\s*<OutstandingActionChips meta=\{m\.meta\} business=\{business\} \/>/.test(VIEW),
  );
}
ok(
  "[3m] the client meta type mirrors the server shape (optional+nullable)",
  /topDebtor\?: CopilotOutstandingFact \| null;/.test(VIEW) && /topCreditor\?: CopilotOutstandingFact \| null;/.test(VIEW),
);

// ==== [4] the i18n LAW ========================================================

console.log("\n[4] i18n LAW");

{
  const enDebtor = EN.match(/actionDebtor: "([^"]+)"/)?.[1];
  const enCreditor = EN.match(/actionCreditor: "([^"]+)"/)?.[1];
  const faDebtor = FA.match(/actionDebtor: "([^"]+)"/)?.[1];
  const faCreditor = FA.match(/actionCreditor: "([^"]+)"/)?.[1];
  ok("[4a] the chip labels exist in BOTH locales", Boolean(enDebtor && enCreditor && faDebtor && faCreditor));
  ok("[4b] the FA labels are pure Persian (no Latin)", faDebtor !== undefined && !/[A-Za-z]/.test(faDebtor ?? "") && faCreditor !== undefined && !/[A-Za-z]/.test(faCreditor ?? ""));
}
{
  const enDebtorTitle = EN.match(/actionDebtorTitle: "([^"]+)"/)?.[1] ?? "";
  const enCreditorTitle = EN.match(/actionCreditorTitle: "([^"]+)"/)?.[1] ?? "";
  const faDebtorTitle = FA.match(/actionDebtorTitle: "([^"]+)"/)?.[1] ?? "";
  const faCreditorTitle = FA.match(/actionCreditorTitle: "([^"]+)"/)?.[1] ?? "";
  const placeholders = (s: string) => ["{name}", "{money}", "{count}"].every((p) => s.includes(p));
  ok("[4c] BOTH EN tooltips carry name+money+count", placeholders(enDebtorTitle) && placeholders(enCreditorTitle));
  ok("[4d] BOTH FA tooltips carry name+money+count", placeholders(faDebtorTitle) && placeholders(faCreditorTitle));
  ok(
    "[4e] the FA tooltips are pure Persian after the placeholder strip",
    !/[A-Za-z]/.test(faDebtorTitle.replace(/\{[^}]+\}/g, "")) &&
      !/[A-Za-z]/.test(faCreditorTitle.replace(/\{[^}]+\}/g, "")),
  );
  ok(
    "[4f] the debtor tooltip names INVOICES, the creditor names BILLS (the honest document nouns)",
    /open invoices/.test(enDebtorTitle) && /open bills/.test(enCreditorTitle),
  );
}
{
  const enQ = EN.match(/askQuestion: "([^"]+)"/g) ?? [];
  const faQ = FA.match(/askQuestion: "([^"]+)"/g) ?? [];
  ok("[4g] the kind-scoped question key exists TWICE per locale (receivables + payables)", enQ.length === 2 && faQ.length === 2);
  const faQuestions = faQ.map((m) => m.match(/"([^"]+)"/)?.[1] ?? "");
  ok("[4h] the FA questions are pure Persian and end with the Persian question mark", faQuestions.every((q) => !/[A-Za-z]/.test(q) && q.endsWith("؟")));
  ok(
    "[4i] the questions name the whole-book leaders (no window, no filter words)",
    !/last|recent|window|days|بازه|اخیر|روز/.test((faQuestions.join(" "))),
  );
}
{
  const enHint = EN.match(/askCopilotHint: "([^"]+)"/)?.[1] ?? "";
  const faHint = FA.match(/askCopilotHint: "([^"]+)"/)?.[1] ?? "";
  ok(
    "[4j] the generic affordance keys stay byte-identical (the R145 promotion law)",
    enHint === "Opens the Copilot with a ready question — edit it before sending." &&
      faHint === "دستیار را با یک پرسش آماده باز می‌کند — پیش از ارسال می‌توانید ویرایشش کنید.",
  );
}

// ==== [5] the FOURTH PRODUCER LAW (balances-view) =============================

console.log("\n[5] FOURTH PRODUCER LAW (balances-view)");

{
  const pill = BALANCES.match(/\{!error && data\?\.topLeader \? \([\s\S]*?\) : null\}/)?.[0] ?? "";
  ok("[5a] the pill exists, gated on the board's OWN data presence (!error && topLeader)", pill.includes("data-testid=\"balances-ask-copilot\""));
  ok(
    "[5b] the gate is EXACTLY !error && data?.topLeader (an empty book / failed fetch / loading board never shows an ask affordance)",
    /\{!error && data\?\.topLeader \? \(/.test(BALANCES),
  );
  ok(
    "[5c] seed-NOT-SEND — the handler only navigates with the question",
    /onClick=\{\(\) => navigate\(\{ kind: "module", module: "copilot", ask: t\("askQuestion"\) \}\)\}/.test(pill) &&
      !/send|stream|post\(/i.test(pill.replace(/aria-label|title|placeholder/g, "")),
  );
  ok(
    "[5d] ONE tooltip source (title = aria-label = the generic hint)",
    /title=\{tAsk\("askCopilotHint"\)\}/.test(pill) && /aria-label=\{tAsk\("askCopilotHint"\)\}/.test(pill),
  );
  ok("[5e] the Bot icon at the family size", pill.includes('<Bot className="size-3.5"'));
}
{
  const reorderCls = REORDER.match(/className="text-primary hover:bg-primary\/5 border-primary\/30 hover:border-primary\/50 h-7 gap-1\.5 rounded-full px-2\.5 text-\[11px\] font-medium"/)?.[0];
  const balancesCls = BALANCES.match(/className="text-primary hover:bg-primary\/5 border-primary\/30 hover:border-primary\/50 h-7 gap-1\.5 rounded-full px-2\.5 text-\[11px\] font-medium"/)?.[0];
  ok(
    "[5f] the pill geometry is BYTE-EQUAL to the reorder panel's (the family drift warning heeded)",
    Boolean(reorderCls) && reorderCls === balancesCls,
  );
  const valuationCls = VALUATION.match(/className="text-primary hover:bg-primary\/5 border-primary\/30 hover:border-primary\/50 h-7 gap-1\.5 rounded-full px-2\.5 text-\[11px\] font-medium"/)?.[0];
  ok("[5g] THREE producers + the new board share ONE geometry", valuationCls === reorderCls && reorderCls === balancesCls);
}
ok(
  "[5h] the generic keys are BORROWED from the one reports namespace (never duplicated per kind)",
  BALANCES.includes('const tAsk = useTranslations("reports");') &&
    !BALANCES.includes("askCopilotLabel:"),
);

// ==== [6] the REGRESSION PIN ==================================================

console.log("\n[6] REGRESSION PIN");

{
  const v = hashToView("#/copilot?ask=" + encodeURIComponent("Who owes me the most?  "));
  ok("[6a] R144 grammar — the ask trims and survives", (v as { ask?: string }).ask === "Who owes me the most?");
  const fa = hashToView("#/copilot?ask=" + encodeURIComponent("الان کدام مشتری بیشترین بدهی را به من دارد؟"));
  ok("[6b] the FA question round-trips byte-exact", (fa as { ask?: string }).ask === "الان کدام مشتری بیشترین بدهی را به من دارد؟");
  const long = hashToView("#/copilot?ask=" + encodeURIComponent("x".repeat(600)));
  ok("[6c] the composer cap (500) is the authority", ((v as { ask?: string }).ask === undefined) === false && ((fa as { ask?: string }).ask === undefined) === false);
  eq("[6d] a 600-char ask trims to 500", (long as { ask?: string }).ask?.length ?? 0, 500);
  const blank = hashToView("#/copilot?ask=" + encodeURIComponent("   "));
  ok("[6e] a blank ask is dropped WHOLESALE", (blank as { ask?: string }).ask === undefined);
  const faView: AppView = { kind: "module", module: "copilot", ask: "الان کدام مشتری بیشترین بدهی را به من دارد؟" };
  ok("[6f] viewToHash re-serializes the FA question byte-exact", viewToHash(faView) === "#/copilot?ask=" + encodeURIComponent("الان کدام مشتری بیشترین بدهی را به من دارد؟"));
  ok(
    "[6g] sameView — identical asks are structurally equal, different asks re-enter",
    sameView(faView, { kind: "module", module: "copilot", ask: "الان کدام مشتری بیشترین بدهی را به من دارد؟" }) === true &&
      sameView(faView, { kind: "module", module: "copilot", ask: "different" }) === false,
  );
}
ok(
  "[6h] the R145/R146 producers are untouched (testids still in source)",
  REORDER.includes('data-testid="reorder-ask-copilot"') && VALUATION.includes('data-testid="inventory-valuation-ask-copilot"'),
);
ok(
  "[6i] the surface question keys unchanged (R145/R146 pins hold)",
  EN.includes('reorderAskQuestion: "Which products are running low right now?"') &&
    EN.includes('inventoryAskQuestion: "How much is my inventory worth right now?"'),
);
ok(
  "[6j] the composer cap authority untouched",
  VIEW.includes("maxLength={500}"),
);
ok(
  "[6k] the seed-not-send effect untouched (the R144 law — no send verb in the seed block)",
  (() => {
    const seed = VIEW.match(/const ask =\s*\n?\s*view\.kind === "module" && view\.module === "copilot"[\s\S]*?\}, \[view, activeStreamId, input\]\);/)?.[0] ?? "";
    return seed.includes("setInput(ask)") && seed.includes("seededAskRef") && !/send|stream\(/i.test(seed);
  })(),
);

// ---- summary -----------------------------------------------------------------

console.log(`\nr147-outstanding-drill-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
