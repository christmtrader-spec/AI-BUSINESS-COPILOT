/**
 * scripts/r99-share-unit.ts — R99 UNIT PROOFS (persists).
 *
 * Proves the SHARE LANGUAGE round's pure core without a database:
 *
 *  [COMPARATOR] computeInventoryTopValueProducts crowns EXACTLY the
 *      VALUE_DESC order's head — the ONE authority (sortInventoryRows
 *      "VALUE_DESC" is called inside, so the throne can never disagree
 *      with the table's own ranking); 40 randomized shuffles → byte-for-
 *      byte identical result (no re-rank drift, no input-order coupling).
 *  [TIE] identical values → the SMALLER id wins rank 1 (the table's own
 *      tie-break), deterministically across shuffles.
 *  [CAP] a 5-row book → exactly 2 entries in VALUE_DESC order (rank 1
 *      then rank 2); fractional takes floor; take ≤ 0 / NaN / Infinity →
 *      [] (deterministic silence, never a partial read).
 *  [SHAPE] each entry carries EXACTLY {productId, name, estimatedValueMinor}.
 *  [NEGATIVE] an all-non-positive book still crowns the max HONESTLY
 *      (the value rides verbatim — the UI's share-bar gate is the client's
 *      0<x<=100 law, not the extractor's business).
 *  [DETERMINISM] 5× identical.
 *  [WIRING — static] buildInventoryValuationReport maps topValueProducts;
 *      the panel consumes data.topValueProducts with the entity drill;
 *      the dashboard TileLeaderLine passes totalMinor + side + the share
 *      tooltip; BOTH i18n bags carry all six R99 keys.
 *
 * Run: bun --conditions react-server scripts/r99-share-unit.ts
 * Exit: 0 = all green, 1 = at least one failure.
 */

import { computeInventoryTopValueProducts, sortInventoryRows } from "../src/lib/inventory-valuation-report";
import type { InventoryValuationRow } from "../src/lib/inventory-valuation-report";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

export {};

function row(
  id: string,
  name: string,
  stockQty: number,
  costPriceMinor: number,
): InventoryValuationRow {
  return {
    id,
    name,
    sku: null,
    unit: null,
    stockQty,
    lowStockAt: 0,
    costPriceMinor,
    isActive: true,
    estimatedValueMinor: stockQty * costPriceMinor,
    stockState: stockQty > 0 ? "POSITIVE_STOCK" : stockQty === 0 ? "ZERO_STOCK" : "NEGATIVE_STOCK",
    costState: costPriceMinor > 0 ? "POSITIVE_COST" : "ZERO_COST",
  };
}

const BOOK: InventoryValuationRow[] = [
  row("p-akar", "Akar Widget", 3, 100_000), // 300k
  row("p-bahar", "Bahar Gadget", 2, 250_000), // 500k
  row("p-cyrus", "Cyrus Kit", 5, 50_000), // 250k
];

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
let seedState = 98;
const rng = () => {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
};

console.log("\n[COMPARATOR] the throne IS the VALUE_DESC head — one authority");
const throne = computeInventoryTopValueProducts(BOOK, 2);
const valueDescHead = sortInventoryRows(BOOK, "VALUE_DESC");
ok("C1 rank 1 === the VALUE_DESC order's own head (id)", throne[0]?.productId === valueDescHead[0].id,
  `${throne[0]?.productId} vs ${valueDescHead[0].id}`);
ok("C2 rank 2 === the VALUE_DESC order's second seat", throne[1]?.productId === valueDescHead[1].id);
ok("C3 rank 1 value verbatim (500_000)", throne[0]?.estimatedValueMinor === 500_000, String(throne[0]?.estimatedValueMinor));
ok("C4 rank 1 name verbatim (Bahar Gadget)", throne[0]?.name === "Bahar Gadget", String(throne[0]?.name));
ok("C5 40 randomized shuffles → identical throne (no input-order coupling)", (() => {
  const baseline = JSON.stringify(computeInventoryTopValueProducts(BOOK, 2));
  for (let i = 0; i < 40; i++) {
    const shuffled = shuffle(BOOK, rng);
    if (JSON.stringify(computeInventoryTopValueProducts(shuffled, 2)) !== baseline) return false;
  }
  return true;
})());

console.log("\n[TIE] identical values → the SMALLER id is rank 1 (the table's own tie-break)");
const tieBook: InventoryValuationRow[] = [
  row("p-zeta", "Zeta Twin", 1, 400_000),
  row("p-alpha", "Alpha Twin", 1, 400_000),
];
const tieThrone = computeInventoryTopValueProducts(tieBook, 2);
ok("T1 rank 1 is the smaller id (p-alpha)", tieThrone[0]?.productId === "p-alpha", String(tieThrone[0]?.productId));
ok("T2 tie-break survives 40 shuffles", (() => {
  for (let i = 0; i < 40; i++) {
    const t = computeInventoryTopValueProducts(shuffle(tieBook, rng), 2);
    if (t[0]?.productId !== "p-alpha" || t[1]?.productId !== "p-zeta") return false;
  }
  return true;
})());

console.log("\n[CAP] take guards — silence, never a partial read");
ok("K1 default take = 2", computeInventoryTopValueProducts(BOOK).length === 2);
ok("K2 take=0 → []", computeInventoryTopValueProducts(BOOK, 0).length === 0);
ok("K3 take=-1 → []", computeInventoryTopValueProducts(BOOK, -1).length === 0);
ok("K4 take=NaN → []", computeInventoryTopValueProducts(BOOK, NaN).length === 0);
ok("K5 take=Infinity → []", computeInventoryTopValueProducts(BOOK, Infinity).length === 0);
ok("K6 take=1.9 floors to 1", computeInventoryTopValueProducts(BOOK, 1.9).length === 1);

console.log("\n[SHAPE] exactly {productId, name, estimatedValueMinor}");
ok("S1 the shape law (3 keys, exact names)", throne.every(
  (e) => JSON.stringify(Object.keys(e)) === JSON.stringify(["productId", "name", "estimatedValueMinor"]),
));

console.log("\n[NEGATIVE] an all-non-positive book still crowns the max HONESTLY");
const negBook: InventoryValuationRow[] = [
  row("p-neg1", "Negative Nina", -2, 100_000), // -200k (negative stock — truthful)
  row("p-zero", "Zero Zed", 0, 100_000), // 0
  row("p-neg2", "Negative Omar", -1, 50_000), // -50k
];
const negThrone = computeInventoryTopValueProducts(negBook, 2);
ok("N1 the max (0, Zero Zed) is crowned verbatim", negThrone[0]?.estimatedValueMinor === 0 && negThrone[0]?.productId === "p-zero",
  JSON.stringify(negThrone[0]));
ok("N2 rank 2 is the next max (-50k, verbatim — never clamped)", negThrone[1]?.estimatedValueMinor === -50_000 && negThrone[1]?.productId === "p-neg2",
  JSON.stringify(negThrone[1]));

console.log("\n[DETERMINISM] 5× identical");
ok("D1 5 runs byte-for-byte", (() => {
  const first = JSON.stringify(computeInventoryTopValueProducts(BOOK, 2));
  for (let i = 0; i < 4; i++) {
    if (JSON.stringify(computeInventoryTopValueProducts([...BOOK].reverse(), 2)) !== first) return false;
  }
  return true;
})());

console.log("\n[WIRING — static] the readers ride the ONE authority");
const reportSrc = readFileSync("src/lib/inventory-valuation-report.ts", "utf8");
ok("W1 buildInventoryValuationReport maps topValueProducts from the filtered set",
  /topValueProducts: computeInventoryTopValueProducts\(matching, 2\)/.test(reportSrc));
ok("W2 the extractor re-sorts through sortInventoryRows VALUE_DESC (one authority by construction)",
  /const ranked = sortInventoryRows\(rows, "VALUE_DESC"\)/.test(reportSrc));
ok("W3 the CSV export builder does NOT change payload shape (no topValueProducts in the export)",
  (() => {
    const m = reportSrc.match(/buildInventoryValuationExport[\s\S]*$/);
    return !!m && !m[0].includes("topValueProducts");
  })());

const panelSrc = readFileSync("src/modules/reports/inventory-valuation-panel.tsx", "utf8");
ok("W4 the panel consumes data.topValueProducts", panelSrc.includes("data.topValueProducts"));
ok("W5 the drill navigates by the STABLE productId (entity route, never the name)",
  /navigate\(\{ kind: "entity", entity: "product", id: row\.productId \}\)/.test(panelSrc));
ok("W6 the share gate is 0<x<=100 (totals > 0 AND row > 0)",
  /data\.totals\.estimatedValueMinor > 0 && row\.estimatedValueMinor > 0/.test(panelSrc));
ok("W7 the share divides by the response's OWN totals (same basis by construction)",
  /row\.estimatedValueMinor \/ data\.totals\.estimatedValueMinor/.test(panelSrc));
ok("W8 rank 1 Trophy / rank 2 Medal (the podium grammar)", panelSrc.includes("top ? Trophy : Medal"));

const dashSrc = readFileSync("src/modules/dashboard/dashboard-view.tsx", "utf8");
ok("W9 the tile leader line takes totalMinor (the SAME route response's total)", /totalMinor: number/.test(dashSrc));
ok("W10 the tile share gate: totalMinor > 0 AND top.outstandingMinor > 0",
  /totalMinor > 0 && top\.outstandingMinor > 0/.test(dashSrc));
ok("W11 the drill is party-scoped when the leader is a real party",
  /partyId: top\.partyId \?\? null/.test(dashSrc));

const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");
const R99_KEYS = [
  "statLeaderShare",
  "statLeaderShareShort",
  "statLeaderTooltipShare",
  "statLeaderTooltipSharePayable",
  "invValTopShare",
  "invValTopTooltip",
  "invValRunnerUpTooltip",
];
for (const k of R99_KEYS) {
  ok(`W12 i18n EN carries ${k}`, new RegExp(`^\\s*${k}:`, "m").test(enSrc));
  ok(`W13 i18n FA carries ${k}`, new RegExp(`^\\s*${k}:`, "m").test(faSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
