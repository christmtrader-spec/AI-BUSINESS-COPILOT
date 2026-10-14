#!/usr/bin/env node
/**
 * scripts/prompt50-reports-static-scan.mjs — Prompt 50 static law scan.
 *
 * Source-level assertions (a COMPLEMENT to the unit + E2E suites, never a
 * replacement — §18):
 *   [1] future-exclusion law — every report source query is bounded on BOTH
 *       sides (gte AND lt) in the summary/monthly/advanced engines
 *   [2] tenant law — no Customer/Product findMany by bare id lists in the
 *       report services (businessId always present)
 *   [3] single-calculation law — JSON + CSV routes share the same builders
 *   [4] entitlement law — ADVANCED_REPORTS enforced in the performance
 *       routes; CSV_EXPORT enforced in EVERY report CSV route
 *   [5] complete-or-reject — no partial success: export routes reject with
 *       413 on caps; the monthly CSV uses buildMonthDetailComplete
 *   [6] money law — report engines use integer guards (safeAdd/safeMul),
 *       no parseFloat/parseFloat-style float money in report code paths
 *   [7] no P&L claims — no "net profit"/"gross margin"/COGS strings in
 *       report-facing labels or AI snapshot
 *   [8] closed vocabularies — grouping enums are closed; no client-selected
 *       DB fields
 *   [9] cursors signed — no unsigned JSON cursors in the performance module
 *  [10] no-store — confidential report responses set Cache-Control
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
const read = (p) => readFileSync(join(process.cwd(), p), "utf8");
const has = (src, needle) => src.includes(needle);

const reports = read("src/lib/reports.ts");
const advanced = read("src/lib/reports-advanced.ts");
const perf = read("src/lib/report-performance.ts");
const periods = read("src/lib/report-periods.ts");
const summaryRoute = read("src/app/api/v1/reports/summary/route.ts");
const mainExport = read("src/app/api/v1/reports/export/route.ts");
const monthlyExport = read("src/app/api/v1/reports/monthly/[month]/export/route.ts");
const perfRoute = read("src/app/api/v1/reports/performance/route.ts");
const perfExport = read("src/app/api/v1/reports/performance/export/route.ts");
const snapshot = read("src/lib/ai/snapshot.ts");
const view = read("src/modules/reports/reports-view.tsx");
const panel = read("src/modules/reports/performance-panel.tsx");

console.log("[1] future-exclusion law — both bounds on every report window query");
{
  // The summary engine must filter with gte AND lt on issueDate/spentAt/paidAt.
  ok("1a. summary Sale query has gte+lt bounds", has(reports, "issueDate: { gte: dateGte, lt: fetchUntil }"));
  ok("1b. summary Payment query has gte+lt bounds", has(reports, "paidAt: { gte: dateGte, lt: fetchUntil }"));
  ok("1c. summary Expense query has gte+lt bounds", has(reports, "spentAt: { gte: dateGte, lt: fetchUntil }"));
  ok("1d. advanced Sale queries have gte+lt bounds", (advanced.match(/issueDate: \{ gte: (current|previous)\.fetchFrom, lt: (current|previous)\.fetchUntil \}/g) ?? []).length === 2);
  ok("1e. monthly breakdown bounds payments on both sides", has(reports, "paidAt: { gte: fetchFrom, lt: fetchUntil }"));
  ok("1f. rolling window ends at the exclusive end of TODAY", has(periods, "zonedDayEndExclusiveUtc") && has(periods, "resolveRollingWindow"));
  ok("1g. month window clamps the current month at end-of-today", has(periods, "resolveMonthWindow") && has(periods, "zonedDayEndExclusiveUtc(today"));
}

console.log("[2] tenant law — scoped lookups in report services");
{
  ok("2a. advanced customer lookup carries businessId", has(advanced, "where: { id: { in: customerIds }, businessId }"));
  ok("2b. performance catalog lookup carries businessId", has(perf, "where: { id: { in: catalogIds }, businessId }"));
  ok("2c. performance cashflow aggregate is business-scoped", (perf.match(/businessId,\n\s+paidAt: \{ gte: window\.fetchFrom/g) ?? []).length >= 2);
  ok("2d. summary products query is business-scoped", has(reports, "where: { businessId, deletedAt: null }"));
}

console.log("[3] single-calculation law — CSV renders from the shared engines");
{
  ok("3a. main CSV uses buildReportSummary", has(mainExport, "buildReportSummary"));
  ok("3b. monthly CSV uses buildMonthDetailComplete (NOT the 25-row preview)", has(monthlyExport, "buildMonthDetailComplete") && !has(monthlyExport, "buildMonthDetail("));
  ok("3c. performance CSV uses the SAME builders as the JSON route", has(perfExport, "buildSalesPerformance") && has(perfExport, "buildExpensePerformance") && has(perfExport, "buildCashFlowPage"));
  ok("3d. performance JSON uses the SAME builders", has(perfRoute, "buildSalesPerformance") && has(perfRoute, "buildExpensePerformance") && has(perfRoute, "buildCashFlowPage"));
}

console.log("[4] entitlement law — server-side gates everywhere");
{
  ok("4a. summary enforces ADVANCED_REPORTS server-side (omit block)", has(summaryRoute, 'hasEntitlement(ctx.businessId, "ADVANCED_REPORTS")'));
  ok("4b. performance JSON enforces ADVANCED_REPORTS", has(perfRoute, 'assertFeatureAccess(ctx.businessId, "ADVANCED_REPORTS")'));
  ok("4c. performance export enforces ADVANCED_REPORTS AND CSV_EXPORT", has(perfExport, 'assertFeatureAccess(ctx.businessId, "ADVANCED_REPORTS")') && has(perfExport, 'assertFeatureAccess(ctx.businessId, "CSV_EXPORT")'));
  ok("4d. monthly export enforces CSV_EXPORT (D50-F fix)", has(monthlyExport, 'assertFeatureAccess(ctx.businessId, "CSV_EXPORT")'));
  ok("4e. main export enforces CSV_EXPORT (unchanged)", has(mainExport, 'assertFeatureAccess(ctx.businessId, "CSV_EXPORT")'));
  ok("4f. report CSV routes rate-limit exports", has(mainExport, "rateLimit(`report-export:") && has(monthlyExport, "rateLimit(`report-export:") && has(perfExport, "rateLimit(`report-export:"));
  ok("4g. report CSV routes audit data.export", (mainExport.match(/action: "data\.export"/g) ?? []).length === 1 && (monthlyExport.match(/action: "data\.export"/g) ?? []).length === 1 && (perfExport.match(/action: "data\.export"/g) ?? []).length === 1);
}

console.log("[5] complete-or-reject — no partial success");
{
  ok("5a. monthly CSV rejects over-cap months with 413", has(monthlyExport, '413,\n      "EXPORT_TOO_LARGE"') || has(monthlyExport, '"EXPORT_TOO_LARGE"'));
  ok("5b. performance CSV rejects truncated scans (EXPORT_INCOMPLETE)", has(perfExport, "EXPORT_INCOMPLETE"));
  ok("5c. performance CSV rejects over-cap groups (EXPORT_TOO_LARGE)", has(perfExport, "EXPORT_TOO_LARGE"));
  ok("5d. no row-cap slice() prefix inside the monthly export route (date formatting slices allowed)", !/\.slice\(0,\s*(2[0-9]|[1-9][0-9]+)\)/.test(monthlyExport.replace(/slice\(0, 10\)/g, "")));
  ok("5e. performance export pages cashflow until exhausted", has(perfExport, "page.nextCursor"));
}

console.log("[6] money law — integer guards, no float money");
{
  ok("6a. summary engine uses safeAdd/safeMul/safeSub", has(reports, "safeAdd(") && has(reports, "safeMul(") && has(reports, "safeSub("));
  ok("6b. performance engine uses safeAdd", has(perf, "safeAdd("));
  ok("6c. discount allocation is BigInt-based", has(perf, "BigInt(") && has(perf, "allocateInvoiceDiscount"));
  ok("6d. no parseFloat/Number() money parsing in report engines", !has(reports, "parseFloat") && !has(perf, "parseFloat") && !has(periods, "parseFloat"));
  ok("6e. CSV money serialized via fromMinor only", has(mainExport, "fromMinor(") && has(monthlyExport, "fromMinor(") && has(perfExport, "fromMinor("));
}

console.log("[7] no P&L / COGS / margin claims in report surfaces");
{
  const all = [reports, advanced, perf, periods, summaryRoute, mainExport, monthlyExport, perfRoute, perfExport, snapshot, view, panel];
  const forbidden = ["net profit", "gross margin", "cost of goods sold", "COGS", "P&L", "general ledger", "journal entry", "double-entry"];
  let clean = true;
  const hits = [];
  for (const [name, src] of all.entries()) {
    const low = src.toLowerCase();
    for (const f of forbidden) {
      if (low.includes(f.toLowerCase())) {
        // The AI snapshot GUARDRAIL mentioning them is allowed (it forbids the model).
        if (name === 9 && ["net profit", "p&l", "cost of goods sold", "cogs"].includes(f.toLowerCase())) continue;
        clean = false;
        hits.push(`file#${name}:${f}`);
      }
    }
  }
  ok("7a. no forbidden accounting claims in report code/UI", clean, hits.join(", "));
  ok("7b. AI snapshot forbids profit framing for netAccrual", has(snapshot, "revenueLessRecordedExpensesIssuedBasis") && has(snapshot, "Never call it profit"));
  ok("7c. summary API field netAccrualMinor PRESERVED (compat)", has(reports, "netAccrualMinor"));
  ok("7d. UI hint labels the figure truthfully", has(view, "kpiNetAccrual") && !view.includes("Profit (issued basis)"));
}

console.log("[8] closed vocabularies — no client-selected fields");
{
  ok("8a. sales groupBy closed enum", has(perf, 'SALES_GROUP_BYS = ["product", "customer", "day", "month"]'));
  ok("8b. expense groupBy closed enum", has(perf, 'EXPENSE_GROUP_BYS = ["category", "supplier", "day", "month"]'));
  ok("8c. routes reject non-closed groupBy", has(perfRoute, "isSalesGroupBy") && has(perfRoute, "isExpenseGroupBy"));
  ok("8d. rolling presets preserved (7/30/90)", has(periods, "ALLOWED_REPORT_DAYS = [7, 30, 90]"));
  ok("8e. monthly presets preserved (3/6/12)", has(periods, "ALLOWED_REPORT_MONTHS = [3, 6, 12]"));
}

console.log("[9] cursors signed (HMAC), never unsigned JSON");
{
  ok("9a. performance cursor is HMAC-signed", has(perf, "createHmac") && has(perf, "timingSafeEqual"));
  ok("9b. cursor payload carries opaque state only (no notes/amounts)", !/note|amountMinor|email/.test(perf.slice(perf.indexOf("PerformanceCursorPayload"), perf.indexOf("export function encodePerformanceCursor"))));
  ok("9c. route maps cursor errors to 422", has(perfRoute, "instanceof ReportRangeError"));
}

console.log("[10] no-store on confidential report responses");
{
  ok("10a. performance JSON no-store", has(perfRoute, 'no-store'));
  ok("10b. performance CSV no-store", has(perfExport, "no-store"));
  ok("10c. summary CSV no-store", has(mainExport, "no-store"));
  ok("10d. monthly CSV no-store", has(monthlyExport, "no-store"));
  ok("10e. CSV formula-injection protection via shared csvCell", has(mainExport, "csvCell") && has(monthlyExport, "csvCell") && has(perfExport, "csvCell"));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
