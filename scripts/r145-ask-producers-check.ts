/**
 * scripts/r145-ask-producers-check.ts — R145 harness.
 *
 * The ?ask= producer FAMILY grows: the reorder suggestions panel is the
 * SECOND producer of #/copilot?ask=… (R144's perf panel was the first),
 * and the affordance keys are promoted to GENERIC names.
 *
 *   [1] the PRODUCER LAW (reorder-panel source) — the ask pill exists,
 *       gated EXACTLY like the export button (rows > 0 && !error — an ask
 *       affordance rides only where the panel's own data exists); ONE
 *       tooltip source (title = aria-label = askCopilotHint); the Bot icon;
 *       the singular testid; navigate carries the reorder question.
 *   [2] the KEY PROMOTION LAW — askCopilotLabel/askCopilotHint are the
 *       generic affordance keys (EN/FA); the perf-scoped names are GONE
 *       from BOTH locales; the perf + reorder QUESTION keys stay
 *       surface-specific and placeholder-free.
 *   [3] the GRAMMAR REGRESSION — the R144 ask hash laws still hold (spot
 *       re-run of parse/serialize/identity); the seed-not-send law in the
 *       copilot view is untouched; the composer cap authority intact.
 *   [4] the STYLING LAW — both producers share ONE pill geometry family
 *       (rounded-full h-7 text-[11px] primary outline) — the handoff reads
 *       as one affordance wherever it lives.
 *
 * Run: bun scripts/r145-ask-producers-check.ts
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

const reorder = readFileSync("src/modules/reports/reorder-panel.tsx", "utf8");
const panel = readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
const view = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const en = readFileSync("src/i18n/messages/en.ts", "utf8");
const fa = readFileSync("src/i18n/messages/fa.ts", "utf8");

// [1] the PRODUCER LAW (reorder panel) -------------------------------------------
console.log("\n== [1] reorder producer law ==");

{
  const m = reorder.match(/R145 — the SECOND \?ask= producer[\s\S]*?data-testid="reorder-ask-copilot"[\s\S]*?\/>/);
  ok("1a. the reorder ask block exists exactly once", m !== null);
  if (m) {
    const block = m[0];
    ok("1b. the navigate carries the reorder question", block.includes('module: "copilot"') && block.includes('ask: t("reorderAskQuestion")'));
    ok("1c. ONE tooltip source: title = aria-label = askCopilotHint", block.includes('title={t("askCopilotHint")}') && block.includes('aria-label={t("askCopilotHint")}'));
    ok("1d. the Bot icon carries the semantic", block.includes("<Bot"));
  }
  ok("1e. the testid is singular", (reorder.match(/reorder-ask-copilot/g) ?? []).length === 1);
  // The gate law: the ask pill rides the SAME condition as the export
  // button (rows exist && no error) — extract both conditions and compare.
  const gateMatch = reorder.match(/\{\((exportRows\.length > 0 && !error)\) \? \(/);
  ok("1f. the ask+export group shares ONE gate (rows > 0 && !error)", gateMatch !== null);
  ok("1g. the producer never sends (no handleSubmit in the panel)", !/handleSubmit/.test(reorder));
}

// [2] the KEY PROMOTION LAW -------------------------------------------------------
console.log("\n== [2] key promotion law ==");

ok("2a. askCopilotLabel EN", /askCopilotLabel: "Ask the Copilot"/.test(en));
ok("2b. askCopilotLabel FA pure Persian", /askCopilotLabel: "از دستیار بپرس"/.test(fa));
ok("2c. askCopilotHint EN says edit-before-send", /askCopilotHint: "Opens the Copilot with a ready question — edit it before sending\."/.test(en));
{
  const faHint = fa.match(/askCopilotHint: "([^"]*)"/)?.[1] ?? "";
  ok("2d. askCopilotHint FA pure Persian + edit-before-send", !/[A-Za-z]/.test(faHint) && faHint.includes("پیش از ارسال"), faHint);
}
ok("2e. the perf-scoped affordance keys are GONE from BOTH locales", !/perfAskCopilot|perfAskHint/.test(en) && !/perfAskCopilot|perfAskHint/.test(fa));
ok("2f. the reorder question EN is placeholder-free", /reorderAskQuestion: "Which products are running low right now\?"/.test(en));
{
  const faQ = fa.match(/reorderAskQuestion: "([^"]*)"/)?.[1] ?? "";
  ok("2g. the reorder question FA is pure Persian", !/[A-Za-z]/.test(faQ) && /\?">$|؟"/.test(faQ + "\""), faQ);
  ok("2h. the reorder question promises no purchase order (no خرید in the question)", !faQ.includes("خرید"), faQ);
}
ok("2i. the perf questions survive untouched (surface-specific)", /perfAskSales: "Which products drove my sales the most recently\?"/.test(en) && /perfAskCashflow: "Summarize my recent cash flow\."/.test(en));

// [3] the GRAMMAR REGRESSION ------------------------------------------------------
console.log("\n== [3] grammar regression ==");

{
  const v = hashToView("#/copilot?ask=Which%20products%20are%20running%20low%20right%20now%3F");
  eq(v, { kind: "module", module: "copilot", ask: "Which products are running low right now?" }, "3a. the reorder question parses through the R144 grammar");
  eq(viewToHash(v), "#/copilot?ask=Which%20products%20are%20running%20low%20right%20now%3F", "3b. ...and serializes byte-identical");
}
eq(hashToView("#/copilot?ask=%20"), { kind: "module", module: "copilot" }, "3c. whitespace ask still drops WHOLESALE");
eq(hashToView("#/reports?ask=x"), { kind: "module", module: "reports" }, "3d. foreign modules still ignore ask");
{
  const a: AppView = { kind: "module", module: "copilot", ask: "A" };
  const b: AppView = { kind: "module", module: "copilot", ask: "B" };
  ok("3e. a DIFFERENT ask still re-enters (sameView)", !sameView(a, b));
}
ok("3f. the seed-not-send law is untouched (no send verb in the R144 effect)", (() => {
  const m = view.match(/R144 — the ASK DEEP-LINK SEED[\s\S]*?\}, \[view, activeStreamId, input\]\);/);
  return m !== null && !/handleSubmit|sendCopilot|fetch\(/.test(m[0]);
})());
ok("3g. the composer cap authority intact (single maxLength=500)", (view.match(/maxLength=\{500\}/g) ?? []).length === 1);

// [4] the STYLING LAW --------------------------------------------------------------
console.log("\n== [4] styling law ==");

{
  // The two producers share ONE pill geometry family: rounded-full h-7
  // text-[11px] primary outline — the handoff reads as one affordance.
  const pill = "rounded-full";
  const geo = (src: string, testid: string) => {
    const m = src.match(new RegExp(`data-testid="${testid}"[\\s\\S]*?/>`));
    return m !== null;
  };
  ok("4a. both producers carry the rounded-full pill", panel.includes(pill) && reorder.includes(pill));
  ok("4b. both carry the h-7 + text-[11px] compact geometry", /h-7 gap-1\.5 rounded-full px-2\.5 text-\[11px\] font-medium/.test(panel) && /h-7 gap-1\.5 rounded-full px-2\.5 text-\[11px\] font-medium/.test(reorder));
  ok("4c. both carry the primary outline family (border-primary/30 hover /50)", /border-primary\/30 hover:border-primary\/50/.test(panel) && /border-primary\/30 hover:border-primary\/50/.test(reorder));
  ok("4d. the perf pill keeps its ms-auto (title-row end placement)", /className="text-primary hover:bg-primary\/5 border-primary\/30 hover:border-primary\/50 ms-auto h-7/.test(panel));
  ok("4e. the reorder pill rides a flex group beside the export button", reorder.includes('flex shrink-0 items-center gap-2') && reorder.indexOf('reorder-ask-copilot') < reorder.indexOf("<ListExportButton"));
  ok("4f. the Bot icon is singular per producer", (reorder.match(/<Bot /g) ?? []).length === 1 && (panel.match(/<Bot /g) ?? []).length === 1);
  ok("4g. the block extraction helper finds both pills (sanity)", geo(panel, "perf-ask-copilot") && geo(reorder, "reorder-ask-copilot"));
}

console.log(`\n== r145-ask-producers-check: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
