/**
 * scripts/prompt51-inventory-valuation-unit.ts — Prompt 51 UNIT harness.
 *
 * Pure-function assertions over the detailed inventory valuation service
 * (src/lib/inventory-valuation-report.ts) — NO database, NO server:
 *
 *   [1] row state semantics — zero/low/positive/negative stock, zero cost
 *       is a measured state (never auto-criminalized), corrupt integers
 *   [2] filter law — every closed combination, q normalization, no-match
 *   [3] sort law — all 7 sorts, deterministic id tie-break, duplicate
 *       names never merge, identical values never flip
 *   [4] aggregate law — exact sums, cost-quality counts, row/total
 *       reconciliation (Gate D row law)
 *   [5] query parsing — closed vocabularies, invalid enums rejected,
 *       q length bound, page/pageSize bounds
 *   [6] safe-integer arithmetic — overflow raises a controlled integrity
 *       error (never a silent wrong total)
 *   [7] filtersActive — the UI label contract
 *   [8] reconciliation law — default-filter totals == ALL-product totals
 *       (the summary reconciliation contract, mirrored in E2E)
 *   [9] EN/FA parity — the new invVal* keys + anti-P&L/valuation wording
 *
 * Run: bun scripts/prompt51-inventory-valuation-unit.ts
 */

import { createRequire } from "node:module";
import path from "node:path";

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
function throws(name: string, fn: () => unknown, Err?: new (...a: never[]) => Error) {
  try {
    fn();
    ok(name, false, "did not throw");
  } catch (e) {
    ok(name, Err ? e instanceof Err : true, e instanceof Error ? e.message : String(e));
  }
}

import {
  INVENTORY_ACTIVITIES,
  INVENTORY_COST_STATES,
  INVENTORY_SORTS,
  INVENTORY_STOCK_STATES,
  computeInventoryTotals,
  filterInventoryRows,
  inventoryFiltersActive,
  parseInventoryFilters,
  parseInventoryPage,
  rowCostState,
  rowStockState,
  sortInventoryRows,
  type InventoryValuationRow,
} from "../src/lib/inventory-valuation-report";
import { ReportIntegrityError, ReportRangeError, safeAdd, safeMul } from "../src/lib/report-periods";

/** Fixture factory — stable ids make tie-breaks observable. */
let seq = 0;
function row(over: Partial<InventoryValuationRow> = {}): InventoryValuationRow {
  seq += 1;
  const id = over.id ?? `prod-${String(seq).padStart(3, "0")}`;
  const stockQty = over.stockQty ?? 10;
  const costPriceMinor = over.costPriceMinor ?? 500;
  return {
    id,
    name: over.name ?? `Widget ${seq}`,
    sku: over.sku ?? `SKU-${seq}`,
    unit: over.unit ?? "piece",
    stockQty,
    costPriceMinor,
    isActive: over.isActive ?? true,
    lowStockAt: over.lowStockAt ?? 5,
    estimatedValueMinor: over.estimatedValueMinor ?? stockQty * costPriceMinor,
    stockState: over.stockState ?? rowStockState(stockQty, over.lowStockAt ?? 5),
    costState: over.costState ?? rowCostState(costPriceMinor),
  };
}

console.log("[1] row state semantics");
{
  eq(rowStockState(0, 5), "ZERO_STOCK", "1a. zero stock is ZERO_STOCK");
  eq(rowStockState(1, 5), "LOW_STOCK", "1b. 1 ≤ threshold 5 is LOW_STOCK");
  eq(rowStockState(5, 5), "LOW_STOCK", "1c. at-threshold is LOW_STOCK (alert convention)");
  eq(rowStockState(6, 5), "POSITIVE_STOCK", "1d. above threshold is POSITIVE_STOCK");
  eq(rowStockState(-3, 5), "NEGATIVE_STOCK", "1e. negative stock is NEGATIVE_STOCK (never hidden)");
  eq(rowStockState(0, 0), "ZERO_STOCK", "1f. zero threshold, zero stock");
  eq(rowStockState(1, 0), "POSITIVE_STOCK", "1g. qty 1 > threshold 0 is above threshold → POSITIVE_STOCK");
  throws("1h. non-integer quantity is a controlled integrity error", () => rowStockState(1.5, 5), ReportIntegrityError);
  eq(rowCostState(500), "POSITIVE_COST", "1i. positive cost");
  eq(rowCostState(0), "ZERO_COST", "1j. ZERO cost is a measured state, not an error");
  throws("1k. non-integer cost is a controlled integrity error", () => rowCostState(1.5), ReportIntegrityError);
  // Zero-cost-positive-stock is REVIEW, never "error":
  const zc = row({ stockQty: 7, costPriceMinor: 0 });
  eq(zc.estimatedValueMinor, 0, "1l. zero cost × positive stock = a calculated 0 (not unknown)");
  eq(zc.stockState, "POSITIVE_STOCK", "1m. zero-cost row still carries its truthful stock state (7 > 5)");
}

console.log("[2] filter law — closed combinations");
{
  const rows = [
    row({ id: "a", name: "Alpha", sku: "SKU-A", stockQty: 10, costPriceMinor: 500, isActive: true }), // 5000
    row({ id: "b", name: "alpha twin", sku: "SKU-B", stockQty: 0, costPriceMinor: 500, isActive: false }), // 0
    row({ id: "c", name: "Beta free", sku: null, stockQty: 3, costPriceMinor: 0, isActive: true, lowStockAt: 5 }), // 0, low
    row({ id: "d", name: "Gamma", sku: "SKU-D", stockQty: 0, costPriceMinor: 0, isActive: true }), // 0
    row({ id: "e", name: "Déjà Vu", sku: "SKU-E", stockQty: -2, costPriceMinor: 500, isActive: false }), // -1000
  ];
  const F = parseInventoryFilters({ get: () => null });
  eq(filterInventoryRows(rows, F).length, 5, "2a. default filters include everything (inactive too)");

  eq(
    filterInventoryRows(rows, { ...F, costState: "POSITIVE_COST" }).map((r) => r.id),
    ["a", "b", "e"],
    "2b. POSITIVE_COST excludes zero-cost rows",
  );
  eq(
    filterInventoryRows(rows, { ...F, costState: "ZERO_COST" }).map((r) => r.id),
    ["c", "d"],
    "2c. ZERO_COST selects measured zero-cost rows",
  );
  eq(
    filterInventoryRows(rows, { ...F, stockState: "POSITIVE_STOCK" }).map((r) => r.id),
    ["a"],
    "2d. POSITIVE_STOCK is strictly above threshold",
  );
  eq(
    filterInventoryRows(rows, { ...F, stockState: "ZERO_STOCK" }).map((r) => r.id),
    ["b", "d"],
    "2e. ZERO_STOCK excludes low/negative",
  );
  eq(
    filterInventoryRows(rows, { ...F, stockState: "LOW_STOCK" }).map((r) => r.id),
    ["c"],
    "2f. LOW_STOCK is (0, threshold]",
  );
  eq(
    filterInventoryRows(rows, { ...F, activity: "ACTIVE" }).every((r) => r.isActive),
    true,
    "2g. ACTIVE filter excludes inactive rows",
  );
  eq(
    filterInventoryRows(rows, { ...F, activity: "INACTIVE" }).map((r) => r.id),
    ["b", "e"],
    "2h. INACTIVE filter selects only inactive rows",
  );
  eq(
    filterInventoryRows(rows, { ...F, q: "alpha" }).map((r) => r.id),
    ["a", "b"],
    "2i. q matches name case-insensitively (pre-normalized input)",
  );
  eq(
    filterInventoryRows(rows, { ...F, q: "sku-e" }).map((r) => r.id),
    ["e"],
    "2j. q matches SKU",
  );
  eq(filterInventoryRows(rows, { ...F, q: "déjà" }).map((r) => r.id), ["e"], "2k. q matches unicode names");
  eq(filterInventoryRows(rows, { ...F, q: "zzz-none" }).length, 0, "2l. no-match is empty");
  eq(
    filterInventoryRows(rows, { ...F, q: "beta", costState: "ZERO_COST", stockState: "LOW_STOCK", activity: "ACTIVE" }).map((r) => r.id),
    ["c"],
    "2m. combined filters AND together",
  );
  eq(
    filterInventoryRows(rows, { ...F, stockState: "ZERO_STOCK", costState: "POSITIVE_COST" }).map((r) => r.id),
    ["b"],
    "2n. zero stock + positive cost combination",
  );
}

console.log("[3] sort law — deterministic, id tie-break");
{
  const rows = [
    row({ id: "zzz", name: "Same", stockQty: 10, costPriceMinor: 500 }), // 5000
    row({ id: "aaa", name: "Same", stockQty: 10, costPriceMinor: 500 }), // 5000 (identical value+name+qty+cost)
    row({ id: "mmm", name: "Zeta", stockQty: 10, costPriceMinor: 500 }), // 5000
    row({ id: "big", name: "Alpha", stockQty: 100, costPriceMinor: 900 }), // 90000
    row({ id: "neg", name: "Beta", stockQty: -1, costPriceMinor: 500 }), // -500
    row({ id: "zero", name: "Gamma", stockQty: 0, costPriceMinor: 12345 }), // 0
  ];
  const ids = (sort: (typeof INVENTORY_SORTS)[number]) => sortInventoryRows(rows, sort).map((r) => r.id);

  eq(ids("VALUE_DESC"), ["big", "aaa", "mmm", "zzz", "zero", "neg"], "3a. VALUE_DESC with id tie-break (aaa<mmm<zzz)");
  eq(ids("VALUE_ASC"), ["neg", "zero", "aaa", "mmm", "zzz", "big"], "3b. VALUE_ASC with id tie-break");
  eq(ids("NAME_ASC"), ["big", "neg", "zero", "aaa", "zzz", "mmm"], "3c. NAME_ASC code-point order + id tie-break (Same×3 → aaa,zzz)");
  eq(ids("NAME_DESC"), ["mmm", "aaa", "zzz", "zero", "neg", "big"], "3d. NAME_DESC: Zeta first, Same ties stay id-ascending");
  eq(ids("QUANTITY_DESC"), ["big", "aaa", "mmm", "zzz", "zero", "neg"], "3e. QUANTITY_DESC tie-break by id (0 before -1)");
  eq(ids("QUANTITY_ASC"), ["neg", "zero", "aaa", "mmm", "zzz", "big"], "3f. QUANTITY_ASC");
  eq(ids("COST_DESC"), ["zero", "big", "aaa", "mmm", "neg", "zzz"], "3g. COST_DESC tie-break by id (500-cost rows aaa<mmm<neg<zzz)");
  // Determinism: same input → same output, twice.
  eq(ids("VALUE_DESC"), ids("VALUE_DESC"), "3h. repeated sort is deterministic");
  // The input array is never mutated.
  eq(rows[0].id, "zzz", "3i. sort does not mutate the input");
  // Duplicate display names NEVER merge into one row (identity law).
  const sorted = sortInventoryRows(rows, "NAME_ASC");
  eq(sorted.filter((r) => r.name === "Same").length, 2, "3j. identical names stay 2 distinct rows (never merged)");
}

console.log("[4] aggregate law + reconciliation");
{
  const rows = [
    row({ id: "a", stockQty: 10, costPriceMinor: 500, isActive: true }), // 5000
    row({ id: "b", stockQty: 0, costPriceMinor: 500, isActive: false }), // 0
    row({ id: "c", stockQty: 3, costPriceMinor: 0, isActive: true, lowStockAt: 5 }), // 0, zero-cost positive
    row({ id: "d", stockQty: -2, costPriceMinor: 500, isActive: false }), // -1000
    row({ id: "e", stockQty: 2, costPriceMinor: 250, isActive: true, lowStockAt: 5 }), // 500, low
  ];
  const totals = computeInventoryTotals(rows);
  eq(totals.estimatedValueMinor, 4500, "4a. total = Σ row values (5000+0+0-1000+500)");
  eq(totals.productCount, 5, "4b. productCount");
  eq(totals.positiveStockCount, 3, "4c. positive stock count (a, c, e)");
  eq(totals.zeroStockCount, 1, "4d. zero stock count");
  eq(totals.negativeStockCount, 1, "4e. negative stock count (truthful data quality)");
  eq(totals.zeroCostPositiveStockCount, 1, "4f. positive-stock zero-cost count");
  eq(totals.inactiveCount, 2, "4g. inactive count");
  eq(totals.lowStockCount, 2, "4h. low stock count (c + e)");
  const rowSum = rows.reduce((s, r) => s + r.estimatedValueMinor, 0);
  eq(totals.estimatedValueMinor, rowSum, "4i. SUM(rows) == total (Gate D row law)");
  eq(computeInventoryTotals([]).estimatedValueMinor, 0, "4j. empty set → zero total (never NaN)");
  eq(computeInventoryTotals([]).productCount, 0, "4k. empty set → zero count");
  // Exactness under a value boundary.
  const big = [row({ id: "x", stockQty: 1_000_000, costPriceMinor: 8_000_000_000 })];
  eq(computeInventoryTotals(big).estimatedValueMinor, 8_000_000_000_000_000, "4l. large exact product (8e15 < 2^53)");
  throws("4m. beyond safe range → controlled integrity error", () => computeInventoryTotals(big.concat(big)), ReportIntegrityError);
}

console.log("[5] query parsing — closed vocab + bounds");
{
  const P = (o: Record<string, string>) => parseInventoryFilters({ get: (k) => o[k] ?? null });
  eq(P({}).sort, "VALUE_DESC", "5a. default sort");
  eq(P({}).costState, "ALL", "5b. default costState");
  eq(P({}).stockState, "ALL", "5c. default stockState");
  eq(P({}).activity, "ALL", "5d. default activity");
  eq(P({}).q, null, "5e. empty q → null");
  eq(P({ q: "Widget" }).q, "widget", "5f. q lowercased");
  eq(P({ q: "  pad  " }).q, "pad", "5g. q trimmed");
  throws("5h. invalid sort rejected", () => P({ sort: "MAGIC" }), ReportRangeError);
  throws("5i. invalid costState rejected", () => P({ costState: "FREE" }), ReportRangeError);
  throws("5j. invalid stockState rejected", () => P({ stockState: "SOME" }), ReportRangeError);
  throws("5k. invalid activity rejected", () => P({ activity: "GHOST" }), ReportRangeError);
  throws("5l. over-length q rejected", () => P({ q: "x".repeat(81) }), ReportRangeError);
  eq(P({ q: "x".repeat(80) }).q, "x".repeat(80), "5m. exactly-80-char q accepted");
  for (const s of INVENTORY_SORTS) eq(P({ sort: s }).sort, s, `5n. sort ${s} accepted`);
  for (const c of INVENTORY_COST_STATES) eq(P({ costState: c }).costState, c, `5o. costState ${c} accepted`);
  for (const s of INVENTORY_STOCK_STATES) eq(P({ stockState: s }).stockState, s, `5p. stockState ${s} accepted`);
  for (const a of INVENTORY_ACTIVITIES) eq(P({ activity: a }).activity, a, `5q. activity ${a} accepted`);

  const PP = (o: Record<string, string>) => parseInventoryPage({ get: (k) => o[k] ?? null });
  eq(PP({}), { page: 1, pageSize: 25 }, "5r. default page/pageSize");
  eq(PP({ page: "3", pageSize: "50" }), { page: 3, pageSize: 50 }, "5s. valid page/pageSize");
  eq(PP({ pageSize: "100" }).pageSize, 100, "5t. pageSize 100 accepted");
  throws("5u. pageSize 101 rejected", () => PP({ pageSize: "101" }), ReportRangeError);
  throws("5v. pageSize 0 rejected", () => PP({ pageSize: "0" }), ReportRangeError);
  throws("5w. non-integer pageSize rejected", () => PP({ pageSize: "abc" }), ReportRangeError);
  throws("5x. negative page rejected", () => PP({ page: "-1" }), ReportRangeError);
  throws("5y. page 0 rejected", () => PP({ page: "0" }), ReportRangeError);
  throws("5z. float page rejected", () => PP({ page: "1.5" }), ReportRangeError);
}

console.log("[6] safe-integer arithmetic (money law)");
{
  eq(safeMul(10, 500, "value"), 5000, "6a. exact multiplication");
  eq(safeMul(0, 500, "value"), 0, "6b. zero quantity");
  eq(safeMul(7, 0, "value"), 0, "6c. zero cost");
  eq(safeMul(-2, 500, "value"), -1000, "6d. negative quantity stays signed (never clamped)");
  throws("6e. multiplication overflow → integrity error", () => safeMul(2 ** 30, 2 ** 33, "value"), ReportIntegrityError);
  throws("6f. non-integer factor → integrity error", () => safeMul(1.5, 100, "value"), ReportIntegrityError);
  throws("6g. aggregation overflow → integrity error", () => safeAdd(2 ** 53 - 1, 1, "total"), ReportIntegrityError);
  throws("6h. non-integer aggregate → integrity error", () => safeAdd(1.5, 1, "total"), ReportIntegrityError);
}

console.log("[7] filtersActive label contract");
{
  eq(inventoryFiltersActive(parseInventoryFilters({ get: () => null })), false, "7a. defaults are inactive");
  eq(inventoryFiltersActive(parseInventoryFilters({ get: (k) => (k === "q" ? "x" : null) })), true, "7b. q activates");
  eq(inventoryFiltersActive(parseInventoryFilters({ get: (k) => (k === "sort" ? "NAME_ASC" : null) })), false, "7c. sort alone does NOT activate");
  eq(inventoryFiltersActive(parseInventoryFilters({ get: (k) => (k === "activity" ? "ACTIVE" : null) })), true, "7d. activity activates");
  eq(inventoryFiltersActive(parseInventoryFilters({ get: (k) => (k === "costState" ? "ZERO_COST" : null) })), true, "7e. costState activates");
  eq(inventoryFiltersActive(parseInventoryFilters({ get: (k) => (k === "stockState" ? "LOW_STOCK" : null) })), true, "7f. stockState activates");
}

console.log("[8] reconciliation law — filters commute with totals");
{
  // With NO filters the report totals must equal the totals of the whole
  // population (the summary reconciliation contract, Gate D).
  const rows = [
    row({ id: "a", stockQty: 4, costPriceMinor: 2500, isActive: true }),
    row({ id: "b", stockQty: 0, costPriceMinor: 999, isActive: true }),
    row({ id: "c", stockQty: 9, costPriceMinor: 0, isActive: false }),
  ];
  const all = computeInventoryTotals(filterInventoryRows(rows, parseInventoryFilters({ get: () => null })));
  eq(all.estimatedValueMinor, 10000, "8a. unfiltered total == Σ all rows (summary contract)");
  eq(all.productCount, 3, "8b. unfiltered count == all products (inactive included)");
  // Filtering to ACTIVE drops only the inactive product's contribution.
  const active = computeInventoryTotals(filterInventoryRows(rows, parseInventoryFilters({ get: (k) => (k === "activity" ? "ACTIVE" : null) })));
  eq(active.estimatedValueMinor, 10000, "8c. inactive row contributed 0 → active total unchanged here");
  const inactive = computeInventoryTotals(filterInventoryRows(rows, parseInventoryFilters({ get: (k) => (k === "activity" ? "INACTIVE" : null) })));
  eq(inactive.estimatedValueMinor, 0, "8d. the inactive row contributes 0 value here");
  eq(inactive.productCount, 1, "8e. INACTIVE count == exactly the inactive row");
  // ZERO_COST with positive stock — the review population.
  const review = filterInventoryRows(rows, parseInventoryFilters({ get: (k) => (k === "costState" ? "ZERO_COST" : null) }));
  eq(review.length, 1, "8f. zero-cost population has exactly 1 row");
  eq(review[0]?.stockQty > 0, true, "8g. the zero-cost row is positive-stock (the review population)");
}

console.log("[9] EN/FA parity — invVal keys + valuation wording (Gate J)");
{
  const esmRequire = createRequire(path.join(process.cwd(), "package.json"));
  const enMod = esmRequire("./src/i18n/messages/en") as { default: Record<string, unknown> };
  const faMod = esmRequire("./src/i18n/messages/fa") as { default: Record<string, unknown> };
  const enReports = enMod.default.reports as Record<string, unknown>;
  const faReports = faMod.default.reports as Record<string, unknown>;
  const invValKeys = Object.keys(enReports).filter((k) => k.startsWith("invVal"));
  ok("9a. Prompt 51 invVal* keys exist in EN", invValKeys.length >= 40, `count=${invValKeys.length}`);
  ok(
    "9b. every invVal key exists in FA",
    invValKeys.every((k) => k in faReports),
    invValKeys.filter((k) => !(k in faReports)).join(","),
  );
  const faVal = invValKeys.filter((k) => k in faReports).map((k) => String(faReports[k]));
  ok(
    "9c. every FA invVal value contains Persian script (no untranslated EN literals)",
    faVal.every((v) => /[\u0600-\u06FF]/.test(v)),
    faVal.filter((v) => !/[\u0600-\u06FF]/.test(v)).join(" | "),
  );
  // Valuation-basis disclosure exists in BOTH locales and makes no
  // accounting claims.
  ok("9d. EN basis disclosure present", typeof enReports.invValBasis === "string" && /operational/i.test(String(enReports.invValBasis)));
  ok("9e. FA basis disclosure present", typeof faReports.invValBasis === "string" && String(faReports.invValBasis).length > 10);
  // Zero-cost notice is neutral in both locales (mentions error only to
  // DENY it — never accuses, never claims auto-detection).
  ok(
    "9f. EN zero-cost notice never accuses or claims auto-detection",
    !/incorrect|invalid|missing cost|detected|flagged as|fix these/i.test(String(enReports.invValZeroCostNotice)),
    String(enReports.invValZeroCostNotice),
  );
  // The valuation UI never claims accounting concepts (EN + FA).
  const enJoined = invValKeys.map((k) => String(enReports[k])).join(" ").toLowerCase();
  ok(
    "9g. EN invVal keys never claim FIFO/LIFO/balance-sheet/COGS/profit",
    !/fifo|lifo|weighted[- ]average|balance[- ]sheet|cost of goods|gross profit|net profit/.test(enJoined),
  );
  const faJoined = invValKeys.filter((k) => k in faReports).map((k) => String(faReports[k])).join(" ");
  ok("9h. FA invVal keys never claim سود (profit)", !faJoined.includes("سود"));
  ok("9i. FA invVal keys never claim ترازنامه (balance sheet)", !faJoined.includes("ترازنامه"));
  // Interpolation contracts identical.
  const paramRe = /\{(\w+)\}/g;
  const bad: string[] = [];
  for (const k of invValKeys) {
    const en = String(enReports[k]);
    const fa = String(faReports[k] ?? "");
    const ep = [...en.matchAll(paramRe)].map((m) => m[1]).sort().join(",");
    const fp = [...fa.matchAll(paramRe)].map((m) => m[1]).sort().join(",");
    if (ep !== fp) bad.push(k);
  }
  ok("9j. interpolation params identical across EN/FA", bad.length === 0, bad.join(","));
}

// ---------------------------------------------------------------------------
// [10] P51-R1 — EXACT money serialization for the inventory CSV boundary.
// The export route must serialize minor units via the shared exact
// serializer (formatMinorToDecimal, src/lib/data-portability/money-csv) —
// never via a float round-trip (the old fromMinor().toFixed() printed
// 90071992547400.02 for the exact 90071992547400.01 — verified before the
// fix). These cases pin the serializer contract itself; the LIVE endpoint
// case runs in prompt51-inventory-valuation-check.mjs (P51-R1 section).
// ---------------------------------------------------------------------------
{
  const { formatMinorToDecimal, parseDecimalToMinor, MoneyParseError } = await import(
    "../src/lib/data-portability/money-csv"
  );

  // Case A — the reported precision-loss example (exact, no float drift).
  ok("10a. precision-loss boundary 9007199254740001@2 → '90071992547400.01'", formatMinorToDecimal(9007199254740001, 2) === "90071992547400.01");
  // The old float path provably differed at this boundary (documented in
  // the worklog): (9007199254740001 / 100).toFixed(2) === "90071992547400.02".
  ok("10b. the lossy float path WOULD differ here (guard evidence)", (9007199254740001 / 100).toFixed(2) !== formatMinorToDecimal(9007199254740001, 2));
  // Case B — ordinary amount.
  ok("10c. ordinary 17100@2 → '171.00'", formatMinorToDecimal(17100, 2) === "171.00");
  // Case C — zero.
  ok("10d. zero 0@2 → '0.00'", formatMinorToDecimal(0, 2) === "0.00");
  // Case D — negative sign handling (contract: leading minus, no sign drift).
  ok("10e. negative -12550@2 → '-125.50'", formatMinorToDecimal(-12550, 2) === "-125.50");
  ok("10f. negative zero-decimal -5@0 → '-5'", formatMinorToDecimal(-5, 0) === "-5");
  // Case E — zero-decimal currency fabricates no decimal places.
  ok("10g. 0-decimal 17100@0 → '17100' (no '.00' fabricated)", formatMinorToDecimal(17100, 0) === "17100");
  // Case F — a supported precision other than 2 (contract range 0..4).
  ok("10h. 4-decimal 17100@4 → '1.7100'", formatMinorToDecimal(17100, 4) === "1.7100");
  // Case G — maximum safe integer stays exact (no exponent, no rounding).
  const maxStr = formatMinorToDecimal(Number.MAX_SAFE_INTEGER, 2);
  ok("10i. MAX_SAFE_INTEGER@2 → '90071992547409.91'", maxStr === "90071992547409.91");
  ok("10j. never exponent notation", !/e/i.test(maxStr));
  // Case H — invalid inputs keep the established validation behavior
  // (MoneyParseError — the helper is NOT weakened for these cases).
  // NOTE: a literal like 9007199254740001.5 is NOT a valid case — doubles
  // near 2^53 have ulp=1 so it silently becomes the integer ...002 at
  // parse time; a genuinely non-integer value must be small enough to be
  // exactly representable (e.g. 12550.5).
  throws("10k. non-integer minor rejected", () => formatMinorToDecimal(12550.5, 2), MoneyParseError);
  throws("10l. unsafe integer rejected", () => formatMinorToDecimal(Number.MAX_SAFE_INTEGER + 1, 2), MoneyParseError);
  throws("10m. NaN rejected", () => formatMinorToDecimal(Number.NaN, 2), MoneyParseError);
  // Round-trip: the exact string parses back to the identical minor unit.
  ok("10n. case A round-trips via parseDecimalToMinor", parseDecimalToMinor(formatMinorToDecimal(9007199254740001, 2), 2) === 9007199254740001);
  ok("10o. case G round-trips via parseDecimalToMinor", parseDecimalToMinor(formatMinorToDecimal(Number.MAX_SAFE_INTEGER, 2), 2) === Number.MAX_SAFE_INTEGER);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
