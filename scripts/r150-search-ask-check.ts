/**
 * scripts/r150-search-ask-check.ts — R150 harness.
 *
 * THE DEAD END GROWS A DOOR: a zero-results search (Search Center AND the
 * ⌘K command palette) grows the SIXTH ?ask= producer — the user's OWN
 * query becomes the copilot composer's EDITABLE draft (seed-not-send),
 * riding the ONE ask-seed cap law (askSeedFromFreeText) and the ONE
 * ask-pill family geometry. PLUS the search surface joins the R148
 * motion-safety unification (filter chips + result rows).
 *
 *   [1] the SEED LAW (unit) — trim first, slice to the composer's own 500
 *       cap, blank drops (the caller renders nothing / never navigates),
 *       the store parser still re-applies its own law (mirrors, not a
 *       second grammar).
 *   [2] the SEARCH-CENTER LAW (source) — the ask block renders ONLY on
 *       the settled zero-results branch, ONE tooltip source (the generic
 *       hint), the R144 grammar verbatim, the family geometry, testids.
 *   [3] the PALETTE LAW (source) — a SELECTABLE (keyboard-reachable) item
 *       beside the disabled empty row, closes via go() like every other
 *       destination, same helper, same hint source, testid.
 *   [4] the i18n LAW — askCopilotEmpty EN/FA symmetric, pure Persian,
 *       "instead" honesty (never a promised answer).
 *   [5] the REGRESSION PIN — the store's ONE 500 authority holds, the
 *       R149 dashboard pill untouched, the R148 seed consumer untouched,
 *       the motion-safety law now rides the search surface too.
 *
 * Run: npx tsx scripts/r150-search-ask-check.ts
 */

import { readFileSync } from "node:fs";
import { askSeedFromFreeText } from "../src/lib/ask-seed";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond && info) failures.push(`${name} — ${info}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

const searchSrc = readFileSync("src/modules/search/search-view.tsx", "utf8");
const paletteSrc = readFileSync("src/modules/shell/command-palette.tsx", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const dashSrc = readFileSync("src/modules/dashboard/dashboard-view.tsx", "utf8");
const valPanelSrc = readFileSync("src/modules/reports/inventory-valuation-panel.tsx", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

section("[1] the SEED LAW — trim, cap, blank-drops (unit)");
{
  ok("1a trim first — padded input seeds trimmed", askSeedFromFreeText("  who owes me?  ") === "who owes me?");
  ok("1b the 500 cap is the authority (501 chars → 500)", askSeedFromFreeText("x".repeat(501)).length === 500);
  ok("1c a 499-char seed passes through untouched", askSeedFromFreeText("y".repeat(499)).length === 499);
  ok("1d the cap counts AFTER trim (pad + 501 → 500)", askSeedFromFreeText(`  ${"z".repeat(501)}  `).length === 500);
  ok("1e whitespace-only → empty string (the caller drops it)", askSeedFromFreeText("   ") === "");
  ok("1f empty string → empty string", askSeedFromFreeText("") === "");
  ok("1g PURE — same input, same seed (×3)", (() => {
    const s = "  fa?  ";
    return askSeedFromFreeText(s) === "fa?" && askSeedFromFreeText(s) === "fa?" && askSeedFromFreeText(s) === "fa?";
  })());
  ok("1h FA text round-trips byte-level", askSeedFromFreeText("  چه کسی بدهکار است؟ ") === "چه کسی بدهکار است؟");
  ok("1i the helper is exported from the ONE lib location", readFileSync("src/lib/ask-seed.ts", "utf8").includes("export function askSeedFromFreeText"));
  ok("1j the store parser STILL re-applies its own slice (mirror, not a second grammar)", /slice\(0, 500\)/.test(storeSrc));
}

section("[2] the SEARCH-CENTER LAW — the ask block on the zero-results branch");
{
  ok("2a the block renders ONLY in the settled zero-results branch", /groups\.length === 0 \? \(\s*<>\s*<EmptyState[\s\S]*?SearchAskCopilot q=\{q\} \/>/.test(searchSrc.replace(/\n\s+/g, " ")));
  ok("2b the seed rides askSeedFromFreeText (never a raw q)", /const seed = askSeedFromFreeText\(q\);/.test(searchSrc));
  ok("2c a BLANK seed renders NOTHING (the wholesale drop)", /if \(!seed\) return null;/.test(searchSrc));
  ok("2d the navigation rides the R144 grammar verbatim", /navigate\(\{ kind: "module", module: "copilot", ask: seed \}\)/.test(searchSrc));
  ok("2e ONE tooltip source — the generic seed-not-send hint", /title=\{tAsk\("askCopilotHint"\)\}\s*aria-label=\{tAsk\("askCopilotHint"\)\}/.test(searchSrc.replace(/\n\s+/g, " ")));
  ok("2f the pill shows the user's OWN query (the honest draft preview)", /«\{seed\}»/.test(searchSrc));
  ok("2g the testids exist (block + pill)", /data-testid="search-ask-block"/.test(searchSrc) && /data-testid="search-ask-copilot"/.test(searchSrc));
  ok("2h the pill rides the ONE family geometry", /border-primary\/30 hover:border-primary\/50 h-7 min-w-0 max-w-full gap-1.5 rounded-full px-2.5 text-\[11px\] font-medium/.test(searchSrc));
  ok("2i the pill truncates with dir=auto (FA queries stay honest)", /className="min-w-0 truncate" dir="auto"/.test(searchSrc));
  ok("2j the Bot marks the door (the family iconography)", /<Bot className="size-3 shrink-0" aria-hidden="true" \/>/.test(searchSrc));
}

section("[3] the PALETTE LAW — a selectable door on the keyboard surface");
{
  ok("3a the ask item is SELECTABLE (no disabled) with an onSelect", /<CommandItem\s+value=\{`ask-copilot \$\{q\}`\}\s+onSelect/.test(paletteSrc.replace(/\n\s+/g, " ")));
  ok("3b the door navigates with the SAME seed helper + R144 grammar", /go\(\{ kind: "module", module: "copilot", ask: askSeedFromFreeText\(q\) \}\)/.test(paletteSrc));
  ok("3c go() CLOSES the palette first (the one exit law)", /function go\(view: AppView\) \{\s*setOpen\(false\);/.test(paletteSrc.replace(/\n\s+/g, " ")));
  ok("3d the door renders only when the seed survives the cap/trim", /\{askSeedFromFreeText\(q\) \? \(/.test(paletteSrc));
  ok("3e ONE tooltip source — the generic hint (title + aria)", /title=\{tAsk\("askCopilotHint"\)\}\s*aria-label=\{tAsk\("askCopilotHint"\)\}/.test(paletteSrc.replace(/\n\s+/g, " ")));
  ok("3f the testid exists (palette-ask-copilot)", /data-testid="palette-ask-copilot"/.test(paletteSrc));
  ok("3g the Bot marks the door with the primary tone", /<Bot className="text-primary" aria-hidden="true" \/>/.test(paletteSrc));
  ok("3h the door sits BESIDE the disabled empty row (not instead)", /<CommandItem disabled value=\{q\}>[\s\S]*?ask-copilot/.test(paletteSrc));
  ok("3i the tAsk hook cites the reports namespace (the ONE hint wording)", /const tAsk = useTranslations\("reports"\);/.test(paletteSrc));
}

section("[4] the i18n LAW — the honest frame EN/FA");
{
  ok("4a EN has askCopilotEmpty in the search ns", /askCopilotEmpty: "No records match — ask the Copilot instead:"/.test(enSrc));
  ok("4b FA has the pure-Persian twin", faSrc.includes("askCopilotEmpty: \"هیچ رکوردی مطابقت ندارد — به‌جایش از دستیار بپرسید:\""));
  ok("4c the EN frame says INSTEAD (never a promised answer)", /ask instead/i.test(enSrc));
  ok("4d the FA frame says به‌جایش (the instead honesty)", faSrc.includes("به‌جایش از دستیار بپرسید"));
  ok("4e no ICU placeholder in the key (the query rides the MARKUP, not the translation)", !/askCopilotEmpty: "[^"]*\{/.test(enSrc) && !/askCopilotEmpty: "[^"]*\{/.test(faSrc));
  ok("4f the generic hint is UNTOUCHED", enSrc.includes('askCopilotHint: "Opens the Copilot with a ready question — edit it before sending."'));
}

section("[5] the REGRESSION PIN — the family laws this round must not disturb");
{
  ok("5a the store keeps exactly ONE 500 slice authority (the store's own)", (storeSrc.match(/slice\(0, 500\)/g) ?? []).length === 1);
  ok("5b the R149 dashboard pill untouched (its own pick, still one producer per surface)", /pickDashboardAsk\(summary\)/.test(dashSrc) && (dashSrc.match(/module: "copilot", ask:/g) ?? []).length === 1);
  ok("5c the R148 seed consumer untouched (seededQRef)", /seededQRef/.test(valPanelSrc));
  ok("5d the search surface joined the motion-safety law (filter chips)", /transition-colors motion-reduce:transition-none outline-none focus-visible:ring-2/.test(searchSrc.replace(/\n\s+/g, " ")));
  ok("5e the result rows ride the same unification", /outline-none transition-colors motion-reduce:transition-none/.test(searchSrc.replace(/\n\s+/g, " ")));
  ok("5f the R144 ask grammar survives in the store", /path === "copilot" && query\.has\("ask"\)/.test(storeSrc));
  ok("5g the search zero-results branch keeps the honest EmptyState", /text=\{tSearch\("empty"\)\}/.test(searchSrc));
}

console.log(`\nr150-search-ask-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
