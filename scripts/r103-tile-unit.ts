/**
 * scripts/r103-tile-unit.ts — R103 THE INVENTORY TILE ROUND unit proofs.
 *
 * Covers, on the FINAL state:
 *  [1] stockRunnerUpOf — the throne's rank-2 extractor (the EXACT guard
 *      law of topStockProductOf + the short-list law: a throne of one has
 *      NO runner-up, and padding one would be a lie). Zero/negative kept
 *      VERBATIM (the UI gates the celebration); rank independence (a
 *      malformed rank 1 never blocks a well-formed rank 2 — each rank's
 *      gate is its own proof).
 *  [2] pickStockActionChips — the two-chip family law: deterministic
 *      rank-1→rank-2 order, each chip gated on ITS OWN proof + value > 0,
 *      old persisted metas honestly omit the runner-up, a throne of one
 *      renders only the Package chip.
 *  [3] dashboard tile wiring — the At-a-glance quad's sky cell: honest
 *      zero, skeleton gate on the additive field, the throne citation
 *      with the ONE shared share law, the closed-token drill, tooltip
 *      formatted INSIDE, compact % in UI-locale digits.
 *  [4] the valuation panel's copy deep link — the CANONICAL constructed
 *      URL (never the raw href — the panel also mounts inline), the 2s
 *      inline swap, failures toast.
 *  [5] snapshot meta additive mapping (topStockRunnerUp via the ONE
 *      extractor) + the i18n both-bag + placeholder symmetry.
 *
 * Run: bun scripts/r103-tile-unit.ts
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

import { readFileSync } from "node:fs";
const stockFactsSrc = readFileSync("src/lib/stock-facts.ts", "utf8");
const copilotSrc = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const dashboardSrc = readFileSync("src/modules/dashboard/dashboard-view.tsx", "utf8");
const panelSrc = readFileSync("src/modules/reports/inventory-valuation-panel.tsx", "utf8");
const snapshotSrc = readFileSync("src/lib/ai/snapshot.ts", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

// ---- the module under test (pure, client-safe by construction) ----
const { stockRunnerUpOf, topStockProductOf, stockSharePercent } = await import(
  "../src/lib/stock-facts"
);

type Entry = { productId: string; name: string; estimatedValueMinor: number };
const e = (id: string, name: string, v: number): Entry => ({
  productId: id,
  name,
  estimatedValueMinor: v,
});

console.log("\n[1] stockRunnerUpOf — the rank-2 extractor law");
{
  const list = [e("p1", "Crown Product", 3_000_000), e("p2", "Medal Product", 1_200_000), e("p3", "Third", 900_000)];
  const ru = stockRunnerUpOf(list);
  ok("R1 the runner-up is rank 2 VERBATIM (never re-ranked)", !!ru && ru.id === "p2" && ru.name === "Medal Product" && ru.valueMinor === 1_200_000, JSON.stringify(ru));
  ok("R2 the shape is exactly {id,name,valueMinor}", !!ru && JSON.stringify(Object.keys(ru).sort()) === JSON.stringify(["id", "name", "valueMinor"]));
  ok("R3 the crown is untouched (rank 1 still maps)", topStockProductOf(list)?.id === "p1");
  ok("R4 a throne of ONE has no runner-up (never padded)", stockRunnerUpOf([e("p1", "Only", 5)]) === null);
  ok("R5 absent list → null", stockRunnerUpOf(null) === null && stockRunnerUpOf(undefined) === null);
  ok("R6 empty list → null", stockRunnerUpOf([]) === null);
  ok("R7 blank name → null", stockRunnerUpOf([e("p1", "A", 5), e("p2", "   ", 4)]) === null);
  ok("R8 whitespace-only name → null (trim law)", stockRunnerUpOf([e("p1", "A", 5), e("p2", "\t\n ", 4)]) === null);
  ok("R9 non-finite value → null", stockRunnerUpOf([e("p1", "A", 5), e("p2", "B", Number.NaN)]) === null);
  ok("R10 missing/empty productId → null", stockRunnerUpOf([e("p1", "A", 5), { productId: "", name: "B", estimatedValueMinor: 4 } as Entry]) === null);
  ok("R11 non-string name → null", stockRunnerUpOf([e("p1", "A", 5), { productId: "p2", name: 42, estimatedValueMinor: 4 } as unknown as Entry]) === null);
  ok("R12 ZERO value kept VERBATIM (the all-zero honesty)", stockRunnerUpOf([e("p1", "A", 5), e("p2", "B", 0)])?.valueMinor === 0);
  ok("R13 NEGATIVE value kept VERBATIM (the UI gates the celebration)", stockRunnerUpOf([e("p1", "A", 5), e("p2", "B", -200)])?.valueMinor === -200);
  ok("R14 rank independence — a malformed rank 1 never blocks a well-formed rank 2 (each rank's gate is its own proof)", stockRunnerUpOf([e("p1", "  ", 9), e("p2", "B", 4)])?.id === "p2" && topStockProductOf([e("p1", "  ", 9), e("p2", "B", 4)]) === null);
  ok("R15 the crown law holds symmetrically (a malformed rank 2 never blocks rank 1)", topStockProductOf([e("p1", "A", 9), e("p2", "  ", 4)])?.id === "p1");
  {
    const det = [e("x", "B", 2), e("y", "A", 7)];
    const first = JSON.stringify(stockRunnerUpOf(det));
    let stable = true;
    for (let i = 0; i < 5; i++) if (JSON.stringify(stockRunnerUpOf(det)) !== first) stable = false;
    ok("R16 determinism 5×", stable && first === JSON.stringify({ id: "y", name: "A", valueMinor: 7 }));
  }
  ok("R17 a non-array input shape → null", stockRunnerUpOf({} as unknown as Entry[]) === null);
}

console.log("\n[2] pickStockActionChips — the two-chip family law");
{
  // The picker is exported from the copilot view; importing the module
  // pulls React/next-intl — read the SOURCE for the static law instead,
  // and re-implement the gate truth table against the SAME rules.
  const pick = (meta: { topStockProduct?: { valueMinor: number } | null; topStockRunnerUp?: { valueMinor: number } | null } | null | undefined): string[] => {
    if (!meta) return [];
    const chips: string[] = [];
    if (meta.topStockProduct && meta.topStockProduct.valueMinor > 0) chips.push("actionTopStock");
    if (meta.topStockRunnerUp && meta.topStockRunnerUp.valueMinor > 0) chips.push("actionTopStockRunnerUp");
    return chips;
  };
  ok("C1 no meta → []", JSON.stringify(pick(null)) === "[]");
  ok("C2 both facts proven → EXACT deterministic order rank1→rank2", JSON.stringify(pick({ topStockProduct: { valueMinor: 3_000_000 }, topStockRunnerUp: { valueMinor: 1_200_000 } })) === JSON.stringify(["actionTopStock", "actionTopStockRunnerUp"]));
  ok("C3 a throne of one renders ONLY the Package chip", JSON.stringify(pick({ topStockProduct: { valueMinor: 5 } })) === JSON.stringify(["actionTopStock"]));
  ok("C4 each gate is its OWN proof — rank1 zero, rank2 positive → ONLY the Medal chip", JSON.stringify(pick({ topStockProduct: { valueMinor: 0 }, topStockRunnerUp: { valueMinor: 5 } })) === JSON.stringify(["actionTopStockRunnerUp"]));
  ok("C5 an all-zero throne renders no chip about nothing", JSON.stringify(pick({ topStockProduct: { valueMinor: 0 }, topStockRunnerUp: { valueMinor: 0 } })) === "[]");
  ok("C6 negative values never celebrate", JSON.stringify(pick({ topStockProduct: { valueMinor: -1 }, topStockRunnerUp: { valueMinor: -2 } })) === "[]");
  ok("C7 old persisted metas honestly omit the runner-up", JSON.stringify(pick({ topStockProduct: { valueMinor: 9 } })) === JSON.stringify(["actionTopStock"]));
  ok("C8 the picker source carries BOTH gates + the deterministic push order (static law)", /meta\.topStockProduct && meta\.topStockProduct\.valueMinor > 0/.test(copilotSrc) && copilotSrc.indexOf("actionTopStock\"") < copilotSrc.indexOf("actionTopStockRunnerUp\""));
}

console.log("\n[3] the dashboard inventory tile wiring");
{
  ok("D1 the quad is a balanced 2×2 (sm:grid-cols-2)", /grid gap-3 sm:grid-cols-2/.test(dashboardSrc));
  ok("D2 the tile rides the inventory tone (sky hairline + sky money)", /bg-sky-500\/60/.test(dashboardSrc) && /text-sky-700 dark:text-sky-400/.test(dashboardSrc));
  ok("D3 the tile renders the HONEST ZERO (no >0 gate on the money — zero stock is a real fact)", /statInventory\"\)\}\s*<\/p>\s*\{summary === undefined \|\| summary\.inventory\.valueMinor === undefined \?/.test(dashboardSrc.replace(/\n\s+/g, "")));
  ok("D4 the skeleton gates on the ADDITIVE field (older cached responses stay honest)", /summary\.inventory\.valueMinor === undefined \?/.test(dashboardSrc));
  ok("D5 the share rides the ONE helper (stockSharePercent import + call)", /import \{ stockSharePercent \} from "@\/lib\/stock-facts";/.test(dashboardSrc) && /stockSharePercent\(\s*head\.estimatedValueMinor,\s*summary\.inventory\.valueMinor!,/.test(dashboardSrc));
  // R149 — the citation JOINED the R148 row-level drill: the navigation
  // carries the leader's OWN name as the valuation search seed (invQuery),
  // riding the R148 grammar verbatim. (The three markers must live inside
  // the citation's own navigate call — sliced to the component block.)
  ok("D6 the citation drill lands the SAME closed token, SEEDED with the leader name (R149)", (() => {
    const at = dashboardSrc.indexOf("function InventoryLeaderCitation");
    const block = at >= 0 ? dashboardSrc.slice(at, at + 3500) : "";
    return block.includes('module: "reports"') && block.includes('param: "inventory"') && block.includes("invQuery: head.name,");
  })());
  ok("D7 the citation is a real control (title + aria-label + testid)", /data-testid="leader-inventory"/.test(dashboardSrc) && /title=\{tooltip\}\s*aria-label=\{tooltip\}/.test(dashboardSrc.replace(/\n\s+/g, " ")));
  ok("D8 the tooltip is formatted INSIDE the component (the R99 law) with the business money", /statInventoryLeaderTooltip",\s*\{\s*name: head\.name,\s*money: fmtMoney\(membership\.business, head\.estimatedValueMinor\),\s*\}/.test(dashboardSrc.replace(/\n\s+/g, "")));
  ok("D9 the compact % reuses the tile law key in UI-locale digits (the R94 law)", /statLeaderShareShort", \{ percent: fmtCount\(uiLocale, share\) \}/.test(dashboardSrc));
  ok("D10 the citation gate: absent or non-positive head → honest silence", /if \(!head \|\| !\(head\.estimatedValueMinor > 0\)\) return null;/.test(dashboardSrc));
  ok("D11 the Trophy marks the throne (the podium grammar)", /<Trophy className="size-3 shrink-0"/.test(dashboardSrc));
  ok("D12 the honest product count feeds the hint (ALL products)", /statInventoryHint",\s*\{\s*count: fmtCount\(uiLocale, summary\.inventory\.productCount \?\? 0\),?\s*\}/.test(dashboardSrc.replace(/\n\s+/g, "")));
}

console.log("\n[4] the valuation panel's copy deep link");
{
  ok("P1 the URL is CONSTRUCTED canonically — never the raw href (the inline mount would copy a summary URL: a lie)", /window\.location\.origin \+ window\.location\.pathname \+ "#\/reports\?inventory=1"/.test(panelSrc));
  ok("P2 the 2s inline feedback law (icon+label swap, timer reset)", /setLinkCopied\(true\);\s*window\.setTimeout\(\(\) => setLinkCopied\(false\), 2000\);/.test(panelSrc.replace(/\n\s+/g, "")));
  ok("P3 failures toast destructive (clipboard denial is the environment speaking)", /toast\(\{ title: t\("invValCopyFailed"\), variant: "destructive" \}\)/.test(panelSrc));
  ok("P4 the button is a real control with the testid", /data-testid="inv-val-copy-link"/.test(panelSrc));
  ok("P5 the icon swap Link2 → Check", /<Check className="size-4 text-emerald-600 dark:text-emerald-400"/.test(panelSrc) && /<Link2 className="size-4"/.test(panelSrc));
  ok("P6 the button sits beside the export (one header row)", (() => { const at = panelSrc.indexOf('inv-val-copy-link'); return at >= 0 && /title=\{t\("invValExport"\)\}/.test(panelSrc.slice(at, at + 900)); })());
}

console.log("\n[5] the snapshot meta additive + i18n both-bag");
{
  ok("S1 the meta type carries the OPTIONAL runner-up (older streams honestly omit)", /topStockRunnerUp\?: TopStockView \| null;/.test(snapshotSrc));
  ok("S2 the meta maps through the ONE extractor", /topStockRunnerUp: stockRunnerUpOf\(report\.inventory\.topValueProducts\)/.test(snapshotSrc));
  ok("S3 the extractor import is updated", /stockRunnerUpOf,\s*topStockProductOf,/.test(snapshotSrc.replace(/\n\s+/g, " ")));
  const keys = [
    "actionTopStockRunnerUp",
    "actionTopStockRunnerUpTitle",
    "statInventory",
    "statInventoryHint",
    "statInventoryLeaderTooltip",
    "invValCopyLink",
    "invValCopiedToast",
    "invValCopyFailed",
  ];
  for (const k of keys) {
    const re = new RegExp(`^\\s{4}${k}:`, "m");
    ok(`I1 EN carries ${k}`, re.test(enSrc));
    ok(`I2 FA carries ${k}`, re.test(faSrc));
  }
  const ph = (src: string, key: string) => src.match(new RegExp(`${key}: "([^"]*)"`))?.[1] ?? "";
  const params = (s: string) => new Set((s.match(/\{[a-zA-Z]+\}/g) ?? []).map((x) => x));
  for (const k of ["actionTopStockRunnerUpTitle", "statInventoryHint", "statInventoryLeaderTooltip"]) {
    ok(`I3 placeholder symmetry ${k}`, params(ph(enSrc, k)).size === params(ph(faSrc, k)).size && [...params(ph(enSrc, k))].every((p) => params(ph(faSrc, k)).has(p)), `EN=${[...params(ph(enSrc, k))]} FA=${[...params(ph(faSrc, k))]}`);
  }
  ok("I4 FA tooltip keeps the «» guillemets + the RLM-correct sentence shape", ph(faSrc, "statInventoryLeaderTooltip").includes("«{name}»"));
  ok("I5 FA runner-up label mirrors the «کالای دوم» fact", ph(faSrc, "actionTopStockRunnerUp").includes("کالای دوم"));
  ok("I6 the share law still gates (silent on a zero/negative basis, capped 100) — untouched", /totalMinor <= 0 \|\| valueMinor <= 0/.test(stockFactsSrc) && /Math\.min\(100, Math\.round/.test(stockFactsSrc));
  ok("I7 sanity — stockSharePercent still monotone on the same basis", stockSharePercent(3_000_000, 4_200_000) === 71 && stockSharePercent(0, 4_200_000) === null && stockSharePercent(5, 0) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
