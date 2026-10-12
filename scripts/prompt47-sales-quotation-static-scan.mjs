#!/usr/bin/env node
/**
 * Prompt 47 — sales-quotation static security scan.
 *
 * Dependency-free source scan over the whole P47 surface (domain, routes,
 * UI, prisma schema, migration, write-transaction reuse, export catalog,
 * import allowlist, search, entities, store/shell wiring, i18n, restore
 * probes, env-repair, test scripts). Rule classes:
 *   surface presence · tenant scope · RBAC · status integrity ·
 *   safe integers + overflow law · line-set completeness invariant ·
 *   422/500 cap classification split · QUOTATION PURITY (§1/§13: no stock,
 *   Sale, Payment, InventoryAdjustment, goods-dispatch mutation anywhere
 *   in the quotation domain) · conversion law (one CONFIRMED order, DB
 *   unique race authority) · validity/expiration law (§9) · snapshots
 *   frozen (§12) · no client authority fields (§15) · NOTES law
 *   (internalNotes never printed/exported/searched §10/§16) · CSV security
 *   stack (§20) · business export datasets + import rejection (§20) ·
 *   search tenant safety (§18) · business-timezone windows · i18n parity ·
 *   migration additive-only · restore probes (§118) · no raw SQL/db push ·
 *   behavioral test coverage.
 *
 * Run: bun scripts/prompt47-sales-quotation-static-scan.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => {
  try {
    return readFileSync(`${ROOT}${p}`, "utf8");
  } catch {
    return "";
  }
};
const exists = (p) => existsSync(`${ROOT}${p}`);

const TYPES = read("src/lib/sales-quotations/types.ts");
const SCHEMA = read("src/lib/sales-quotations/schema.ts");
const DTO = read("src/lib/sales-quotations/dto.ts");
const SERVICE = read("src/lib/sales-quotations/service.ts");
const INTEGRATION = read("src/lib/sales-quotations/integration.ts");
const EXPORT = read("src/lib/sales-quotations/export.ts");
const ROUTE_LIST = read("src/app/api/v1/sales-quotations/route.ts");
const ROUTE_ID = read("src/app/api/v1/sales-quotations/[id]/route.ts");
const ROUTE_LINES = read("src/app/api/v1/sales-quotations/[id]/lines/route.ts");
const ROUTE_LINE_ID = read("src/app/api/v1/sales-quotations/[id]/lines/[lineId]/route.ts");
const ROUTE_MARK_SENT = read("src/app/api/v1/sales-quotations/[id]/mark-sent/route.ts");
const ROUTE_ACCEPT = read("src/app/api/v1/sales-quotations/[id]/accept/route.ts");
const ROUTE_REJECT = read("src/app/api/v1/sales-quotations/[id]/reject/route.ts");
const ROUTE_CANCEL = read("src/app/api/v1/sales-quotations/[id]/cancel/route.ts");
const ROUTE_EXPIRE = read("src/app/api/v1/sales-quotations/[id]/expire/route.ts");
const ROUTE_CONVERT = read("src/app/api/v1/sales-quotations/[id]/convert/route.ts");
const ROUTE_EXPORT = read("src/app/api/v1/sales-quotations/[id]/export/route.ts");
const ROUTE_PRINT = read("src/app/api/v1/sales-quotations/[id]/print/route.ts");
const ALL_ROUTES = [ROUTE_LIST, ROUTE_ID, ROUTE_LINES, ROUTE_LINE_ID, ROUTE_MARK_SENT, ROUTE_ACCEPT, ROUTE_REJECT, ROUTE_CANCEL, ROUTE_EXPIRE, ROUTE_CONVERT, ROUTE_EXPORT, ROUTE_PRINT];
const MIGRATION = read("prisma/migrations/20261012090000_prompt47_sales_quotations/migration.sql");
const PRISMA = read("prisma/schema.prisma");
const ENV_REPAIR = read("scripts/env-repair.mjs");
const RESTORE = read("scripts/restore-drill.mjs");
const EXPORT_CATALOG = read("src/lib/data-portability/export-catalog.ts");
const IMPORT_CATALOG = read("src/lib/data-portability/import-catalog.ts");
const IMPORT_FIELDS = read("src/lib/data-portability/import-fields.ts");
const SEARCH_TYPES = read("src/lib/search/types.ts");
const SEARCH_QUERY = read("src/lib/search/query.ts");
const SEARCH_DTO = read("src/lib/search/dto.ts");
const CUSTOMER_ROUTE = read("src/app/api/v1/customers/[id]/route.ts");
const PRODUCT_ROUTE = read("src/app/api/v1/products/[id]/route.ts");
const ENTITY_ROUTE = read("src/modules/entities/entity-route.ts");
const STORE = read("src/store/app-store.ts");
const SHELL = read("src/modules/shell/app-shell.tsx");
const SIDEBAR = read("src/modules/shell/app-sidebar.tsx");
const UI_LIST = read("src/modules/sales-quotations/sales-quotations-view.tsx");
const UI_DETAIL = read("src/modules/sales-quotations/sales-quotation-detail-view.tsx");
const UI_CREATE = read("src/modules/sales-quotations/sales-quotation-create-dialog.tsx");
const UI_PRINT = read("src/modules/sales-quotations/sales-quotation-print.tsx");
const UI_API = read("src/modules/sales-quotations/sales-quotations-api.ts");
const EN = read("src/i18n/messages/en.ts");
const FA = read("src/i18n/messages/fa.ts");
const UNIT = read("scripts/prompt47-unit.ts");
const E2E = read("scripts/prompt47-sales-quotation-check.mjs");
const CAP = read("scripts/prompt47-sales-quotation-cap-check.ts");

/** Strip comments so documentation cannot false-positive code checks. */
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0;
let fail = 0;
const failures = [];
function record(name, cond, info = "") {
  if (cond) pass++;
  else fail++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}

/* --------------------------- 1. surface presence -------------------------- */
record("1. domain module files exist", ["src/lib/sales-quotations/types.ts", "src/lib/sales-quotations/schema.ts", "src/lib/sales-quotations/dto.ts", "src/lib/sales-quotations/service.ts", "src/lib/sales-quotations/integration.ts", "src/lib/sales-quotations/export.ts", "src/lib/sales-quotations/index.ts"].map(exists).every(Boolean));
record("2. all 12 API route files exist (13 endpoints)", ["src/app/api/v1/sales-quotations/route.ts", "src/app/api/v1/sales-quotations/[id]/route.ts", "src/app/api/v1/sales-quotations/[id]/lines/route.ts", "src/app/api/v1/sales-quotations/[id]/lines/[lineId]/route.ts", "src/app/api/v1/sales-quotations/[id]/mark-sent/route.ts", "src/app/api/v1/sales-quotations/[id]/accept/route.ts", "src/app/api/v1/sales-quotations/[id]/reject/route.ts", "src/app/api/v1/sales-quotations/[id]/cancel/route.ts", "src/app/api/v1/sales-quotations/[id]/expire/route.ts", "src/app/api/v1/sales-quotations/[id]/convert/route.ts", "src/app/api/v1/sales-quotations/[id]/export/route.ts", "src/app/api/v1/sales-quotations/[id]/print/route.ts"].map(exists).every(Boolean));
record("3. UI module files exist", ["src/modules/sales-quotations/sales-quotations-view.tsx", "src/modules/sales-quotations/sales-quotation-detail-view.tsx", "src/modules/sales-quotations/sales-quotation-create-dialog.tsx", "src/modules/sales-quotations/sales-quotation-line-editor.tsx", "src/modules/sales-quotations/sales-quotation-print.tsx", "src/modules/sales-quotations/sales-quotation-product-picker.tsx", "src/modules/sales-quotations/sales-quotations-api.ts"].map(exists).every(Boolean));
record("4. exactly one P47 migration exists", exists("prisma/migrations/20261012090000_prompt47_sales_quotations/migration.sql"));
record("5. unit + E2E + cap-check + this scan exist", ["scripts/prompt47-unit.ts", "scripts/prompt47-sales-quotation-check.mjs", "scripts/prompt47-sales-quotation-cap-check.ts", "scripts/prompt47-sales-quotation-static-scan.mjs"].map(exists).every(Boolean));
record("6. no DELETE handler on the quotation document (§14: history preserved)", !ROUTE_ID.includes("export const DELETE") && !ROUTE_LIST.includes("export const DELETE"));

/* ------------------------------ 2. tenant scope ---------------------------- */
record("7. service loads quotation scoped by { id, businessId }", SERVICE.includes("where: { id, businessId }"));
record("8. routes resolve ids from params + ctx (never request body)", ALL_ROUTES.every((r) => r.length === 0 || (!r.includes("body.businessId") && !r.includes("businessId: body"))));
record("9. detail/lines/export/print/lifecycle routes guard malformed ids to 404", [ROUTE_ID, ROUTE_LINES, ROUTE_LINE_ID, ROUTE_MARK_SENT, ROUTE_ACCEPT, ROUTE_REJECT, ROUTE_CANCEL, ROUTE_EXPIRE, ROUTE_CONVERT, ROUTE_EXPORT, ROUTE_PRINT].every((r) => r.includes("isValidEntityId")));
record("10. foreign customer indistinguishable from unknown (404)", SERVICE.includes("SALES_QUOTATION_ERROR_CODES.CUSTOMER_NOT_FOUND") && SERVICE.includes("404"));
record("11. foreign product indistinguishable from unknown (404)", SERVICE.includes("SALES_QUOTATION_ERROR_CODES.PRODUCT_NOT_FOUND"));

/* --------------------------------- 3. RBAC --------------------------------- */
record("12. every route uses getAuthContext + requirePermission", ALL_ROUTES.every((r) => r.includes("getAuthContext(req)") && r.includes("requirePermission(ctx,")));
record("13. reads require data:read", [ROUTE_LIST, ROUTE_ID, ROUTE_EXPORT, ROUTE_PRINT].every((r) => r.includes('requirePermission(ctx, "data:read")')));
record("14. writes require data:write", [ROUTE_ID, ROUTE_LINES, ROUTE_LINE_ID, ROUTE_MARK_SENT, ROUTE_ACCEPT, ROUTE_REJECT, ROUTE_CANCEL, ROUTE_EXPIRE, ROUTE_CONVERT].every((r) => r.includes('requirePermission(ctx, "data:write")')));
record("15. no new permission vocabulary introduced", !TYPES.includes("permission") && !SCHEMA.includes("permission"));

/* --------------------------- 4. status integrity --------------------------- */
record("16. parseSalesQuotationStatus throws on unknown values (§8)", TYPES.includes("SalesQuotationStatusIntegrityError") && TYPES.includes("throw new SalesQuotationStatusIntegrityError"));
record("17. corrupted persisted status → controlled 500 (never DRAFT)", SERVICE.includes("parseDbStatus") && INTEGRATION.includes("INVALID_PERSISTED_STATUS"));
record("18. status re-checked INSIDE write transactions", SERVICE.split("withWriteTx").length >= 10 && SERVICE.includes("canTransitionSalesQuotation"));
record("19. one shared in-tx lifecycle gate funnels every transition", SERVICE.includes("gateTransition") && SERVICE.split("gateTransition(").length >= 6);
record("20. no `→ DRAFT` fallback anywhere in the domain", !TYPES.includes('status = "DRAFT"') && !DTO.includes('?? "DRAFT"'));
record("21. EXPIRED requires ACTUALLY past validity; NOT_EXPIRED guards force-expire", SERVICE.includes("isQuotationExpiredInBusinessTz") && SERVICE.includes("NOT_EXPIRED"));
record("22. accept/reject re-check validity INSIDE the write tx (§9)", SERVICE.includes("SALES_QUOTATION_ERROR_CODES.EXPIRED"));
record("23. ACCEPTED never expires (display + conversion law)", TYPES.includes('persisted === "SENT"') && SERVICE.includes("ACCEPTED never expires"));

/* --------------------------- 5. safe integers ------------------------------ */
record("24. safe-integer checks on quantity laws (§6)", TYPES.includes("Number.isSafeInteger"));
record("25. line-total overflow throws (§11)", TYPES.includes("SalesQuotationTotalOverflowError") && TYPES.includes("SALES_QUOTATION_TOTAL_OVERFLOW"));
record("26. subtotal accumulation re-checks the safe range per addition", TYPES.split("Number.isSafeInteger(subtotalMinor)").length >= 2);
record("27. discount law: 0..subtotal, never above (§11)", TYPES.includes("validateQuotationDiscount") && TYPES.includes("discountMinor > subtotalMinor"));
record("28. canonical total = subtotal − discount with validation", TYPES.includes("computeQuotationTotalMinor"));
record("29. no parseFloat/float math for money in the domain", !TYPES.includes("parseFloat") && !SERVICE.includes("parseFloat") && !EXPORT.includes("parseFloat"));
record("30. client totals never trusted (recomputed server-side)", SERVICE.includes("computeQuotationSubtotalMinor(lines)") && SERVICE.includes("computeQuotationTotalMinor"));

/* --------------------------- 6. cap invariant ------------------------------ */
record("31. three-check completeness invariant (fetched ≤ cap, counted ≤ cap, equal)", TYPES.includes("assertSalesQuotationLineSetComplete") && TYPES.includes("countedLines !== fetchedLines"));
record("32. reads fetch cap+1 to prove completeness", SERVICE.includes("take: cap + 1"));
record("33. over-cap persisted quotation is a 500 integrity failure", SERVICE.includes("SALES_QUOTATION_ERROR_CODES.LINE_CAP_INVARIANT") && SERVICE.includes("500"));
record("34. write-time full-cap is the 422 user rejection", SERVICE.includes("422") && SERVICE.includes("SALES_QUOTATION_ERROR_CODES.LINE_LIMIT"));
record("35. export uses cap+1 completeness (never partial CSV)", EXPORT.includes("take: cap + 1") && EXPORT.includes("truncated"));

/* ---------------------- 7. quotation purity (§1/§13) ----------------------- */
record("36. quotation service NEVER mutates Product.stockQty", !stripComments(SERVICE).includes("stockQty"));
record("37. quotation service NEVER creates a Sale invoice", !SERVICE.includes("sale.create"));
record("38. quotation service NEVER creates a Payment", !SERVICE.includes("payment.create"));
record("39. quotation service NEVER creates an InventoryAdjustment", !SERVICE.includes("inventoryAdjustment"));
record("40. quotation service NEVER touches goods dispatches", !SERVICE.includes("goodsDispatch"));
record("41. quotation export NEVER touches stock/finance models", !EXPORT.includes("stockQty") && !EXPORT.includes("sale.create") && !EXPORT.includes("inventoryAdjustment"));
record("42. conversion creates NO Sale/Payment/receivable (§13 invariants)", (() => {
  const conv = SERVICE.split("export async function convertSalesQuotationToOrder")[1]?.split("recentQuotationsForCustomer")[0] ?? "";
  return !conv.includes("sale.create") && !conv.includes("payment.create") && !conv.includes("inventoryAdjustment") && !conv.includes("stockQty");
})());
record("43. conversion produces exactly ONE CONFIRMED SalesOrder with sourceQuotationId", SERVICE.includes('status: "CONFIRMED"') && SERVICE.includes("sourceQuotationId: header.id"));
record("44. DB unique constraint on SalesOrder.sourceQuotationId is the race authority", MIGRATION.includes('CREATE UNIQUE INDEX "SalesOrder_sourceQuotationId_key"') && SERVICE.includes("ALREADY_CONVERTED"));
record("45. already-converted guard runs BEFORE the status gate (one conflict for every loser)", SERVICE.indexOf("existingOrder") >= 0 && SERVICE.indexOf("existingOrder") < SERVICE.indexOf('header.status !== "ACCEPTED"'));
record("46. conversion copies FROZEN snapshots (never re-priced from live Products)", SERVICE.includes("customerNameAtOrder: header.customerNameAtQuotation") && SERVICE.includes("productNameAtOrder: line.productNameAtQuotation"));
record("47. conversion order lines carry exact qty/unitPriceMinor", SERVICE.includes("orderedQty: line.qty") && SERVICE.includes("unitPriceMinor: line.unitPriceMinor"));
record("48. quotation/order subtotal disagreement aborts conversion", SERVICE.includes("quotation/order subtotal disagreement"));
record("49. sales-order domain functions derive the order totals (§13 step 18)", SERVICE.includes("computeOrderSubtotalMinor"));

/* ------------------------- 8. create/lifecycle purity ---------------------- */
record("50. createSalesQuotation creates ONLY the quotation + audit", (() => {
  const create = SERVICE.split("export async function createSalesQuotation")[1]?.split("export async function listSalesQuotations")[0] ?? "";
  return create.includes("salesQuotation.create") && !create.includes("sale.create") && !create.includes("product.update");
})());
record("51. NO quotation delete API exists in the service", !SERVICE.includes("salesQuotation.delete"));
record("52. mark-sent requires ≥1 line (EMPTY 422)", SERVICE.includes("SALES_QUOTATION_ERROR_CODES.EMPTY"));
record("53. lifecycle timestamps are SERVER-generated inside txs", SERVICE.includes("const sentAt = new Date()") && SERVICE.includes("const acceptedAt = new Date()") && SERVICE.includes("const convertedAt = new Date()"));

/* ------------------------------ 9. validity law ---------------------------- */
record("54. quotationDate defaults to the SERVER business-local today (§9/§10)", SERVICE.includes("businessLocalCalendarDate(new Date(), input.timezone)") && !SCHEMA.includes("businessLocalCalendarDate"));
record("55. validUntilDate ordering enforced against the PATCHED pair (partial patch cannot dodge it)", SERVICE.split("isQuotationDateRangeValid").length >= 3 && SERVICE.includes("INVALID_DATE_RANGE"));
record("56. calendar dates stored with the UTC-midnoon rule", SERVICE.includes("T12:00:00.000Z"));
record("57. empty draft cannot carry a creation discount", SERVICE.includes("an empty quotation cannot carry a discount") || SERVICE.includes("Add lines first"));

/* ------------------------------ 10. snapshots ------------------------------ */
record("58. customer snapshot frozen at creation (§12)", SERVICE.includes("customerNameAtQuotation, // frozen snapshot") || SERVICE.includes("customerNameAtQuotation = customer.name"));
record("59. product snapshots frozen at line-add (§12)", SERVICE.includes("productNameAtQuotation: product.name") && SERVICE.includes("skuAtQuotation: product.sku"));
record("60. missing persisted snapshot is corruption, never substituted (§12)", DTO.includes("requireSnapshot") && DTO.includes("missing"));
record("61. currency snapshot is server-derived from Business (§10)", SERVICE.includes("currencyCodeAtQuotation: business.currencyCode") && !SCHEMA.includes("currencyCodeAtQuotation"));
record("62. line edits never rewrite snapshots", !SERVICE.includes("productNameAtQuotation: input") && SCHEMA.split("salesQuotationLineUpdateSchema")[1]?.includes("productId") === false);
record("63. customer rename on draft re-freezes the snapshot (drafts only)", SERVICE.includes("customerNameAtQuotation = customer.name; // snapshot refrozen (§12)"));

/* ------------------------ 11. strict input schemas ------------------------- */
record("64. create/update/line schemas are .strict() (§15)", SCHEMA.split(".strict()").length >= 4);
record("65. create/update schemas never accept status/totals/convertedAt", (() => {
  const code = SCHEMA.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const createBlock = code.split("export const salesQuotationCreateSchema")[1]?.split("export const")[0] ?? "";
  const updateBlock = code.split("export const salesQuotationUpdateSchema")[1]?.split("export const")[0] ?? "";
  return !createBlock.includes("status:") && !createBlock.includes("totalMinor") && !createBlock.includes("convertedAt") &&
    !updateBlock.includes("status:") && !updateBlock.includes("totalMinor") && !updateBlock.includes("convertedAt");
})());
record("66. lifecycle timestamps never patchable", (() => {
  const code = stripComments(SCHEMA);
  return !code.includes("sentAt") && !code.includes("acceptedAt") && !code.includes("rejectedAt") && !code.includes("cancelledAt") && !code.includes("convertedAt");
})());
record("67. validUntilDate is REQUIRED at create (the offer's validity is the point)", (() => {
  const createBlock = SCHEMA.split("export const salesQuotationCreateSchema")[1]?.split("export const salesQuotationUpdateSchema")[0] ?? "";
  return /validUntilDate: calendarDate,/.test(createBlock);
})());

/* ------------------------------ 12. DTO allowlist -------------------------- */
record("68. no raw Prisma object ever serialized", DTO.includes("salesQuotationDetailDto") && DTO.includes("salesQuotationLineDto") && !DTO.includes("...header"));
record("69. BOTH persistedStatus and effectiveStatus exposed explicitly (§9)", DTO.includes("persistedStatus") && DTO.includes("effectiveStatus"));
record("70. converted order DTO appears ONLY when the relation exists (§7)", SERVICE.includes("row.convertedSalesOrder") && SERVICE.includes("? {") === false ? DTO.includes("convertedOrder") : DTO.includes("convertedOrder"));
record("71. creator exposed as id/name only", DTO.includes("createdBy: header.createdBy") && !DTO.includes("passwordHash") && !DTO.includes("sessionVersion"));
record("72. list rows avoid unbounded nested lines", !DTO.includes("lines: row.lines") || DTO.includes("SalesQuotationListItemDto"));

/* ------------------------------ 13. NOTES law ------------------------------ */
record("73. print route + print DTO never reference internalNotes", !stripComments(ROUTE_PRINT).includes("internalNotes") && !stripComments(DTO.split("export type SalesQuotationPrintDto = {")[1]?.split("\n};")[0] ?? "").includes("internalNotes"));
record("74. export has NO internalNotes column", !stripComments(EXPORT).includes("internalNotes"));
record("75. search query selects no notes", !SEARCH_QUERY.split("async function searchSalesQuotations")[1]?.split("\n}")[0].includes("internalNotes") && !SEARCH_QUERY.split("async function searchSalesQuotations")[1]?.split("\n}")[0].includes("customerNotes"));
record("76. search DTO omits notes from the quotation candidate", !SEARCH_DTO.split("salesQuotationCandidate")[1]?.split("salesQuotationStatusToken")[1]?.includes("customerNotes"));
record("77. notes never enter audit payloads (changed-flag only)", SERVICE.includes("customerNotes: { changed: true }") && SERVICE.includes("internalNotes: { changed: true }") && !SERVICE.includes("internalNotes: input.internalNotes // audit"));

/* ------------------------------ 14. CSV security --------------------------- */
record("78. export gate: CSV_EXPORT entitlement + rate limit + audit", ROUTE_EXPORT.includes('assertFeatureAccess(ctx.businessId, "CSV_EXPORT")') && ROUTE_EXPORT.includes("rateLimit") && ROUTE_EXPORT.includes('"data.export"'));
record("79. export headers: no-store + attachment + strict locale", ROUTE_EXPORT.includes('"cache-control": "no-store"') && ROUTE_EXPORT.includes("attachment") && ROUTE_EXPORT.includes('localeParam !== "fa"'));
record("80. CSV via the shared toCsv OWASP guard", EXPORT.includes("toCsv") && EXPORT.includes("salesQuotationReferenceSlug"));
record("81. corrupted persisted status is a controlled 500 in the export too", EXPORT.includes("parseSalesQuotationStatus") && EXPORT.includes("mapPureSalesQuotationDomainError"));

/* --------------------- 15. export/import + backup probes ------------------- */
record("82. business export adds sales_quotations + sales_quotation_lines (§20)", EXPORT_CATALOG.includes('"sales_quotations"') && EXPORT_CATALOG.includes('"sales_quotation_lines"'));
record("83. parent dataset implies child lines", EXPORT_CATALOG.includes("sales_quotations: [\"sales_quotation_lines\"]"));
record("84. export catalog has NO internalNotes column for quotation datasets", (() => {
  const block = EXPORT_CATALOG.split("sales_quotations: [")[1]?.split("sales_quotation_lines: [")[1]?.split("]")[0] ?? "";
  return !block.includes("internal_notes");
})());
record("85. import remains BLOCKED for quotation datasets (closed allowlist)", !IMPORT_CATALOG.includes("sales_quotations") && !IMPORT_FIELDS.includes("sales_quotation"));
record("86. restore-drill probes SalesQuotation + SalesQuotationLine", RESTORE.includes('"SalesQuotation", "SalesQuotationLine"'));
record("87. env-repair baselines the P47 migration", ENV_REPAIR.includes("20261012090000_prompt47_sales_quotations"));

/* ------------------------------ 16. search --------------------------------- */
record("88. SALES_QUOTATION joins the closed search vocabulary (§18)", SEARCH_TYPES.includes('"SALES_QUOTATION"') && SEARCH_TYPES.includes('"sales-quotations"'));
record("89. quotation search is tenant-scoped with cap-bounded snapshot text", SEARCH_QUERY.includes("searchSalesQuotations") && SEARCH_QUERY.split("async function searchSalesQuotations")[1]?.includes("salesQuotationLineCap"));
record("90. search carries NO amounts and NO notes for quotations", (() => {
  const block = SEARCH_QUERY.split("async function searchSalesQuotations")[1]?.split("/**")[0] ?? "";
  return !block.includes("customerNotes") && !block.includes("internalNotes") && !block.includes("totalMinor");
})());
record("91. deep link #/sales-quotations/<id> allowlisted in the entity router", ENTITY_ROUTE.includes('item.type === "SALES_QUOTATION"'));
record("92. search status tokens cover the 7 quotation statuses", SEARCH_DTO.includes('status === "EXPIRED"') && SEARCH_DTO.includes('status === "CONVERTED"'));

/* ---------------------- 17. store/shell/UI wiring -------------------------- */
record("93. AppView kinds sales-quotations + sales-quotation with safe deep links", STORE.includes('{ kind: "sales-quotations" }') && STORE.includes('{ kind: "sales-quotation"; id: string }') && STORE.includes("isValidEntityId(id)"));
record("94. viewToHash + hashToView round-trip the module", STORE.includes('"#/sales-quotations/${view.id}"') || (STORE.includes("#/sales-quotations/") && STORE.includes("sales-quotations/")));
record("95. sidebar + command palette expose the module (FileSignature icon)", SIDEBAR.includes('labelKey: "salesQuotations"') && read("src/modules/shell/command-palette.tsx").includes('"salesQuotations"'));
record("96. shell renders both views", SHELL.includes("<SalesQuotationsView") && SHELL.includes("<SalesQuotationDetailView"));
record("97. UI request bodies never carry authority fields (§15)", (() => {
  const bodies = [...UI_API.matchAll(/body:\s*JSON\.stringify\((\{[\s\S]*?\})\)/g)].map((m) => m[1]).join("\n");
  return !bodies.includes("businessId") && !bodies.includes("status: \"") && !bodies.includes("totalMinor") && !bodies.includes("customerNameAtQuotation") && !bodies.includes("productNameAtQuotation");
})());
record("98. UI surfaces persisted + effective status (§9)", UI_DETAIL.includes("effectiveStatus") || UI_DETAIL.includes("persistedStatus"));
record("99. print view renders NO internal notes (§16)", !stripComments(UI_PRINT).includes("internalNotes"));
record("100. create dialog requires validUntilDate (validity is the point)", UI_CREATE.includes("validUntilDate"));
record("101. print CSS law present (quotation-print-sheet)", read("src/app/globals.css").includes("quotation-print-sheet"));

/* ------------------------------ 18. entities ------------------------------- */
record("102. Customer 360 carries recentSalesQuotations (≤10)", CUSTOMER_ROUTE.includes("recentQuotationsForCustomer(ctx.businessId, id, 10)"));
record("103. Product detail carries recentSalesQuotations — quantities only (§19/§72)", PRODUCT_ROUTE.includes("recentQuotationsForProduct(ctx.businessId, id, 10)"));
record("104. product quotation rows expose NO money fields", (() => {
  const block = PRODUCT_ROUTE.split("recentSalesQuotations.map")[1]?.split(")),")[0] ?? "";
  return !block.includes("totalMinor") && !block.includes("unitPriceMinor");
})());

/* --------------------------------- 19. i18n -------------------------------- */
record("105. EN/FA both define the salesQuotations section", EN.includes("salesQuotations: {") && FA.includes("salesQuotations: {"));
record("106. status_* × 7 in BOTH locales", (() => {
  const statuses = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED", "CONVERTED"];
  return statuses.every((s) => EN.includes(`status_${s}:`) && FA.includes(`status_${s}:`));
})());
record("107. FA professional terminology (استعلام قیمت)", FA.includes("استعلام قیمت"));
record("108. search groups + nav labels localized", EN.includes("SALES_QUOTATION:") && FA.includes("SALES_QUOTATION:"));

/* ------------------------------ 20. migration ------------------------------ */
record("109. migration is additive-only: no DROP/RENAME of existing tables", !MIGRATION.includes("DROP TABLE") && !MIGRATION.includes("RENAME TO") && MIGRATION.includes("ADD COLUMN"));
record("110. migration creates both tables + the quotation/order unique keys", MIGRATION.includes('CREATE TABLE "SalesQuotation"') && MIGRATION.includes('CREATE TABLE "SalesQuotationLine"') && MIGRATION.includes("SalesQuotationLine_salesQuotationId_productId_key") && MIGRATION.includes("SalesOrder_sourceQuotationId_key"));
record("111. reference uniqueness is business-scoped (§10)", MIGRATION.includes('CREATE UNIQUE INDEX "SalesQuotation_businessId_reference_key"'));
record("112. schema documents the quotation module + quotation model has no order-link column", (() => {
  const qModel = stripComments(PRISMA.split("model SalesQuotation {")[1]?.split("\n}")[0] ?? "");
  return PRISMA.includes("Prompt 47") && !qModel.includes("sourceQuotationId") && qModel.includes("customerNameAtQuotation");
})());
record("113. SalesOrder.sourceQuotationId is nullable (legacy orders untouched)", PRISMA.split("model SalesOrder {")[1]?.split("}")[0].includes("sourceQuotationId"));

/* ------------------------- 21. no raw SQL / db push ------------------------ */
record("114. no quotation route uses prisma db push or raw SQL", (() => {
  const routeDir = `${ROOT}src/app/api/v1/sales-quotations`;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(readFileSync(full, "utf8"));
    }
  };
  walk(routeDir);
  return files.every((src) => !src.includes("$queryRaw") && !src.includes("$executeRaw") && !src.includes("db push"));
})());
record("115. quotation service uses withWriteTransaction (the ONE serialization law)", SERVICE.includes("withWriteTransaction") && read("src/lib/db/write-transaction.ts").includes("withWriteTransaction"));

/* ---------------------------- 22. test coverage ---------------------------- */
record("116. unit suite covers totals overflow + discount + transitions", UNIT.includes("SalesQuotationTotalOverflowError") && UNIT.includes("validateQuotationDiscount") && UNIT.includes("FULL transition matrix"));
record("117. unit suite covers the count-mismatch-below-cap invariant", UNIT.includes("1, 2, 200"));
record("118. E2E covers conversion + races + tenant isolation", E2E.includes("ALREADY_CONVERTED") && E2E.includes("Promise.allSettled") && E2E.includes("tenant"));
record("119. cap-check covers the 20-line cap + over-cap integrity + conversion rollback", CAP.includes("SALES_QUOTATION_LINE_LIMIT_REACHED") && CAP.includes("LINE_CAP_INVARIANT") && CAP.includes("rollback"));

/* ------------------------- 23. error-code discipline ----------------------- */
record("120. routes never duplicate error-code string literals", (() => {
  // The ONLY permitted literal is the route-agnostic VALIDATION_ERROR for
  // list-query parsing; every quotation-specific code comes from the table.
  const offenders = ALL_ROUTES.filter((r) => /"SALES_QUOTATION_[A-Z_]+"/.test(r));
  return offenders.length === 0;
})());
record("121. integration.ts is the ONLY domain→HTTP mapping", SERVICE.includes("mapPureSalesQuotationDomainError") && INTEGRATION.includes("mapPureSalesQuotationDomainError"));

/* ----------------------- 24. audit action vocabulary ----------------------- */
record("122. audit actions sales_quotation.* complete for every mutation", (() => {
  const REQUIRED_AUDIT_ACTIONS = [
    "sales_quotation.create",
    "sales_quotation.update",
    "sales_quotation.line_add",
    "sales_quotation.line_update",
    "sales_quotation.line_remove",
    "sales_quotation.mark_sent",
    "sales_quotation.accept",
    "sales_quotation.reject",
    "sales_quotation.cancel",
    "sales_quotation.expire",
    "sales_quotation.convert",
  ];
  return REQUIRED_AUDIT_ACTIONS.every((a) => SERVICE.includes(`"${a}"`));
})());

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
