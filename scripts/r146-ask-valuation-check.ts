/**
 * scripts/r146-ask-valuation-check.ts — R146 harness.
 *
 * The ?ask= producer FAMILY grows to THREE: the inventory-valuation panel
 * is the THIRD producer of #/copilot?ask=… (R144 perf → R145 reorder →
 * R146 valuation), and the valuation KPI cards join the R145 semantic
 * hover-border family.
 *
 *   [1] the PRODUCER LAW (inventory-valuation-panel source) — the ask pill
 *       exists, gated by the panel's OWN data presence (!error &&
 *       pg.totalCount > 0 — an ask affordance rides only where the panel's
 *       dataset exists; a filtered-to-zero view or a failed fetch never
 *       shows it); ONE tooltip source (title = aria-label = askCopilotHint);
 *       the Bot icon; the singular testid; navigate carries the valuation
 *       question; the producer never sends.
 *   [2] the QUESTION HONESTY LAW — inventoryAskQuestion EN/FA symmetric,
 *       placeholder-free, pure-Persian FA; the question promises NO
 *       accounting concept (§8.6 in the composer: no asset/profit/FIFO/
 *       balance-sheet in EN, no دارایی/سود/ترازنامه in FA) — the answer
 *       domain is the snapshot's pre-formatted valueAtCost (rule 6b keeps
 *       it operational); the generic affordance keys serve the third
 *       producer unchanged.
 *   [3] the FAMILY REGRESSION — THREE producers share ONE pill geometry
 *       (h-7 rounded-full px-2.5 text-[11px] primary outline); each panel
 *       carries the generic label+hint keys and its OWN question key(s);
 *       the R144 grammar spot re-run (parse/serialize/identity) and the
 *       seed-not-send law are untouched.
 *   [4] the STYLING LAW — the valuation KPI cards ride semantic hover
 *       borders (primary/25 on the three neutral figures, amber-500/40 on
 *       the zero-cost review flag whose conditional border is untouched);
 *       the §8.6 basis disclosure keeps its NEUTRAL edge (no primary tint —
 *       unlike the reorder decision-aid chip, the basis text is a legal
 *       disclosure, not an affordance tie-in).
 *
 * Run: bun scripts/r146-ask-valuation-check.ts
 */

import { readFileSync } from "node:fs";
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
function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `actual=${a} expected=${e}`);
}

const val = readFileSync("src/modules/reports/inventory-valuation-panel.tsx", "utf8");
const reorder = readFileSync("src/modules/reports/reorder-panel.tsx", "utf8");
const panel = readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
const view = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const en = readFileSync("src/i18n/messages/en.ts", "utf8");
const fa = readFileSync("src/i18n/messages/fa.ts", "utf8");

// [1] the PRODUCER LAW (inventory valuation panel) --------------------------------
console.log("\n== [1] valuation producer law ==");

{
  const m = val.match(/R146 — the THIRD \?ask= producer[\s\S]*?data-testid="inventory-valuation-ask-copilot"[\s\S]*?\/>/);
  ok("1a. the valuation ask block exists exactly once", m !== null);
  if (m) {
    const block = m[0];
    ok("1b. the navigate carries the valuation question", block.includes('module: "copilot"') && block.includes('ask: t("inventoryAskQuestion")'));
    ok("1c. ONE tooltip source: title = aria-label = askCopilotHint", block.includes('title={t("askCopilotHint")}') && block.includes('aria-label={t("askCopilotHint")}'));
    ok("1d. the Bot icon carries the semantic", block.includes("<Bot"));
    ok("1e. the pill precedes the copy-link button (lead position in the group)", val.indexOf("inventory-valuation-ask-copilot") < val.indexOf("inv-val-copy-link"));
  }
  ok("1f. the testid is singular", (val.match(/inventory-valuation-ask-copilot/g) ?? []).length === 1);
  // The gate law: the ask pill rides the panel's OWN data presence — a
  // loaded, non-error dataset with at least one included row.
  ok("1g. the gate is the data-presence law (!error && pg.totalCount > 0)", /\{!error && \(pg\?\.totalCount \?\? 0\) > 0 \? \(/.test(val));
  ok("1h. the producer never sends (no handleSubmit in the panel)", !/handleSubmit/.test(val));
}

// [2] the QUESTION HONESTY LAW -----------------------------------------------------
console.log("\n== [2] question honesty law ==");

{
  const enQ = en.match(/inventoryAskQuestion: "([^"]*)"/)?.[1] ?? "";
  const faQ = fa.match(/inventoryAskQuestion: "([^"]*)"/)?.[1] ?? "";
  ok("2a. the valuation question EN names the current book", enQ === "How much is my inventory worth right now?", enQ);
  ok("2b. the valuation question FA is pure Persian ending in ؟", !/[A-Za-z]/.test(faQ) && faQ.endsWith("؟"), faQ);
  ok("2c. both questions are placeholder-free", !enQ.includes("{") && !faQ.includes("{"));
  // §8.6 in the composer: the question promises NO accounting concept —
  // the snapshot's valueAtCost is an operational current-cost estimate
  // (system rule 6b), and the question must not upgrade it.
  ok("2d. the EN question promises no accounting concept", !/asset|profit|FIFO|balance sheet|COGS|depreciat/i.test(enQ), enQ);
  ok("2e. the FA question promises no accounting concept", !faQ.includes("دارایی") && !faQ.includes("سود") && !faQ.includes("ترازنامه") && !faQ.includes("استهلاک"), faQ);
}
ok("2f. the generic affordance keys serve the third producer unchanged", /askCopilotLabel: "Ask the Copilot"/.test(en) && /askCopilotLabel: "از دستیار بپرس"/.test(fa));
ok("2g. the perf + reorder questions survive untouched (surface-specific)", /perfAskSales: "Which products drove my sales the most recently\?"/.test(en) && /reorderAskQuestion: "Which products are running low right now\?"/.test(en) && /reorderAskQuestion: "الان کدام کالاها کم‌موجودی‌اند؟"/.test(fa));
ok("2h. the hint text is byte-identical to R145 (no per-surface drift)", /askCopilotHint: "Opens the Copilot with a ready question — edit it before sending\."/.test(en) && /askCopilotHint: "دستیار را با یک پرسش آماده باز می‌کند — پیش از ارسال می‌توانید ویرایشش کنید\."/.test(fa));

// [3] the FAMILY REGRESSION ---------------------------------------------------------
console.log("\n== [3] family regression ==");

{
  // THREE producers share ONE pill geometry — the handoff reads as one
  // affordance wherever it lives.
  const geo = /h-7 gap-1\.5 rounded-full px-2\.5 text-\[11px\] font-medium/;
  ok("3a. all three producers carry the pill geometry", geo.test(panel) && geo.test(reorder) && geo.test(val));
  ok("3b. all three carry the primary outline family", /border-primary\/30 hover:border-primary\/50/.test(panel) && /border-primary\/30 hover:border-primary\/50/.test(reorder) && /border-primary\/30 hover:border-primary\/50/.test(val));
  ok("3c. all three carry the generic label + hint keys", panel.includes('t("askCopilotLabel")') && reorder.includes('t("askCopilotLabel")') && val.includes('t("askCopilotLabel")') && panel.includes('t("askCopilotHint")') && reorder.includes('t("askCopilotHint")') && val.includes('t("askCopilotHint")'));
  ok("3d. the Bot icon is singular per producer", (panel.match(/<Bot /g) ?? []).length === 1 && (reorder.match(/<Bot /g) ?? []).length === 1 && (val.match(/<Bot /g) ?? []).length === 1);
  ok("3e. each producer keeps its own question key(s)", panel.includes("perfAskSales") && reorder.includes("reorderAskQuestion") && val.includes("inventoryAskQuestion"));
  ok("3f. exactly THREE producers + FIVE surface-specific question keys", (() => {
    const oneTestIdEach = (panel.match(/ask-copilot"/g) ?? []).length === 1
      && (reorder.match(/ask-copilot"/g) ?? []).length === 1
      && (val.match(/ask-copilot"/g) ?? []).length === 1;
    const questionKeys = en.match(/(?:perfAskSales|perfAskExpenses|perfAskCashflow|reorderAskQuestion|inventoryAskQuestion): "/g) ?? [];
    return oneTestIdEach && questionKeys.length === 5;
  })());
}
{
  const v = hashToView("#/copilot?ask=How%20much%20is%20my%20inventory%20worth%20right%20now%3F");
  eq(v, { kind: "module", module: "copilot", ask: "How much is my inventory worth right now?" }, "3g. the valuation question parses through the R144 grammar");
  eq(viewToHash(v), "#/copilot?ask=How%20much%20is%20my%20inventory%20worth%20right%20now%3F", "3h. ...and serializes byte-identical");
}
eq(hashToView("#/copilot?ask=%20"), { kind: "module", module: "copilot" }, "3i. whitespace ask still drops WHOLESALE");
eq(hashToView("#/reports?ask=x"), { kind: "module", module: "reports" }, "3j. foreign modules still ignore ask");
{
  const a: AppView = { kind: "module", module: "copilot", ask: "A" };
  const b: AppView = { kind: "module", module: "copilot", ask: "B" };
  ok("3k. a DIFFERENT ask still re-enters (sameView)", !sameView(a, b));
}
ok("3l. the seed-not-send law is untouched (no send verb in the R144 effect)", (() => {
  const m = view.match(/R144 — the ASK DEEP-LINK SEED[\s\S]*?\}, \[view, activeStreamId, input\]\);/);
  return m !== null && !/handleSubmit|sendCopilot|fetch\(/.test(m[0]);
})());
ok("3m. the composer cap authority intact (single maxLength=500)", (view.match(/maxLength=\{500\}/g) ?? []).length === 1);

// [4] the STYLING LAW ----------------------------------------------------------------
console.log("\n== [4] styling law ==");

{
  // The valuation KPI cards join the R145 semantic hover family.
  ok("4a. the three neutral KPI cards ride hover:border-primary/25", (val.match(/bg-card rounded-lg border p-3 transition-colors hover:border-primary\/25/g) ?? []).length === 3);
  ok("4b. the zero-cost card rides hover:border-amber-500/40 (its own hue) [RE-PINNED R169: the deep motion audit appended motion-reduce:transition-none — the R156 law's cn()-blind-spot closure; the hue law intact]", val.includes('"bg-card rounded-lg border p-3 transition-colors hover:border-amber-500/40 motion-reduce:transition-none"'));
  ok("4c. the zero-cost card's conditional border is untouched", val.includes('data.totals.zeroCostPositiveStockCount > 0 && "border-amber-500/30 bg-amber-500/5"'));
  // §8.6 neutrality: the valuation BASIS disclosure keeps its neutral edge —
  // unlike the reorder decision-aid chip (border-primary/15), the basis text
  // is a legal disclosure, not an affordance tie-in.
  ok("4d. the basis disclosure keeps its neutral edge (no primary tint)", (() => {
    const m = val.match(/data-testid="inventory-valuation-basis"[\s\S]*?>/);
    return m !== null && !m[0].includes("border-primary");
  })());
  ok("4e. the reorder disclosure keeps its R145 primary edge (no cross-drift)", reorder.includes("border-primary/15") && !val.includes("border-primary/15"));
  ok("4f. the perf pill keeps its ms-auto (title-row end placement)", /className="text-primary hover:bg-primary\/5 border-primary\/30 hover:border-primary\/50 ms-auto h-7/.test(panel));
  ok("4g. the reorder pill rides its flex group beside the export button", reorder.indexOf("reorder-ask-copilot") < reorder.indexOf("<ListExportButton"));
}

console.log(`\n== r146-ask-valuation-check: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
