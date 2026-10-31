/**
 * scripts/r156-month-drill-check.ts — R156 harness.
 *
 * THE MONTH ROWS FIND THEIR LISTS: the perf panel's LAST drill-less
 * navigable rows — the day/month groupings — split by honesty. A MONTH row
 * opens the module's OWN workspace pre-filtered to that month (the Prompt 51
 * month deep-link grammar, the value IS the filter — sales R87/R88 compose,
 * expenses R148 chip + R155 compose); a DAY row keeps honest SILENCE (the
 * modules' filters are month-shaped — a day row landing on a month view
 * would INFLATE the row's scope; the R152 tint law: the tint is honest
 * BECAUSE the row navigates, a silent row stays silent).
 *
 *   [1] the SALES MONTH LAW — navigate({module:"sales", param: row.month})
 *       through the store's ONE hash builder (never a hand-built
 *       #/sales?…), the honest tint, the day table silent.
 *   [2] the EXPENSES MONTH LAW — navigate({module:"expenses",
 *       param: row.month}), the same silence on its day table.
 *   [3] the HINT LAW — ONE hint per month table AFTER its own table
 *       (the R152 grammar), each testid distinct, each scoped to its
 *       branch only.
 *   [4] the i18n LAW — EN + FA symmetric, non-empty, the FA hint frame
 *       (ردیفی را باز کنید + میز کار), the hint keys used exactly once.
 *   [5] the STORE LAW — the deep links the drill rides are already parsed
 *       (Prompt 51 sales month branch + the generic module ?month=), the
 *       builder serializes param → ?month= (sales canonical order intact),
 *       the R155 category compose untouched.
 *   [6] the REGRESSION PIN — the R155 category drill intact, the seven
 *       navigable tables' honest hover, the R152 reorder precedent, the
 *       motion-safety sweep tool present (the R156 audit closed app-wide).
 *
 * Run: bun scripts/r156-month-drill-check.ts
 */

import { readFileSync } from "node:fs";
import { viewToHash, hashToView, type AppView } from "../src/store/app-store";

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

const perfSrc = readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const reorderSrc = readFileSync("src/modules/reports/reorder-panel.tsx", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

/** Extract a source segment between two anchors (first occurrences). */
function segment(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a === -1) return "";
  const b = src.indexOf(to, a + from.length);
  return b === -1 ? src.slice(a) : src.slice(a, b + to.length);
}

// ==== [1] the SALES MONTH LAW ==============================================
section("[1] the SALES MONTH LAW — the month row opens the Sales workspace");

const salesMonthBranch = segment(
  perfSrc,
  'r.groupBy === "month" ?',
  'perf-sales-month-drill-hint',
);
ok("1a the sales month branch exists", salesMonthBranch.includes('r.groupBy === "month"'));
ok(
  "1b navigate rides the store (module:sales, param:row.month)",
  salesMonthBranch.includes('navigate({ kind: "module", module: "sales", param: row.month })'),
);
ok(
  "1c never a hand-built hash (no #/sales? literal in the panel)",
  !perfSrc.includes('"#/sales?'),
);
ok(
  "1d the month table carries the honest tint (the R152 unification string)",
  salesMonthBranch.includes(
    "transition-colors hover:bg-muted/40 motion-reduce:transition-none",
  ),
);
ok(
  "1e the month rows filter to their own dimension",
  salesMonthBranch.includes('g.dimension === "month"') &&
    salesMonthBranch.includes("getRowId={(row) => row.month}"),
);

const salesDayBranch = segment(
  perfSrc,
  'the DAY rows keep honest SILENCE',
  'getRowId={(row) => row.date}',
);
ok("1f the sales day branch exists (the split is real)", salesDayBranch.length > 0);
// Comment text mentions the law — strip line comments before the structural check.
const salesDayCode = salesDayBranch.replace(/^\s*\/\/.*$/gm, "");
ok(
  "1g the day table keeps honest silence (NO onRowClick, NO tint)",
  !salesDayCode.includes("onRowClick") && !salesDayCode.includes("rowClassName"),
);

// ==== [2] the EXPENSES MONTH LAW ===========================================
section("[2] the EXPENSES MONTH LAW — the same grammar on the expenses side");

const expMonthBranch = segment(
  perfSrc,
  'the expenses month rows join the same law',
  'perf-expenses-month-drill-hint',
);
ok("2a the expenses month branch exists", expMonthBranch.length > 0);
ok(
  "2b navigate rides the store (module:expenses, param:row.month)",
  expMonthBranch.includes('navigate({ kind: "module", module: "expenses", param: row.month })'),
);
ok(
  "2c the expenses month table carries the honest tint",
  expMonthBranch.includes(
    "transition-colors hover:bg-muted/40 motion-reduce:transition-none",
  ),
);
const expDayBranch = segment(
  perfSrc,
  'the expenses DAY rows keep the same honest SILENCE',
  'getRowId={(row) => row.date}',
);
const expDayCode = expDayBranch.replace(/^\s*\/\/.*$/gm, "");
ok(
  "2d the expenses day table keeps the same honest silence",
  expDayBranch.length > 0 &&
    !expDayCode.includes("onRowClick") &&
    !expDayCode.includes("rowClassName"),
);

// ==== [3] the HINT LAW =====================================================
section("[3] the HINT LAW — ONE honest hint per month table, after its own table");

ok(
  "3a both hint testids exist (distinct per surface)",
  perfSrc.includes('data-testid="perf-sales-month-drill-hint"') &&
    perfSrc.includes('data-testid="perf-expenses-month-drill-hint"'),
);
ok(
  "3b both hint keys render through t()",
  perfSrc.includes('t("perfSalesMonthDrillHint")') &&
    perfSrc.includes('t("perfExpensesMonthDrillHint")'),
);
ok(
  "3c the sales hint sits AFTER its own month table (the R152 grammar)",
  perfSrc.indexOf("perf-sales-month-drill-hint") >
    perfSrc.indexOf('getRowId={(row) => row.month}'),
);
const expHintPos = perfSrc.indexOf("perf-expenses-month-drill-hint");
const expTablePos = perfSrc.indexOf('getRowId={(row) => row.month}', perfSrc.indexOf("the expenses month rows join the same law"));
ok("3d the expenses hint sits AFTER its own month table", expHintPos > expTablePos);
ok(
  "3e each hint key used EXACTLY once (scoped to its branch)",
  (perfSrc.match(/perfSalesMonthDrillHint/g) ?? []).length === 1 &&
    (perfSrc.match(/perfExpensesMonthDrillHint/g) ?? []).length === 1,
);

// ==== [4] the i18n LAW =====================================================
section("[4] the i18n LAW — EN + FA symmetric, the Persian hint frame");

ok(
  "4a EN carries both hints, non-empty",
  enSrc.includes('perfSalesMonthDrillHint: "Open a row to work that month in the Sales workspace."') &&
    enSrc.includes('perfExpensesMonthDrillHint: "Open a row to work that month in the Expenses workspace."'),
);
ok(
  "4b FA carries both hints (the family frame: ردیفی را باز کنید + میز کار)",
  faSrc.includes("perfSalesMonthDrillHint: \"برای کارکردن روی همان ماه در میز کار فروش ردیفی را باز کنید.\"") &&
    faSrc.includes("perfExpensesMonthDrillHint: \"برای کارکردن روی همان ماه در میز کار هزینه‌ها ردیفی را باز کنید.\""),
);
ok(
  "4c the hints are plain strings (no interpolation placeholders on either side)",
  !/perfSalesMonthDrillHint:[^\n]*\{[a-z]/.test(enSrc) &&
    !/perfExpensesMonthDrillHint:[^\n]*\{[a-z]/.test(enSrc) &&
    !/perfSalesMonthDrillHint:[^\n]*\{[a-z]/.test(faSrc),
);

// ==== [5] the STORE LAW ====================================================
section("[5] the STORE LAW — the deep links the drill rides already parse");

// The builder: the generic module branch serializes param → ?month=.
ok(
  "5a the hash builder serializes param → ?month= (the generic branch)",
  storeSrc.includes("return `#/${view.module}?month=${view.param}`;"),
);
// The sales canonical order (R87/R88) untouched.
ok(
  "5b the sales canonical order stands (month → overdue → customer)",
  storeSrc.includes("R87/R88 — canonical sales order: month → overdue → customer"),
);
// Prompt 51 parse: ?month= opens sales into the month filter.
ok(
  "5c the sales ?month= parse branch exists (the Prompt 51 Open-in-Sales grammar)",
  storeSrc.includes("if (month && /^\\d{4}-\\d{2}$/.test(month)) {"),
);
// Round-trip: a sales month view survives hash → view → hash.
const monthView: AppView = { kind: "module", module: "sales", param: "2026-10" };
const monthHash = viewToHash(monthView);
const roundTrip = hashToView(monthHash);
ok(
  "5d the sales month deep link round-trips (hash → view → hash)",
  monthHash === "#/sales?month=2026-10" &&
    roundTrip.kind === "module" &&
    roundTrip.module === "sales" &&
    roundTrip.param === "2026-10",
  monthHash,
);
// Expenses month round-trip too (the R148 chip surface).
const expMonthView: AppView = { kind: "module", module: "expenses", param: "2026-09" };
const expHash = viewToHash(expMonthView);
const expTrip = hashToView(expHash);
ok(
  "5e the expenses month deep link round-trips",
  expHash === "#/expenses?month=2026-09" &&
    expTrip.kind === "module" &&
    expTrip.module === "expenses" &&
    expTrip.param === "2026-09",
  expHash,
);
// The R155 compose untouched (the category facet still parses + serializes).
ok(
  "5f the R155 category compose untouched (the facet law stands)",
  storeSrc.includes("R155 — the expenses-only category facet") &&
    storeSrc.includes("Composes with ?month= (both"),
);

// ==== [6] the REGRESSION PIN ===============================================
section("[6] the REGRESSION PIN — the panel's family laws after the split");

ok(
  "6a the R155 category drill intact (facet navigation + its hint)",
  perfSrc.includes('navigate({ kind: "module", module: "expenses", category: row.category })') &&
    perfSrc.includes('data-testid="perf-category-drill-hint"'),
);
ok(
  "6b ALL SEVEN navigable tables carry the honest hover (product/customer/sales-month/category/supplier/expenses-month/cashflow)",
  (perfSrc.match(/transition-colors hover:bg-muted\/40 motion-reduce:transition-none/g) ?? []).length === 7,
);
ok(
  "6c the R152 reorder hint precedent untouched",
  reorderSrc.includes("reorderDrillHint") &&
    !reorderSrc.includes('"#/products/'),
);
ok(
  "6d the motion-safety audit tool exists (the R156 app-wide sweep)",
  readFileSync("scripts/r156-motion-audit.py", "utf8").includes("motion-reduce:transition-none"),
);
ok(
  "6e the day/month split left NO shared bucket table behind (the old day|month union is gone)",
  !perfSrc.includes('dimension: "day" | "month"'),
);
ok(
  "6f entity rows never learned the facet trick (the §16 id law stands for ids)",
  !perfSrc.includes('module: "sales", param: row.date') &&
    !perfSrc.includes('module: "expenses", param: row.date'),
);

console.log(`\nr156-month-drill-check: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
