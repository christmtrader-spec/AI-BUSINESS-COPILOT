/**
 * scripts/r100-deeplink-unit.ts — R100 UNIT harness.
 *
 * "Every windowed answer can be opened": the performance panel becomes a
 * deep-linkable reports sub-view (#/reports?perf=<kind>&from&to[&direction])
 * and the copilot's windowed answers grow the PERFORMANCE action chips that
 * navigate there PRE-FILTERED. Pure-function assertions — NO database, NO
 * server:
 *
 *   [1] the HASH LAW — the closed perf grammar parses to the closed
 *       sub-state and serializes back byte-identical: closed tokens only
 *       (sales | expenses | cashflow), the window rides ONLY as a complete
 *       ordered YYYY-MM-DD pair (half / inverted / malformed → dropped
 *       wholesale), the direction filter is cashflow-only, every
 *       pre-existing reports/sales sub-state round-trips unchanged
 *       (month / inventory / reorder / overdue / customer regression)
 *   [2] the RE-ENTRY LAW — sameView compares the perf sub-state, so a
 *       second chip with a different window re-enters an ALREADY-MOUNTED
 *       reports view instead of being swallowed as "the same view"
 *   [3] the CHIP PICKER LAW — pickPerfActionChips: one chip per proven
 *       windowed fact (products / expenses / cashflow), the window carried
 *       from the meta's OWN range keys (one authority), a malformed or
 *       inverted persisted range drops the WINDOW but never the chip (the
 *       panel's defaults are the honest fallback), old persisted metas
 *       without counts keep the merch chips and lose only the cashflow one
 *
 * Run: bun scripts/r100-deeplink-unit.ts
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
function eq<T>(actual: T, expected: T, name: string) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

// [1] + [2] — the store grammar ------------------------------------------------

import { hashToView, viewToHash, sameView, type AppView } from "../src/store/app-store";
import { pickPerfActionChips } from "../src/modules/copilot/copilot-view";

function roundTrip(hash: string, expectedView: unknown, name: string) {
  const parsed = hashToView(hash);
  eq(parsed, expectedView, name);
  const out = viewToHash(parsed as AppView);
  ok(`${name} — round-trip`, out === hash, `serialized ${JSON.stringify(out)}`);
}

// [1a] the closed tokens parse and round-trip byte-identical
roundTrip(
  "#/reports?perf=sales",
  { kind: "module", module: "reports", param: "perf-sales" },
  "[1a] perf=sales parses to the closed sub-view",
);
roundTrip(
  "#/reports?perf=expenses",
  { kind: "module", module: "reports", param: "perf-expenses" },
  "[1b] perf=expenses parses",
);
roundTrip(
  "#/reports?perf=cashflow",
  { kind: "module", module: "reports", param: "perf-cashflow" },
  "[1c] perf=cashflow parses (no direction)",
);
roundTrip(
  "#/reports?perf=cashflow&direction=IN",
  { kind: "module", module: "reports", param: "perf-cashflow", perfDirection: "IN" },
  "[1d] cashflow direction=IN parses",
);
roundTrip(
  "#/reports?perf=cashflow&direction=OUT",
  { kind: "module", module: "reports", param: "perf-cashflow", perfDirection: "OUT" },
  "[1e] cashflow direction=OUT parses",
);
roundTrip(
  "#/reports?perf=sales&from=2026-09-25&to=2026-10-24",
  { kind: "module", module: "reports", param: "perf-sales", perfFrom: "2026-09-25", perfTo: "2026-10-24" },
  "[1f] a complete ordered window rides the sub-view",
);
roundTrip(
  "#/reports?perf=cashflow&from=2026-09-25&to=2026-10-24&direction=OUT",
  { kind: "module", module: "reports", param: "perf-cashflow", perfFrom: "2026-09-25", perfTo: "2026-10-24", perfDirection: "OUT" },
  "[1g] window + direction compose on cashflow (canonical order: perf, from, to, direction)",
);

// [1b] the drop laws — never a fake destination
const dropped = (hash: string, expected: unknown, name: string) => {
  const parsed = hashToView(hash);
  eq(parsed, expected, name);
};
dropped(
  "#/reports?perf=garbage",
  { kind: "module", module: "reports" },
  "[1h] an unknown perf token is NOT a sub-view (plain reports)",
);
ok(
  "[1h] unknown perf token serializes to the bare module hash",
  viewToHash(hashToView("#/reports?perf=garbage") as AppView) === "#/reports",
);
dropped(
  "#/reports?perf=1",
  { kind: "module", module: "reports" },
  "[1i] the bare '1' token is dropped (closed vocab — no bare open)",
);
dropped(
  "#/reports?perf=CASHFLOW",
  { kind: "module", module: "reports" },
  "[1j] tokens are case-strict",
);
dropped(
  "#/reports?perf=sales&direction=IN",
  { kind: "module", module: "reports", param: "perf-sales" },
  "[1k] the direction filter is cashflow-only (stray value dropped)",
);
dropped(
  "#/reports?perf=sales&from=2026-09-25",
  { kind: "module", module: "reports", param: "perf-sales" },
  "[1l] a HALF window is dropped wholesale (never one lying boundary)",
);
dropped(
  "#/reports?perf=sales&to=2026-10-24",
  { kind: "module", module: "reports", param: "perf-sales" },
  "[1m] the other half window too",
);
dropped(
  "#/reports?perf=sales&from=2026-10-24&to=2026-09-25",
  { kind: "module", module: "reports", param: "perf-sales" },
  "[1n] an INVERTED window is dropped wholesale",
);
dropped(
  "#/reports?perf=sales&from=garbage&to=2026-10-24",
  { kind: "module", module: "reports", param: "perf-sales" },
  "[1o] a malformed boundary drops the window",
);
dropped(
  "#/reports?perf=cashflow&from=2026-09-25&to=2026-10-24&direction=both",
  { kind: "module", module: "reports", param: "perf-cashflow", perfFrom: "2026-09-25", perfTo: "2026-10-24" },
  "[1p] a garbage direction drops only the direction (the window survives)",
);

// [1c] pre-existing sub-states round-trip UNCHANGED (regression)
roundTrip(
  "#/reports?inventory=1",
  { kind: "module", module: "reports", param: "inventory" },
  "[1q] inventory sub-view unchanged",
);
roundTrip(
  "#/reports?reorder=1",
  { kind: "module", module: "reports", param: "reorder" },
  "[1r] reorder sub-view unchanged",
);
roundTrip(
  "#/reports?month=2026-04",
  { kind: "module", module: "reports", param: "2026-04" },
  "[1s] month drill-down unchanged",
);
roundTrip("#/sales?overdue=1", { kind: "module", module: "sales", overdue: true }, "[1t] sales overdue unchanged");
const withCustomer = hashToView("#/sales?overdue=1&customer=abc123def456");
ok(
  "[1u] sales customer scope unchanged",
  JSON.stringify(withCustomer) === JSON.stringify({ kind: "module", module: "sales", overdue: true, customerId: "abc123def456" }),
  JSON.stringify(withCustomer),
);
eq(viewToHash({ kind: "module", module: "reports" } as AppView), "#/reports", "[1v] bare reports serializes bare");
eq(
  viewToHash({ kind: "module", module: "reports", perfFrom: "2026-01-01", perfTo: "2026-01-31" } as AppView),
  "#/reports",
  "[1w] orphan window fields (no perf param) NEVER serialize — they cannot exist by parser law",
);

// [2] the re-entry law -----------------------------------------------------------
const v = (over: Partial<AppView> = {}) =>
  ({ kind: "module", module: "reports", ...over }) as AppView;
ok("[2a] identical perf sub-state is the same view", sameView(v({ param: "perf-sales", perfFrom: "2026-09-25", perfTo: "2026-10-24" }), v({ param: "perf-sales", perfFrom: "2026-09-25", perfTo: "2026-10-24" })));
ok("[2b] a DIFFERENT window re-enters (second chip, new answer window)", !sameView(v({ param: "perf-sales", perfFrom: "2026-09-25", perfTo: "2026-10-24" }), v({ param: "perf-sales", perfFrom: "2026-10-01", perfTo: "2026-10-24" })));
ok("[2c] window vs no window re-enters", !sameView(v({ param: "perf-sales", perfFrom: "2026-09-25", perfTo: "2026-10-24" }), v({ param: "perf-sales" })));
ok("[2d] a different kind re-enters", !sameView(v({ param: "perf-sales" }), v({ param: "perf-expenses" })));
ok("[2e] direction flip re-enters", !sameView(v({ param: "perf-cashflow", perfDirection: "IN" }), v({ param: "perf-cashflow", perfDirection: "OUT" })));
ok("[2f] plain reports vs perf re-enters", !sameView(v(), v({ param: "perf-sales" })));
ok(
  "[2g] the sales sub-state laws still hold (regression)",
  sameView({ kind: "module", module: "sales", overdue: true } as AppView, { kind: "module", module: "sales", overdue: true } as AppView) &&
    !sameView({ kind: "module", module: "sales", overdue: true } as AppView, { kind: "module", module: "sales" } as AppView),
);

// [3] the chip picker law --------------------------------------------------------
type MetaLike = Parameters<typeof pickPerfActionChips>[0];
const meta = (over: Record<string, unknown>): MetaLike =>
  ({
    days: 30,
    generatedAt: "2026-10-24T00:00:00.000Z",
    timezone: "UTC",
    rangeFrom: "2026-09-25",
    rangeTo: "2026-10-24",
    sections: [],
    counts: {
      sales: 1, expenses: 1, openInvoices: 0, openBills: 0, activeProducts: 1,
      lowStock: 0, topProducts: 1, expenseCategories: 1, timelineDays: 30,
      recentPayments: 2, agedOver60Invoices: 0, pastDueBills: 0, receivablesOverdue: 0,
    },
    topOverdueCustomer: null,
    topAgedOver60Customer: null,
    topPastDueSupplier: null,
    ...over,
  }) as MetaLike;

const BASE_COUNTS = {
  sales: 1, expenses: 1, openInvoices: 0, openBills: 0, activeProducts: 1,
  lowStock: 0, topProducts: 1, expenseCategories: 1, timelineDays: 30,
  recentPayments: 2, agedOver60Invoices: 0, pastDueBills: 0, receivablesOverdue: 0,
};

const chipsFull = pickPerfActionChips(
  meta({ topProduct: { name: "Akar Widget", unitsSold: 3, revenueMinor: 1000000 }, topExpenseCategory: { category: "Rent", totalMinor: 400000 } }),
);
eq(
  chipsFull.map((c) => c.key),
  ["actionPerfProducts", "actionPerfExpenses", "actionPerfCashflow"],
  "[3a] three proven facts → three chips in the deterministic order",
);
ok(
  "[3b] the window is the meta's OWN range keys (one authority)",
  chipsFull.every((c) => c.from === "2026-09-25" && c.to === "2026-10-24"),
);
ok(
  "[3c] the params map kind→kind",
  chipsFull[0].param === "perf-sales" && chipsFull[1].param === "perf-expenses" && chipsFull[2].param === "perf-cashflow",
);

const chipsMerchOnly = pickPerfActionChips(
  meta({ topProduct: { name: "Akar Widget", unitsSold: 3, revenueMinor: 1000000 }, topExpenseCategory: null, counts: undefined }),
);
eq(
  chipsMerchOnly.map((c) => c.key),
  ["actionPerfProducts"],
  "[3d] one proven fact → one chip; counts-undefined (old persisted meta) loses only cashflow",
);

eq(
  pickPerfActionChips(meta({ topProduct: null, topExpenseCategory: null, counts: { ...BASE_COUNTS, recentPayments: 0 } })),
  [],
  "[3e] no proven fact → honest silence",
);
eq(pickPerfActionChips(null), [], "[3f] null meta → []");
eq(pickPerfActionChips(undefined), [], "[3g] undefined meta → []");

const chipsBadRange = pickPerfActionChips(
  meta({ rangeFrom: "not-a-date", rangeTo: "2026-10-24", topProduct: { name: "X", unitsSold: 1, revenueMinor: 1 }, counts: { ...BASE_COUNTS, recentPayments: 0 } }),
);
ok(
  "[3h] a malformed persisted range drops the WINDOW but never the chip",
  chipsBadRange.length === 1 && chipsBadRange[0].from === null && chipsBadRange[0].to === null,
);
const chipsInverted = pickPerfActionChips(
  meta({ rangeFrom: "2026-10-24", rangeTo: "2026-09-25", topExpenseCategory: { category: "Rent", totalMinor: 1 }, counts: { ...BASE_COUNTS, recentPayments: 0 } }),
);
ok(
  "[3i] an inverted range drops the window too",
  chipsInverted.length === 1 && chipsInverted[0].from === null,
);
const chipsZeroPayments = pickPerfActionChips(
  meta({ topProduct: null, topExpenseCategory: null, counts: { ...BASE_COUNTS, recentPayments: 0 } }),
);
eq(chipsZeroPayments, [], "[3j] an empty cash lane (recentPayments 0) renders no cashflow chip");

// ---- summary -------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
