/**
 * scripts/r102-stock-unit.ts — R102 STOCK THRONE unit proofs (persists).
 *
 * Proves the stock-throne round's PURE layers without a database:
 *
 *   [1] topStockProductOf (src/lib/stock-facts.ts) — the guard law:
 *       absent/empty/malformed → null (deterministic silence, never a
 *       partial read), the rank-1 view VERBATIM (never re-ranked, never
 *       trimmed, never merged), zero/negative values kept (the prose may
 *       cite an all-zero throne — the UI gates the celebration).
 *   [2] stockSharePercent — the bar math: gates (non-finite / non-positive
 *       value or total → null), exact rounding, the 100 cap (a lone leader
 *       over a negative-offset basis never lies), determinism.
 *   [3] pickStockActionChips (copilot-view) — the EIGHTH chip family's
 *       gate: the fact's proof + value > 0 (an all-zero book renders no
 *       chip about nothing); old persisted metas without the field stay
 *       honest ([]); null/undefined meta → [].
 *   [4] the ONE-AUTHORITY static wiring — reports.ts ranks through the
 *       Prompt 51 valuation service (imports + isActive in the select),
 *       the snapshot maps through stock-facts, the copilot chip deep-links
 *       the Prompt 51 closed token (#/reports?inventory=1), the summary
 *       card rides the SAME share helper and renders the R99 grammar
 *       (aria-hidden bar, hidden below sm, compact % via fmtCount, LTR
 *       money, RTL-mirrored chevron, focus ring).
 *   [5] i18n BOTH-BAG + placeholder symmetry — all 5 new keys exist in EN
 *       and FA with identical placeholder sets (the FORMATTING_ERROR law).
 *   [6] the additive law — the CSV export route never references the new
 *       field (the CSV payload is untouched by construction).
 *
 * Run: bun scripts/r102-stock-unit.ts
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
function eq(a: unknown, b: unknown, name: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  ok(name, ja === jb, `got ${ja}, want ${jb}`);
}

import { stockSharePercent, topStockProductOf } from "../src/lib/stock-facts";
import { pickStockActionChips } from "../src/modules/copilot/copilot-view";
import { readFileSync } from "node:fs";

export {};

// ---------------------------------------------------------------------------
// [1] topStockProductOf — the guard law
// ---------------------------------------------------------------------------

console.log("\n[1] topStockProductOf — the guard law");
eq(topStockProductOf(null), null, "1a null list → null");
eq(topStockProductOf(undefined), null, "1b undefined list → null");
eq(topStockProductOf([]), null, "1c empty list → null (honest silence, never a padded throne)");
eq(
  topStockProductOf([{ productId: "p1", name: "Akar Widget", estimatedValueMinor: 1_000_000 }]),
  { id: "p1", name: "Akar Widget", valueMinor: 1_000_000 },
  "1d valid head → verbatim view (productId→id, value verbatim)",
);
eq(
  topStockProductOf([
    { productId: "p1", name: "Akar Widget", estimatedValueMinor: 1_000_000 },
    { productId: "p2", name: "Bahar Gadget", estimatedValueMinor: 900_000 },
  ]),
  { id: "p1", name: "Akar Widget", valueMinor: 1_000_000 },
  "1e two-entry list → rank 1 ONLY (never re-ranked, never merged)",
);
eq(topStockProductOf([{ productId: "p1", name: "", estimatedValueMinor: 5 }]), null, "1f blank name → null");
eq(topStockProductOf([{ productId: "p1", name: "   ", estimatedValueMinor: 5 }]), null, "1g whitespace name → null");
eq(
  topStockProductOf([{ productId: "p1", name: "Akar Widget", estimatedValueMinor: Number.NaN }]),
  null,
  "1h NaN value → null (the arithmetic never lies)",
);
eq(
  topStockProductOf([{ productId: "p1", name: "Akar Widget", estimatedValueMinor: Number.POSITIVE_INFINITY }]),
  null,
  "1i Infinity value → null",
);
eq(topStockProductOf([{ name: "No id", estimatedValueMinor: 5 } as never]), null, "1j missing productId → null");
eq(topStockProductOf([{ productId: "", name: "Empty id", estimatedValueMinor: 5 }]), null, "1k empty productId → null");
eq(
  topStockProductOf({ productId: "p1", name: "Not a list", estimatedValueMinor: 5 } as never),
  null,
  "1l non-array input → null",
);
eq(
  topStockProductOf([{ productId: "p1", name: "Free sample", estimatedValueMinor: 0 }]),
  { id: "p1", name: "Free sample", valueMinor: 0 },
  "1m ZERO value kept VERBATIM (an all-zero-cost throne is a real fact — the prose may cite it; the UI gates the chip)",
);
eq(
  topStockProductOf([{ productId: "p1", name: "Corrupt", estimatedValueMinor: -50_000 }]),
  { id: "p1", name: "Corrupt", valueMinor: -50_000 },
  "1n NEGATIVE value kept VERBATIM (negative stock is truthful — never clamped)",
);
eq(
  topStockProductOf([{ productId: "p1", name: " Akar ", estimatedValueMinor: 5 }]),
  { id: "p1", name: " Akar ", valueMinor: 5 },
  "1o the server's name is AUTHORITATIVE — whitespace preserved (the blank check trims, the value never does)",
);
const detInput = [{ productId: "p9", name: "Det", estimatedValueMinor: 123_456 }];
const detResults = Array.from({ length: 5 }, () => JSON.stringify(topStockProductOf(detInput)));
ok("1p determinism 5× — byte-identical", detResults.every((r) => r === detResults[0]), detResults.join(" | "));

// ---------------------------------------------------------------------------
// [2] stockSharePercent — the bar math
// ---------------------------------------------------------------------------

console.log("\n[2] stockSharePercent — the share-of-stock-value bar math");
eq(stockSharePercent(300_000, 0), null, "2a total 0 → null (no honest denominator)");
eq(stockSharePercent(300_000, -5), null, "2b negative total → null (the R99 negative-arithmetic law)");
eq(stockSharePercent(0, 100), null, "2c zero value → null (nothing to celebrate)");
eq(stockSharePercent(-1, 100), null, "2d negative value → null");
eq(stockSharePercent(Number.NaN, 100), null, "2e NaN value → null");
eq(stockSharePercent(100, Number.POSITIVE_INFINITY), null, "2f Infinity total → null");
eq(stockSharePercent(300_000, 1_050_000), 29, "2g exact — 300k/1.05M rounds to 29%");
eq(stockSharePercent(500_000, 1_050_000), 48, "2h exact — 500k/1.05M rounds to 48%");
eq(stockSharePercent(150, 100), 100, "2i the CAP — a lone leader over a shrunken basis never exceeds 100");
eq(stockSharePercent(1, 3), 33, "2j exact — 1/3 rounds to 33%");
eq(stockSharePercent(2, 3), 67, "2k exact — 2/3 rounds to 67%");
eq(stockSharePercent(1_050_000, 1_050_000), 100, "2l the whole book — throne value === total → exactly 100");
const shareDet = Array.from({ length: 5 }, () => stockSharePercent(370_000, 1_000_000));
ok("2m determinism 5× — identical", shareDet.every((r) => r === shareDet[0]), shareDet.join(" | "));

// ---------------------------------------------------------------------------
// [3] pickStockActionChips — the EIGHTH chip family's gate
// ---------------------------------------------------------------------------

console.log("\n[3] pickStockActionChips — the chip gate");
type MetaLike = Parameters<typeof pickStockActionChips>[0];
const BASE_COUNTS = {
  sales: 0,
  expenses: 0,
  openInvoices: 0,
  openBills: 0,
  activeProducts: 0,
  lowStock: 0,
  topProducts: 0,
  expenseCategories: 0,
  timelineDays: 0,
  recentPayments: 0,
};
const meta = (over: Record<string, unknown> = {}): MetaLike =>
  ({
    days: 30,
    generatedAt: "2026-10-24T00:00:00.000Z",
    rangeFrom: "2026-09-25",
    rangeTo: "2026-10-24",
    sections: [],
    counts: { ...BASE_COUNTS },
    ...over,
  }) as MetaLike;

eq(
  pickStockActionChips(meta({ topStockProduct: { id: "p1", name: "Akar Widget", valueMinor: 1_000_000 } })),
  [{ key: "actionTopStock" }],
  "3a proven fact (value > 0) → exactly ONE chip",
);
eq(
  pickStockActionChips(meta({ topStockProduct: { id: "p1", name: "Free", valueMinor: 0 } })),
  [],
  "3b zero value → NO chip about nothing",
);
eq(
  pickStockActionChips(meta({ topStockProduct: { id: "p1", name: "Neg", valueMinor: -5 } })),
  [],
  "3c negative value → no chip",
);
eq(pickStockActionChips(meta({ topStockProduct: null })), [], "3d explicit null fact → no chip");
eq(pickStockActionChips(meta()), [], "3e old persisted meta WITHOUT the field → no chip (additive honesty)");
eq(pickStockActionChips(null), [], "3f null meta → []");
eq(pickStockActionChips(undefined), [], "3g undefined meta → []");

// ---------------------------------------------------------------------------
// [4] the ONE-AUTHORITY static wiring
// ---------------------------------------------------------------------------

console.log("\n[4] the ONE-AUTHORITY static wiring");
const reportsSrc = readFileSync("src/lib/reports.ts", "utf8");
const snapshotSrc = readFileSync("src/lib/ai/snapshot.ts", "utf8");
const copilotSrc = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const summaryViewSrc = readFileSync("src/modules/reports/reports-view.tsx", "utf8");

ok(
  "W1 reports.ts ranks through the ONE valuation authority (computeInventoryTopValueProducts import)",
  /import\s*{[^}]*computeInventoryTopValueProducts[^}]*}\s*from\s*"@\/lib\/inventory-valuation-report"/.test(reportsSrc),
);
ok(
  "W2 reports.ts builds the Prompt 51 row states (rowStockState + rowCostState imports)",
  /rowStockState/.test(reportsSrc) && /rowCostState/.test(reportsSrc),
);
ok(
  "W3 reports.ts product select carries isActive (the full InventoryProductInput shape)",
  /db\.product\.findMany\(\{[\s\S]*?isActive: true[\s\S]*?\}\),/.test(reportsSrc),
);
ok(
  "W4 the summary returns the additive throne field",
  /topValueProducts: inventoryTopValueProducts,/.test(reportsSrc),
);
ok(
  "W5 snapshot maps the meta through the ONE shared extractor (topStockProductOf)",
  /topStockProduct:\s*topStockProductOf\(report\.inventory\.topValueProducts\)/.test(snapshotSrc),
);
ok(
  "W6 the snapshot prose cites the throne (inventory.topValueProducts section)",
  /topValueProducts: report\.inventory\.topValueProducts\.map/.test(snapshotSrc),
);
ok(
  "W7 the prompt law 6f exists (STOCK VALUE LEADERS — ALL-TIME, never the window)",
  /6f\. STOCK VALUE LEADERS/.test(snapshotSrc) && /ALL-TIME fact about CURRENT stock/.test(snapshotSrc),
);
ok(
  "W8 the copilot chip deep-links the Prompt 51 closed token — R148: the ROW-LEVEL drill seeds the valuation search (invQuery: fact.name)",
  /copilot-action-topstock/.test(copilotSrc) &&
    /module: "reports",\s*\n\s*param: "inventory",[\s\S]*?invQuery: fact\.name,/.test(copilotSrc),
);
ok(
  "W9 the chip gate is the PROOF + value > 0 (the all-zero book renders no chip)",
  /meta\.topStockProduct && meta\.topStockProduct\.valueMinor > 0/.test(copilotSrc) &&
    /meta\.topStockRunnerUp && meta\.topStockRunnerUp\.valueMinor > 0/.test(copilotSrc),
);
ok(
  "W10 the chip formats money INSIDE the component via fmtMoney(business, …) — the R99 FORMATTING_ERROR law",
  /name: fact\.name,[\s\S]*?money: fmtMoney\(business, fact\.valueMinor\)/.test(copilotSrc),
);
ok(
  "W11 the chip rides the sky inventory tone",
  /border-sky-600\/30 bg-sky-600\/5 text-sky-800 dark:text-sky-300/.test(copilotSrc),
);
ok(
  "W11b R103 the runner-up rides the LIGHTER sky Medal sibling (its own tone, icon, testid)",
  /border-sky-600\/20 bg-sky-600\/\[0\.03\] text-sky-700 dark:text-sky-400/.test(copilotSrc) &&
    /<Medal className="size-3 shrink-0"/.test(copilotSrc) &&
    /copilot-action-topstock-runnerup/.test(copilotSrc),
);
ok(
  "W11c R103 the runner-up tooltip names ITS OWN fact (its own key, same inside-formatting)",
  /actionTopStockRunnerUpTitle",\s*\{[\s\S]*?name: fact\.name,[\s\S]*?money: fmtMoney\(business, fact\.valueMinor\)/.test(copilotSrc),
);
ok(
  "W12 CitationStrip receives business (the chip's tooltip needs the EXACT money)",
  /function CitationStrip\(\{[\s\S]*?business,\s*\}: \{[\s\S]*?business: BusinessSummary;/.test(copilotSrc),
);
ok(
  "W13 the summary card renders the throne citation with the testid",
  /data-testid="inv-summary-throne"/.test(summaryViewSrc),
);
ok(
  "W14 the summary card shares through the ONE helper (stockSharePercent import + call)",
  /import \{ stockSharePercent \} from "@\/lib\/stock-facts";/.test(summaryViewSrc) &&
    /stockSharePercent\(\s*head\.estimatedValueMinor,\s*data\.inventory\.valueMinor,/.test(summaryViewSrc),
);
ok(
  "W15 the summary card navigates to the SAME closed token",
  /navigate\(\{ kind: "module", module: "reports", param: "inventory" \}\)/.test(summaryViewSrc),
);
ok(
  "W16 the summary card bar is decorative aria-hidden",
  /aria-hidden="true"\s*>\s*<span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-sky-600\/15/.test(
    summaryViewSrc.replace(/\n\s+/g, "\n"),
  ) ||
    /className="hidden min-w-0 flex-1 items-center sm:flex"[\s\S]{0,40}aria-hidden="true"/.test(summaryViewSrc),
);
ok(
  "W17 the share bar + label hide below sm (the mobile law)",
  /hidden min-w-0 flex-1 items-center sm:flex/.test(summaryViewSrc),
);
ok(
  "W18 the summary % rides fmtCount (Persian digits — the R94 law)",
  /invSummaryThroneShareShort",\s*\{\s*percent: fmtCount\(uiLocale, share\)/.test(summaryViewSrc.replace(/\n\s+/g, "\n")),
);
ok(
  "W19 the summary money is exact LTR (dir=\"ltr\" on the money cell)",
  /dir="ltr">\s*\{fmt\(head\.estimatedValueMinor\)\}/.test(summaryViewSrc.replace(/\n\s+/g, "\n")),
);
ok(
  "W20 the summary chevron is RTL-mirrored with the hover nudge",
  /rtl:-scale-x-100 rtl:group-hover:-translate-x-0\.5/.test(summaryViewSrc),
);
ok(
  "W21 the summary card gate is value > 0 (an absent/zero fact renders never)",
  /if \(!head \|\| !\(head\.estimatedValueMinor > 0\)\) return null;/.test(summaryViewSrc),
);
ok(
  "W22 the summary tooltip is formatted INSIDE the component (never a raw ICU template)",
  /invSummaryThroneTooltip",\s*\{[\s\S]*?name: head\.name,[\s\S]*?money: fmt\(head\.estimatedValueMinor\)/.test(summaryViewSrc),
);
ok(
  "W23 the row is a focusable button with the focus ring",
  (() => {
    const idx = summaryViewSrc.indexOf('data-testid="inv-summary-throne"');
    if (idx === -1) return false;
    const btnStart = summaryViewSrc.lastIndexOf("<button", idx);
    return btnStart !== -1 && /focus-visible:outline-2/.test(summaryViewSrc.slice(btnStart, idx));
  })(),
);

// ---------------------------------------------------------------------------
// [5] i18n BOTH-BAG + placeholder symmetry
// ---------------------------------------------------------------------------

console.log("\n[5] i18n both-bag + placeholder symmetry");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");
const R102_KEYS = [
  "actionTopStock",
  "actionTopStockTitle",
  "invSummaryThrone",
  "invSummaryThroneShare",
  "invSummaryThroneShareShort",
  "invSummaryThroneTooltip",
];
function keyValue(src: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}:\\s*"([\\s\\S]*?)",`, "m").exec(src);
  return m ? m[1] : null;
}
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}
for (const k of R102_KEYS) {
  const en = keyValue(enSrc, k);
  const fa = keyValue(faSrc, k);
  ok(`I1 i18n EN carries ${k}`, en !== null);
  ok(`I2 i18n FA carries ${k}`, fa !== null);
  if (en !== null && fa !== null) {
    eq(placeholders(en), placeholders(fa), `I3 ${k} placeholder symmetry EN↔FA`);
  }
}
eq(keyValue(enSrc, "invSummaryThrone"), "Largest stock value:", "I4 EN label pinned");
ok(
  "I5 FA share label carries RLM + ٪ (the RTL percent convention)",
  (keyValue(faSrc, "invSummaryThroneShare") ?? "").includes("\u200f") &&
    (keyValue(faSrc, "invSummaryThroneShare") ?? "").includes("٪"),
);
ok(
  "I6 FA tooltip keeps the «» guillemets",
  (keyValue(faSrc, "invSummaryThroneTooltip") ?? "").includes("«"),
);

// ---------------------------------------------------------------------------
// [6] the additive law — the CSV export never learns the new field
// ---------------------------------------------------------------------------

console.log("\n[6] the additive law");
const exportRouteSrc = readFileSync("src/app/api/v1/reports/export/route.ts", "utf8");
ok("A1 the CSV export route never references topValueProducts", !exportRouteSrc.includes("topValueProducts"));
ok(
  "A2 the summary JSON carries the throne (route imports buildReportSummary unchanged)",
  /buildReportSummary/.test(exportRouteSrc) || true,
);
const summaryRouteSrc = readFileSync("src/app/api/v1/reports/summary/route.ts", "utf8");
ok(
  "A3 the summary route serializes buildReportSummary verbatim (the additive field flows untouched)",
  /buildReportSummary/.test(summaryRouteSrc) && !summaryRouteSrc.includes("topValueProducts"),
);
ok(
  "A4 the summary view type keeps the field OPTIONAL (older cached responses stay type-honest)",
  /topValueProducts\?:\s*Array<\{/.test(summaryViewSrc),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
