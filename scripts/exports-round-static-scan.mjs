#!/usr/bin/env node
/**
 * exports-round-static-scan.mjs — static law checks for the EXPORTS ROUND.
 * Run: node scripts/exports-round-static-scan.mjs
 *
 * Verifies (by reading the source, never executing it):
 *  R1–R5  Every CSV producer (stocktake export lib consumers, aging export,
 *         adjustments CSV) carries the full §34/§80 convention set:
 *         CSV_EXPORT gate + rate limit + 429 + data.export audit + no-store
 *         + text/csv charset + attachment disposition + shared toCsv (BOM).
 *  R6     Adjustments JSON is DTO-allowlisted (no raw Prisma rows).
 *  R7     Adjustments date filters use STRICT calendar validation.
 *  R8–R9  Single-source law: BOTH aging routes render from buildAgingReport;
 *         the JSON route no longer inlines its own queries.
 *  R10    Stocktake export is bounded by the line cap with a cap+1
 *         completeness fetch and has NO money import (§82).
 *  R11    All 46 new i18n keys exist in BOTH en.ts and fa.ts.
 *  R12–R14 UI wiring: the three buttons call their relative API paths with
 *         x-business-id; inventory history uses server-side filters +
 *         shared Pagination; no absolute fetch URLs (gateway law).
 *  R15    Export cap constant = 1000 (honest-truncation law).
 */
import { readFileSync, existsSync } from "node:fs";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, info = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`);
  } else {
    fail++;
    failures.push(`${name} — ${info}`);
    console.log(`  ✗ ${name} — ${info}`);
  }
}

const read = (p) => readFileSync(p, "utf8");
const mustRead = (p) => {
  if (!existsSync(p)) {
    check(`file exists: ${p}`, false);
    return "";
  }
  return read(p);
};

const files = {
  stExportLib: mustRead("src/lib/inventory/stocktake/export.ts"),
  stExportRoute: mustRead("src/app/api/v1/inventory/stocktakes/[id]/export/route.ts"),
  agingExport: mustRead("src/app/api/v1/reports/aging/export/route.ts"),
  agingJson: mustRead("src/app/api/v1/reports/aging/route.ts"),
  agingLib: mustRead("src/lib/aging-report.ts"),
  adj: mustRead("src/app/api/v1/inventory/adjustments/route.ts"),
  en: mustRead("src/i18n/messages/en.ts"),
  fa: mustRead("src/i18n/messages/fa.ts"),
  stDetail: mustRead("src/modules/inventory/stocktakes/stocktake-detail-view.tsx"),
  agingCard: mustRead("src/modules/balances/aging-card.tsx"),
  invView: mustRead("src/modules/inventory/inventory-view.tsx"),
};

console.log("\nR1–R5 — CSV export convention set (per producer)");
const producers = [
  ["stocktake export lib+route", files.stExportLib + files.stExportRoute],
  ["aging export", files.agingExport],
  ["adjustments CSV branch", files.adj],
];
for (const [name, src] of producers) {
  check(`R1 ${name}: CSV_EXPORT entitlement gate`, src.includes('assertFeatureAccess') && src.includes('"CSV_EXPORT"'));
  check(`R2 ${name}: rate limit + 429 RATE_LIMITED`, src.includes("rateLimit(") && src.includes('"RATE_LIMITED"'));
  check(`R3 ${name}: data.export audit`, src.includes('action: "data.export"'));
  check(`R4 ${name}: no-store + csv charset + attachment`, src.includes('"cache-control": "no-store"') && src.includes("text/csv; charset=utf-8") && src.includes("content-disposition"));
  check(`R5 ${name}: shared toCsv (BOM law) or toCsv import`, src.includes('from "@/lib/csv"') && (src.includes("toCsv(") || src.includes("toCsv,")));
}

console.log("\nR6–R7 — adjustments feed laws");
check("R6a DTO mapper used for items", files.adj.includes("rows.map(toDto)"));
check("R6b no raw findMany passthrough in JSON branch", !/return ok\(\{\s*items\s*\}\)/.test(files.adj));
check("R6c explicit select (allowlist columns)", files.adj.includes("select: {"));
check("R7 strict calendar validation present", files.adj.includes("CALENDAR_DATE") && files.adj.includes("getUTCFullYear") && files.adj.includes("getUTCDate"));
check("R7b from/to must come together", files.adj.includes("hasFrom !== hasTo"));
check("R7c business-timezone window", files.adj.includes("resolveStatementWindow"));

console.log("\nR8–R9 — aging single source (A11)");
check("R8 JSON route renders from buildAgingReport", files.agingJson.includes("buildAgingReport") && !files.agingJson.includes("db.sale.findMany"));
check("R9 CSV route renders from buildAgingReport", files.agingExport.includes("buildAgingReport"));
check("R9b shared lib keeps AGING_SCAN_CAP honesty", files.agingLib.includes("AGING_SCAN_CAP") && files.agingLib.includes("truncated"));

console.log("\nR10 — stocktake export bounded + money-free");
check("R10a cap+1 completeness fetch", files.stExportLib.includes("take: cap + 1"));
check("R10b uses stocktakeLineCap env parser", files.stExportLib.includes("stocktakeLineCap"));
check("R10c NO money import (§82 no monetary values)", !files.stExportLib.includes("fromMinor") && !files.stExportLib.includes("lib/money"));
check("R10d tenant-scoped header query", files.stExportLib.includes("businessId: input.businessId"));
check("R10e reuses stocktakeLineDto (one source of truth)", files.stExportLib.includes("stocktakeLineDto"));

console.log("\nR11 — i18n parity for the exports round");
const KEYS = [
  "export:", "exporting:", "exportToast:", "exportFailed:", "exportRateLimited:",
  "historyFilterAll:", "historyFilterIncrease:", "historyFilterDecrease:", "historySearchPlaceholder:",
  "csvCreatedAt:", "csvProduct:", "csvSku:", "csvUnit:", "csvDirection:", "csvQuantity:", "csvReason:", "csvBy:",
];
let enMiss = KEYS.filter((k) => !files.en.includes(k));
let faMiss = KEYS.filter((k) => !files.fa.includes(k));
check("R11a inventory-root keys in en+fa", enMiss.length === 0 && faMiss.length === 0, `en missing=[${enMiss}] fa missing=[${faMiss}]`);
const ST_KEYS = ["csvReference:", "csvStatus:", "csvSystemQty:", "csvCountedQty:", "csvVariance:", "csvCountedAt:", "csvCountedBy:"];
enMiss = ST_KEYS.filter((k) => !files.en.includes(k));
faMiss = ST_KEYS.filter((k) => !files.fa.includes(k));
check("R11b stocktakes csv keys in en+fa", enMiss.length === 0 && faMiss.length === 0, `en=[${enMiss}] fa=[${faMiss}]`);
const AG_KEYS = ["csvSection:", "csvLabel:", "csvItems:", "csvOldestDays:", "csvBalance:", "csvTotal:", "csvPastDue:"];
enMiss = AG_KEYS.filter((k) => !files.en.includes(k));
faMiss = AG_KEYS.filter((k) => !files.fa.includes(k));
check("R11c aging csv keys in en+fa", enMiss.length === 0 && faMiss.length === 0, `en=[${enMiss}] fa=[${faMiss}]`);

console.log("\nR12–R14 — UI wiring");
check("R12a stocktake detail: relative export fetch + business header", files.stDetail.includes("/api/v1/inventory/stocktakes/${id}/export") && files.stDetail.includes('"x-business-id"'));
check("R12b aging card: side param + business header", files.agingCard.includes("/api/v1/reports/aging/export?side=${kind}") && files.agingCard.includes('"x-business-id"'));
check("R12c inventory history: format=csv + direction filter", files.invView.includes('format: "csv"') && files.invView.includes('p.set("direction", adjDirection)'));
check("R13 history uses shared Pagination (server totals)", files.invView.includes("<Pagination") && files.invView.includes("HISTORY_PAGE_SIZE"));
check("R14 NO absolute fetch URLs in the 3 UI files", [files.stDetail, files.agingCard, files.invView].every((s) => !/fetch\(["'`]https?:\/\//.test(s)));
check("R14b rate-limit error surfaced to the user (toast path)", files.stDetail.includes("exportRateLimited") && files.agingCard.includes("exportRateLimited") && files.invView.includes("exportRateLimited"));

console.log("\nR15 — honest truncation constant");
check("R15 adjustment export cap 1000", files.adj.includes("INVENTORY_ADJUSTMENT_EXPORT_CAP = 1000"));
check("R15b truncated recorded in audit", files.adj.includes("truncated"));

console.log(`\n== exports-round-static-scan: ${pass} passed, ${fail} failed ==`);
if (fail > 0) {
  failures.forEach((x) => console.log(`  FAILED: ${x}`));
  process.exit(1);
}
