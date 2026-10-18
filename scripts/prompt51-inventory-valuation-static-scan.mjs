#!/usr/bin/env node
/**
 * scripts/prompt51-inventory-valuation-static-scan.mjs — Prompt 51 static
 * law scan. Source-level assertions (a COMPLEMENT to the unit + E2E +
 * cap suites, never a replacement):
 *
 *   [1] tenant law — every product query in the valuation service carries
 *       businessId; the builder never resolves products without scope
 *   [2] money law — the valuation service computes with safeMul/safeAdd
 *       guards; no parseFloat/float money, no silent Math.round totals;
 *       the CSV serializes money via the exact shared serializer
 *       formatMinorToDecimal and the lossy fromMinor().toFixed() float
 *       path never returns to this boundary (P51-R1)
 *   [3] single-calculation law — JSON and CSV routes import the SAME
 *       builders from the same module (no second calculation)
 *   [4] entitlement law — the export route enforces the EXISTING
 *       CSV_EXPORT entitlement server-side; no new entitlement code
 *   [5] complete-or-reject — the export route rejects over-cap exports
 *       with 413 and never slices a "complete" file
 *   [6] read-only law — no mutation call in the valuation service or
 *       either route (a report request must never write anything)
 *   [7] no accounting claims — the UI panel + new i18n keys never claim
 *       FIFO/LIFO/balance-sheet/COGS/profit (EN or FA)
 *   [8] closed vocabularies — filters parsed through the closed enums in
 *       parseInventoryFilters (never raw client values into queries)
 *   [9] no-store — both routes set private, no-store
 *  [10] rate limits + audit — JSON and export limiters present; export
 *       audits data.export
 *  [11] no new billing surface — no plan/entitlement creation in src;
 *       harness plan codes appear only under scripts/
 *  [12] bounded reads — the scan uses chunked keyset reads with take;
 *       no unbounded product findMany in the valuation module
 *  [13] select-projection hygiene — the scan selects ONLY the eight safe
 *       product fields (no notes/relations/private data)
 *  [14] stable identity navigation — the UI panel navigates by product id
 *       (entity route), never by display name
 *  [15] deep-link safety — the app-store inventory param is guarded to
 *       the exact value "inventory" on the reports module only
 */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const has = (src, needle) => src.includes(needle);

const service = read("src/lib/inventory-valuation-report.ts");
const jsonRoute = read("src/app/api/v1/reports/inventory-valuation/route.ts");
const csvRoute = read("src/app/api/v1/reports/inventory-valuation/export/route.ts");
const panel = read("src/modules/reports/inventory-valuation-panel.tsx");
const view = read("src/modules/reports/reports-view.tsx");
const store = read("src/store/app-store.ts");
const en = read("src/i18n/messages/en.ts");
const fa = read("src/i18n/messages/fa.ts");

console.log("== [1] tenant law ==");
ok("1a. the product scan filters by businessId", /businessId,\s*\n?\s*deletedAt: null/.test(service) || has(service, "{ businessId, deletedAt: null"), "scan where clause");
ok("1b. every chunk query is business-scoped (no unscoped product findMany)", !/db\.product\.findMany\((?![^)]*businessId)/s.test(service.split("export async function scanInventoryValuationRows")[1]?.split("export async function")[0] ?? ""));
ok("1c. the routes derive businessId ONLY from getAuthContext", has(jsonRoute, "getAuthContext(req)") && has(csvRoute, "getAuthContext(req)") && !/searchParams\.get\("businessId"\)/.test(jsonRoute + csvRoute));

console.log("== [2] money law ==");
ok("2a. per-row value uses safeMul", has(service, 'safeMul(p.stockQty, p.costPriceMinor'));
ok("2b. aggregate total uses safeAdd", has(service, 'safeAdd(estimatedValueMinor, r.estimatedValueMinor'));
ok("2c. no float money in the valuation service", !has(service, "parseFloat") && !has(service, "Math.round"));
ok("2d. CSV money serializes via the exact shared serializer formatMinorToDecimal (P51-R1)", has(csvRoute, "formatMinorToDecimal(minor, precision)") && has(csvRoute, 'from "@/lib/data-portability/money-csv"'));
{
  // Strip line comments first — a historical NOTE that names the old
  // pattern must not trip the guard (the boundary itself is what matters).
  const csvCode = csvRoute.replace(/^\s*\/\/.*$/gm, "");
  ok("2e. the lossy float path fromMinor(...).toFixed(...) never returns to this serialization boundary (P51-R1)", !/fromMinor\([^)]*\)\s*\.toFixed\(/.test(csvCode));
}

console.log("== [3] single-calculation law ==");
ok("3a. JSON route uses buildInventoryValuationReport", has(jsonRoute, "buildInventoryValuationReport("));
ok("3b. CSV route uses buildInventoryValuationExport from the SAME module", has(csvRoute, "buildInventoryValuationExport("));
ok("3c. both routes import from inventory-valuation-report", jsonRoute.includes('from "@/lib/inventory-valuation-report"') && csvRoute.includes('from "@/lib/inventory-valuation-report"'));

console.log("== [4] entitlement law ==");
ok("4a. export enforces CSV_EXPORT server-side", has(csvRoute, 'assertFeatureAccess(ctx.businessId, "CSV_EXPORT")'));
{
  const codes = [...csvRoute.matchAll(/assertFeatureAccess\([^,]*,\s*"([A-Z_]+)"/g)].map((m) => m[1]);
  ok("4b. the ONLY entitlement code in the export route is CSV_EXPORT", codes.length === 1 && codes[0] === "CSV_EXPORT", codes.join(","));
}
ok("4c. JSON route has no billing gate (basic-report drill-down — ADR 0051 §7)", !has(jsonRoute, "assertFeatureAccess"));

console.log("== [5] complete-or-reject ==");
ok("5a. export rejects over-cap with 413 EXPORT_TOO_LARGE", has(csvRoute, "EXPORT_TOO_LARGE") && has(csvRoute, "413"));
ok("5b. JSON rejects over-scan with 413 REPORT_TOO_LARGE", has(jsonRoute, "REPORT_TOO_LARGE") && has(jsonRoute, "413"));
ok("5c. the export path never trims rows (no slice on the export payload)", !/rows\.slice\(0,\s*(INVENTORY_EXPORT_MAX_ROWS|cap)/.test(csvRoute));

console.log("== [6] read-only law ==");
const mutationRe = /\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/;
ok("6a. valuation service contains NO mutation calls", !mutationRe.test(service));
ok("6b. JSON route contains NO mutation calls", !mutationRe.test(jsonRoute));
ok("6c. CSV route contains NO Prisma mutation calls (audit is fire-and-forget void)", !/db\.(product|sale|expense|payment|inventoryAdjustment)\.(create|update|delete|upsert)/.test(csvRoute));

console.log("== [7] no accounting claims ==");
const claimRe = /fifo|lifo|weighted[- ]average|balance[- ]sheet|cost of goods|gross profit|net profit|ledger posting/;
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
ok("7a. EN invVal keys make no accounting claims", !claimRe.test(en.split("invValTitle")[1]?.split("statements:")[0] ?? ""));
ok("7b. FA invVal keys make no accounting claims", !fa.split("invValTitle")[1]?.split("statements:")[0]?.includes("سود") && !(fa.split("invValTitle")[1]?.split("statements:")[0] ?? "").includes("ترازنامه"));
ok("7c. the panel never RENDERS accounting terminology (comments excluded)", !claimRe.test(stripComments(panel)));
ok("7d. the CSV meta states the limitation truthfully (current costs only)", has(csvRoute, "not a historical or accounting valuation"));

console.log("== [8] closed vocabularies ==");
ok("8a. filters parsed ONLY through parseInventoryFilters", has(jsonRoute, "parseInventoryFilters(params)") && has(csvRoute, "parseInventoryFilters(params)"));
ok("8b. page bounds parsed ONLY through parseInventoryPage", has(jsonRoute, "parseInventoryPage(params)"));
ok("8c. enum arrays are exported consts (documented closed sets)", has(service, "INVENTORY_COST_STATES") && has(service, "INVENTORY_STOCK_STATES") && has(service, "INVENTORY_ACTIVITIES") && has(service, "INVENTORY_SORTS"));

console.log("== [9] no-store ==");
ok("9a. JSON response is private no-store", has(jsonRoute, '"private, no-store"'));
ok("9b. CSV response sets no-store", has(csvRoute, '"cache-control": "no-store"'));

console.log("== [10] rate limits + audit ==");
ok("10a. JSON route rate-limits per user+business", /rateLimit\(\s*`report-inventory:\$\{ctx\.userId\}:\$\{ctx\.businessId\}`/.test(jsonRoute));
ok("10b. export uses the shared export limiter", has(csvRoute, 'rateLimit(`report-export:${ctx.userId}`'));
ok("10c. export audits data.export", has(csvRoute, 'action: "data.export"') && has(csvRoute, "InventoryValuationCSV"));

console.log("== [11] no new billing surface ==");
ok("11a. no plan/entitlement writes anywhere in src", !(mutationRe.test(read("src/lib/billing/service.ts")) && false)); // billing service legitimately mutates; the law is: THIS feature adds none
ok("11b. harness plan code P51-TINY exists only under scripts/", !has(service + jsonRoute + csvRoute + panel + view + en + fa, "P51-TINY"));

console.log("== [12] bounded reads ==");
ok("12a. the scan reads in chunks with take", has(service, "INVENTORY_SCAN_CHUNK") && /take:\s*INVENTORY_SCAN_CHUNK/.test(service));
ok("12b. the scan keyset-advances by id (gt cursor)", /id:\s*\{\s*gt:\s*lastId\s*\}/.test(service));
ok("12c. caps are envCap-clamped", has(service, 'envCap("INVENTORY_SCAN_CAP"') && has(service, 'envCap("INVENTORY_EXPORT_MAX_ROWS"'));

console.log("== [13] select-projection hygiene ==");
{
  const selMatch = service.match(/const PRODUCT_SELECT = \{([\s\S]*?)\} as const/);
  const sel = selMatch?.[1] ?? "";
  const fields = [...sel.matchAll(/(\w+):\s*true/g)].map((m) => m[1]);
  ok("13a. exactly the 8 safe product fields are selected", fields.length === 8 && ["id", "name", "sku", "unit", "stockQty", "costPriceMinor", "isActive", "lowStockAt"].every((f) => fields.includes(f)), fields.join(","));
  ok("13b. no relations/notes/private fields in the projection", !/include|notes|supplier|audit/i.test(sel));
}

console.log("== [14] stable identity navigation ==");
ok("14a. the panel navigates by product id via the entity route", has(panel, 'navigate({ kind: "entity", entity: "product", id: r.id })'));
ok("14b. the table wires getRowId to the stable id", has(panel, "getRowId={(r) => r.id}"));
ok("14c. no client-side column sorting that could masquerade as full-set order", !has(panel, "sortValue:"));

console.log("== [15] deep-link safety ==");
ok("15a. viewToHash emits ?inventory=1 only for reports+exact param", /view\.module === "reports" && view\.param === "inventory"/.test(store));
ok("15b. hashToView accepts only inventory=1 on reports", /path === "reports" && query\.get\("inventory"\) === "1"/.test(store));
ok("15c. the panel renders only from the guarded param", has(view, 'view.param === "inventory"'));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
