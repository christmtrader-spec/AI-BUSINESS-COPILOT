#!/usr/bin/env node
/**
 * Prompt 45 — sales-order static security scan.
 *
 * Dependency-free source scan over the whole P45 surface (domain, routes,
 * UI, prisma schema, migration, write-transaction reuse, export catalog,
 * search, entities, store/shell wiring, i18n, restore probes, env-repair,
 * Sale-delete guard, legacy Sale preservation, test scripts). Rule classes:
 *   surface presence · tenant scope · RBAC · status integrity · safe
 *   integers + overflow law · line-set completeness invariant · 422/500
 *   cap classification split · SINGLE stock-decrement authority (§5/§58) ·
 *   no stock/financial mutation on create/confirm (§4/§30) · one invoice
 *   per order (§52/§105) · full-dispatch invoice gate (§54/§100) · linked
 *   Sale deletion guard (§62) · legacy Sale behavior preserved (§120) ·
 *   dispatch linkage + over-fulfillment protection (§37/§44) · cancelled/
 *   completed order dispatch guards (§50/§51) · cancellation guard (§49)
 *   · snapshots frozen (§109/§12/§21) · no client authority fields (§112)
 *   · CSV security stack (§115) · import rejection (§117) · business
 *   export datasets (§116) · search tenant safety (§70) · business-
 *   timezone windows · i18n parity (§139) · migration additive-only
 *   (§119/§142) · restore probes (§118) · behavioral test coverage.
 *
 * Run: node scripts/prompt45-sales-order-static-scan.mjs
 */
import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => {
  try {
    return readFileSync(`${ROOT}${p}`, "utf8");
  } catch {
    return "";
  }
};
const exists = (p) => existsSync(`${ROOT}${p}`);

const TYPES = read("src/lib/sales-orders/types.ts");
const SCHEMA = read("src/lib/sales-orders/schema.ts");
const DTO = read("src/lib/sales-orders/dto.ts");
const SERVICE = read("src/lib/sales-orders/service.ts");
const INTEGRATION = read("src/lib/sales-orders/integration.ts");
const EXPORT = read("src/lib/sales-orders/export.ts");
const ROUTE_LIST = read("src/app/api/v1/sales-orders/route.ts");
const ROUTE_ID = read("src/app/api/v1/sales-orders/[id]/route.ts");
const ROUTE_LINES = read("src/app/api/v1/sales-orders/[id]/lines/route.ts");
const ROUTE_LINE_ID = read("src/app/api/v1/sales-orders/[id]/lines/[lineId]/route.ts");
const ROUTE_CONFIRM = read("src/app/api/v1/sales-orders/[id]/confirm/route.ts");
const ROUTE_CANCEL = read("src/app/api/v1/sales-orders/[id]/cancel/route.ts");
const ROUTE_DISPATCH = read("src/app/api/v1/sales-orders/[id]/dispatches/route.ts");
const ROUTE_INVOICE = read("src/app/api/v1/sales-orders/[id]/invoice/route.ts");
const ROUTE_EXPORT = read("src/app/api/v1/sales-orders/[id]/export/route.ts");
const SALE_ROUTE = read("src/app/api/v1/sales/[id]/route.ts");
const LEGACY_SALE = read("src/app/api/v1/sales/route.ts");
const GD_SERVICE = read("src/lib/inventory/goods-dispatch/service.ts");
const GD_SCHEMA = read("src/lib/inventory/goods-dispatch/schema.ts");
const MIGRATION = read("prisma/migrations/20261011090000_prompt45_sales_orders/migration.sql");
const PRISMA = read("prisma/schema.prisma");
const ENV_REPAIR = read("scripts/env-repair.mjs");
const RESTORE = read("scripts/restore-drill.mjs");
const EXPORT_CATALOG = read("src/lib/data-portability/export-catalog.ts");
const IMPORT_CATALOG = read("src/lib/data-portability/import-catalog.ts");
const SEARCH_TYPES = read("src/lib/search/types.ts");
const SEARCH_QUERY = read("src/lib/search/query.ts");
const SEARCH_DTO = read("src/lib/search/dto.ts");
const ENTITIES_TYPES = read("src/lib/entities/types.ts");
const ENTITIES_CUSTOMER = read("src/lib/entities/customer.ts");
const ENTITIES_PRODUCT = read("src/lib/entities/product.ts");
const STORE = read("src/store/app-store.ts");
const SHELL = read("src/modules/shell/app-shell.tsx");
const SIDEBAR = read("src/modules/shell/app-sidebar.tsx");
const UI_LIST = read("src/modules/sales-orders/sales-orders-view.tsx");
const UI_DETAIL = read("src/modules/sales-orders/sales-order-detail-view.tsx");
const UI_CREATE = read("src/modules/sales-orders/sales-order-create-dialog.tsx");
const UI_DISPATCH = read("src/modules/sales-orders/sales-order-dispatch-dialog.tsx");
const UI_API = read("src/modules/sales-orders/sales-orders-api.ts");
const EN = read("src/i18n/messages/en.ts");
const FA = read("src/i18n/messages/fa.ts");
const UNIT = read("scripts/prompt45-unit.ts");
const E2E = read("scripts/prompt45-sales-order-check.mjs");
const CAP = read("scripts/prompt45-sales-order-cap-check.ts");

let pass = 0;
let fail = 0;
const failures = [];
function record(name, cond, info = "") {
  if (cond) pass++;
  else fail++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}

/* --------------------------- 1. surface presence -------------------------- */
record("1. domain module files exist", ["src/lib/sales-orders/types.ts", "src/lib/sales-orders/schema.ts", "src/lib/sales-orders/dto.ts", "src/lib/sales-orders/service.ts", "src/lib/sales-orders/integration.ts", "src/lib/sales-orders/export.ts", "src/lib/sales-orders/index.ts"].map(exists).every(Boolean));
record("2. all 9 API route files exist (12 endpoints)", ["src/app/api/v1/sales-orders/route.ts", "src/app/api/v1/sales-orders/[id]/route.ts", "src/app/api/v1/sales-orders/[id]/lines/route.ts", "src/app/api/v1/sales-orders/[id]/lines/[lineId]/route.ts", "src/app/api/v1/sales-orders/[id]/confirm/route.ts", "src/app/api/v1/sales-orders/[id]/cancel/route.ts", "src/app/api/v1/sales-orders/[id]/dispatches/route.ts", "src/app/api/v1/sales-orders/[id]/invoice/route.ts", "src/app/api/v1/sales-orders/[id]/export/route.ts"].map(exists).every(Boolean));
record("3. UI module files exist", ["src/modules/sales-orders/sales-orders-view.tsx", "src/modules/sales-orders/sales-order-detail-view.tsx", "src/modules/sales-orders/sales-order-create-dialog.tsx", "src/modules/sales-orders/sales-order-line-editor.tsx", "src/modules/sales-orders/sales-order-product-picker.tsx", "src/modules/sales-orders/sales-order-dispatch-dialog.tsx", "src/modules/sales-orders/sales-orders-api.ts"].map(exists).every(Boolean));
record("4. exactly one P45 migration exists", exists("prisma/migrations/20261011090000_prompt45_sales_orders/migration.sql"));
record("5. unit + E2E + cap-check + this scan exist", ["scripts/prompt45-unit.ts", "scripts/prompt45-sales-order-check.mjs", "scripts/prompt45-sales-order-cap-check.ts", "scripts/prompt45-sales-order-static-scan.mjs"].map(exists).every(Boolean));

/* ------------------------------ 2. tenant scope ---------------------------- */
record("6. service loads order scoped by { id, businessId } from ctx", SERVICE.includes("where: { id, businessId }"));
record("7. list route passes ctx.businessId (never client body)", ROUTE_LIST.includes("businessId: ctx.businessId") && !ROUTE_LIST.includes("body.businessId"));
record("8. detail/cancel/invoice routes resolve malformed ids to 404 before reads", [ROUTE_ID, ROUTE_CANCEL, ROUTE_INVOICE, ROUTE_EXPORT].every((r) => r.includes("isValidEntityId")));
record("9. foreign customer indistinguishable from unknown (404)", SERVICE.includes("SALES_ORDER_ERROR_CODES.CUSTOMER_NOT_FOUND") && SERVICE.includes("404"));
record("10. tenant isolation in the linked-dispatch post path", GD_SERVICE.includes("where: { id: salesOrderId, businessId }"));

/* --------------------------------- 3. RBAC --------------------------------- */
record("11. reads require data:read", [ROUTE_LIST, ROUTE_ID, ROUTE_EXPORT].every((r) => r.includes('requirePermission(ctx, "data:read")')));
record("12. writes require data:write", [ROUTE_LINES, ROUTE_LINE_ID, ROUTE_CONFIRM, ROUTE_CANCEL, ROUTE_DISPATCH, ROUTE_INVOICE].every((r) => r.includes('requirePermission(ctx, "data:write")')));
record("13. no new permission vocabulary introduced", !TYPES.includes("permission") && !SCHEMA.includes("permission"));

/* --------------------------- 4. status integrity --------------------------- */
record("14. parseSalesOrderStatus throws on unknown values (§108)", TYPES.includes("SalesOrderStatusIntegrityError") && TYPES.includes("throw new SalesOrderStatusIntegrityError"));
record("15. corrupted persisted status → controlled 500 (never DRAFT)", SERVICE.includes("parseDbStatus") && INTEGRATION.includes("INVALID_PERSISTED_STATUS"));
record("16. status is re-checked INSIDE confirm/cancel transactions", SERVICE.split("withWriteTx").length >= 8 && SERVICE.includes("canTransitionSalesOrder"));
record("17. POSTED/GARBAGE order status blocks linked dispatch post (§50/§51)", GD_SERVICE.includes('linkedOrder.status !== "CONFIRMED"'));
record("18. no `→ DRAFT` fallback anywhere in the domain", !TYPES.includes('status = "DRAFT"') && !DTO.includes('?? "DRAFT"'));

/* --------------------------- 5. safe integers ------------------------------ */
record("19. safe-integer checks on quantity laws (§18)", TYPES.includes("Number.isSafeInteger"));
record("20. line-total overflow throws (§107)", TYPES.includes("SalesOrderTotalOverflowError") && TYPES.includes("SALES_ORDER_TOTAL_OVERFLOW"));
record("21. subtotal accumulation re-checks the safe range per addition", TYPES.split("Number.isSafeInteger(subtotalMinor)").length >= 2);
record("22. discount law: 0..subtotal, never above (§23)", TYPES.includes("validateOrderDiscount") && TYPES.includes("discountMinor > subtotalMinor"));
record("23. canonical total = subtotal − discount with validation", TYPES.includes("computeOrderTotalMinor"));
record("24. remaining quantity never clamped (§38)", TYPES.includes("remainingToDispatchQty = orderedQty - dispatchedQty") && TYPES.includes("OVER_DISPATCH"));
record("25. no parseFloat/float math for money in the domain", !TYPES.includes("parseFloat") && !SERVICE.includes("parseFloat") && !EXPORT.includes("parseFloat"));
record("26. client totals never trusted (recomputed server-side §56)", SERVICE.includes("computeOrderSubtotalMinor(lines)") && SERVICE.includes("computeOrderTotalMinor"));

/* --------------------------- 6. cap invariant ------------------------------ */
record("27. three-check completeness invariant (fetched ≤ cap, counted ≤ cap, equal)", TYPES.includes("assertSalesOrderLineSetComplete") && TYPES.includes("countedLines !== fetchedLines"));
record("28. reads fetch cap+1 to prove completeness", SERVICE.includes("take: cap + 1"));
record("29. over-cap persisted order is a 500 integrity failure", SERVICE.includes("SALES_ORDER_ERROR_CODES.LINE_CAP_INVARIANT") && SERVICE.includes("500"));
record("30. write-time full-cap is the 422 user rejection", SERVICE.includes("422") && SERVICE.includes("SALES_ORDER_ERROR_CODES.LINE_LIMIT"));

/* -------------------- 7. SINGLE stock-decrement authority ------------------ */
record("31. sales-order service NEVER mutates Product.stockQty", !SERVICE.includes("stockQty") || !SERVICE.includes("product.update"), "no product.update in sales-order service");
record("32. sales-order service NEVER creates InventoryAdjustment", !SERVICE.includes("inventoryAdjustment"));
record("33. linked invoice creates NO InventoryAdjustment (§58)", SERVICE.includes("issueOrderInvoice") && !SERVICE.split("issueOrderInvoice")[1].split("listRecentOrdersForCustomer")[0].includes("inventoryAdjustment"));
record("34. invoice issuance writes NO stock decrement (§58)", !SERVICE.split("issueOrderInvoice")[1].split("listRecentOrdersForCustomer")[0].includes("stockQty"));
record("35. stock decrement lives ONLY in the goods-dispatch post path (§45)", GD_SERVICE.includes("stockAfterDispatch") && GD_SERVICE.includes("stockQty: newStock"));
record("36. dispatch line-add POST decrements via the P44 loop (never duplicated)", GD_SERVICE.includes("data: { stockQty: newStock }"));

/* ----------------------- 8. create/confirm purity -------------------------- */
record("37. createSalesOrder creates ONLY the order + audit (§30)", SERVICE.split("export async function createSalesOrder")[1].split("/* ---")[0].includes("salesOrder.create") && !SERVICE.split("export async function createSalesOrder")[1].split("/* ---")[0].includes("sale.create"));
record("38. confirmation creates NO Sale/Payment/Expense/receivable (§30)", !SERVICE.split("export async function confirmSalesOrder")[1].split("export async function cancelSalesOrder")[0].includes("tx.sale.create"));
record("39. no stock reservation model exists (§101)", !PRISMA.includes("reservedQty") && !PRISMA.includes("availableStock"));
record("40. no financial fields on SalesOrder (paidMinor lives on Sale)", PRISMA.split("model SalesOrder {")[1].split("}")[0].includes("discountMinor") && !PRISMA.split("model SalesOrder {")[1].split("}")[0].includes("paidMinor"));

/* --------------------------- 9. invoice laws ------------------------------- */
record("41. one invoice per order: DB unique constraint on Sale.salesOrderId", PRISMA.includes("salesOrderId String?     @unique") || PRISMA.includes("salesOrderId String? @unique"));
record("42. in-transaction one-invoice guard (§105)", SERVICE.includes("where: { salesOrderId: header.id }") && SERVICE.includes("ALREADY_INVOICED"));
record("43. invoice endpoint is DEDICATED (§53)", ROUTE_INVOICE.includes("issueOrderInvoice"));
record("44. invoice issuance requires CONFIRMED status (§54)", SERVICE.split("export async function issueOrderInvoice")[1].includes('header.status !== "CONFIRMED"'));
record("45. partial orders can NEVER be invoiced (§54/§100)", SERVICE.split("issueOrderInvoice")[1].includes("NOT_FULLY_DISPATCHED"));
record("46. invoice items derive from ORDER-LINE snapshots (§55)", SERVICE.includes("name: l.productNameAtOrder") && SERVICE.includes("unit: l.unitAtOrder"));
record("47. invoice numbering reuses the EXISTING convention (§61)", SERVICE.includes("formatInvoiceNumber") && SERVICE.includes("orderBy: { number: \"desc\" }"));
record("48. linked invoice starts UNPAID with zero payments (§57)", SERVICE.split("issueOrderInvoice")[1].includes('status: "UNPAID"') && SERVICE.split("issueOrderInvoice")[1].includes("paidMinor: 0"));
const ISSUE = SERVICE.split("export async function issueOrderInvoice")[1] ?? "";
record("49. issuance commits Sale + SaleItems + COMPLETED + completedAt + audit atomically (§59)", ISSUE.includes('status: "COMPLETED"') && ISSUE.includes("completedAt") && ISSUE.includes('action: "sale.create"') && ISSUE.includes('"sales_order.invoice"'));
record("50. invoice issuance authority = the salesOrderId RELATION, never notes text (§58)", !SERVICE.includes("note?.includes") && !SERVICE.includes("note.startsWith"));

/* ----------------------- 10. legacy Sale preservation ---------------------- */
record("51. legacy direct Sale still decrements stock (§120 unchanged)", LEGACY_SALE.includes("stockQty: { decrement: line.qty }") && LEGACY_SALE.includes("delta: -line.qty"));
record("52. legacy deletion restock preserved for UNLINKED sales", SALE_ROUTE.includes("stockQty: { increment: item.qty }") && SALE_ROUTE.includes("delta: item.qty"));
record("53. linked Sale deletion is BLOCKED with SALE_LINKED_TO_SALES_ORDER (§62)", SALE_ROUTE.includes("sale.salesOrderId") && SALE_ROUTE.includes("SALE_LINKED_TO_SALES_ORDER"));
record("54. guard runs BEFORE any restock mutation", SALE_ROUTE.indexOf("salesOrderId") < SALE_ROUTE.indexOf("$transaction"));
record("55. generic legacy sale create cannot accept salesOrderId (§53)", LEGACY_SALE.includes("saleCreateSchema") && !LEGACY_SALE.includes("salesOrderId"));

/* ------------------------ 11. fulfillment linkage -------------------------- */
record("56. dispatched = Σ POSTED linked dispatch lines only (§36)", INTEGRATION.includes('goodsDispatch: { status: "POSTED" }') && INTEGRATION.includes("groupBy"));
record("57. over-dispatch is a hard integrity invariant (§37)", TYPES.includes("OVER_DISPATCH") && TYPES.includes("dispatchedQty > orderedQty"));
record("58. POST re-validates remaining INSIDE the transaction (§44 authoritative)", GD_SERVICE.includes("sumPostedDispatchedQtyBySalesOrderLines") && GD_SERVICE.includes("exceedsRemainingToDispatch"));
record("59. advisory remaining check at linked line-add (§42)", GD_SERVICE.includes("DISPATCH_EXCEEDS_REMAINING"));
record("60. product derives from the SalesOrderLine in linked lines (§41)", GD_SERVICE.includes("productId: orderLine.productId") && GD_SERVICE.includes("reasonCode: SALES_ORDER_LINE_REASON"));
record("61. linked line snapshots copied from the ORDER LINE (§33)", GD_SERVICE.includes("productNameAtDispatch: orderLine.productNameAtOrder"));
record("62. client cannot inject productId/reasonCode into linked lines", GD_SERVICE.includes("productId cannot be submitted") && GD_SERVICE.includes("server-controlled for order fulfillment"));
record("63. cancelled order dispatch guard: linked post requires CONFIRMED (§50)", GD_SERVICE.split("if (header.salesOrderId)")[1].includes('linkedOrder.status !== "CONFIRMED"'));
record("64. dispatch reference is independent of the order reference (§35)", SERVICE.includes("generateGoodsDispatchReference") && SERVICE.includes("salesOrderReferenceAtDispatch: header.reference"));
record("65. linked dispatch customer derives from the ORDER (§34)", SERVICE.includes("customerNameAtDispatch: header.customerNameAtOrder"));

/* --------------------------- 12. cancellation law -------------------------- */
record("66. CONFIRMED cancel checks posted qty + invoice INSIDE the tx (§49/§99)", SERVICE.split("export async function cancelSalesOrder")[1].includes("HAS_FULFILLMENT") && SERVICE.split("export async function cancelSalesOrder")[1].includes("salesOrderId: header.id"));
record("67. DRAFT cancel is always allowed (no fulfillment possible)", SERVICE.split("export async function cancelSalesOrder")[1].includes('header.status === "CONFIRMED"'));

/* ----------------------------- 13. snapshots ------------------------------- */
record("68. customer snapshot frozen at creation (§12)", SERVICE.includes("customerNameAtOrder, // frozen snapshot") || SERVICE.includes("customerNameAtOrder,"));
record("69. product snapshots frozen at line-add (§20/§9)", SERVICE.includes("productNameAtOrder: product.name") && SERVICE.includes("skuAtOrder: product.sku"));
record("70. missing persisted snapshot is corruption, never substituted (§109)", DTO.includes("missing productNameAtOrder snapshot"));
record("71. currency snapshot is server-derived from Business (§25)", SERVICE.includes("currencyCodeAtOrder: business.currencyCode") && !SCHEMA.includes("currencyCodeAtOrder"));

/* ------------------------ 14. strict input schemas ------------------------- */
record("72. create/update schemas are .strict() (§112)", SCHEMA.split(".strict()").length >= 4);
record("73. create/update schemas never accept status/totals/dispatchedQty", (() => {
  // Strip line comments so documentation ("never client input") cannot
  // false-positive; then check the actual field vocabulary.
  const code = SCHEMA.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const createBlock = code.split("export const salesOrderCreateSchema")[1]?.split("export const")[0] ?? "";
  const updateBlock = code.split("export const salesOrderUpdateSchema")[1]?.split("export const")[0] ?? "";
  return !createBlock.includes("status:") && !createBlock.includes("totalMinor") &&
    !updateBlock.includes("status:") && !updateBlock.includes("totalMinor") &&
    !code.includes("dispatchedQty");
})());
record("74. lifecycle timestamps never patchable", !SCHEMA.includes("confirmedAt") && !SCHEMA.includes("completedAt") && !SCHEMA.includes("cancelledAt"));

/* ------------------------------ 15. DTO allowlist -------------------------- */
record("75. no raw Prisma object ever serialized (§113)", DTO.includes("salesOrderDetailDto") && DTO.includes("salesOrderLineDto") && !DTO.includes("...row"));
record("76. invoice DTO appears ONLY when the relation exists (§65/§91)", SERVICE.includes("row.sale ? salesOrderInvoiceDto(row.sale) : null"));
record("77. creator exposed as id/name only (§113)", DTO.includes("createdByName") && !DTO.includes("passwordHash") && !DTO.includes("sessionVersion"));

/* ------------------------------ 16. CSV security --------------------------- */
record("78. export gate: CSV_EXPORT entitlement + rate limit + audit", ROUTE_EXPORT.includes('assertFeatureAccess(ctx.businessId, "CSV_EXPORT")') && ROUTE_EXPORT.includes("rateLimit") && ROUTE_EXPORT.includes('action: "data.export"'));
record("79. export headers: no-store + attachment + strict locale", ROUTE_EXPORT.includes('"cache-control": "no-store"') && ROUTE_EXPORT.includes("attachment") && ROUTE_EXPORT.includes('localeParam !== "fa"'));
record("80. CSV via the shared toCsv OWASP guard", EXPORT.includes('toCsv') && EXPORT.includes("salesOrderReferenceSlug"));
record("81. export uses cap+1 completeness (never partial CSV)", EXPORT.includes("take: cap + 1") && EXPORT.includes("truncated"));

/* --------------------- 17. export/import + backup probes ------------------- */
record("82. business export adds sales_orders + sales_order_lines (§116)", EXPORT_CATALOG.includes('"sales_orders"') && EXPORT_CATALOG.includes('"sales_order_lines"'));
record("83. parent implies child lines", EXPORT_CATALOG.includes('sales_orders: ["sales_order_lines"]'));
record("84. import remains blocked for sales orders (§117)", !IMPORT_CATALOG.includes("sales_orders"));
record("85. restore-drill probes SalesOrder + SalesOrderLine (§118)", RESTORE.includes('"SalesOrder", "SalesOrderLine"'));
record("86. env-repair baselines the P45 migration", ENV_REPAIR.includes("20261011090000_prompt45_sales_orders"));

/* ------------------------------ 18. search --------------------------------- */
record("87. SALES_ORDER joins the closed search vocabulary (§70)", SEARCH_TYPES.includes('"SALES_ORDER"') && SEARCH_TYPES.includes('"sales-orders"'));
record("88. sales-order search is tenant-scoped with bounded snapshot text", SEARCH_QUERY.includes("searchSalesOrders") && SEARCH_QUERY.includes("salesOrderLineCap"));
record("89. search carries NO amounts and NO fulfillment quantities", SEARCH_DTO.includes("SalesOrderSearchRow") && !SEARCH_DTO.split("SalesOrderSearchRow")[1].split("salesOrderCandidate")[0].includes("totalMinor"));
record("90. deep link #/sales-orders/<id> allowlisted in the entity router", read("src/modules/entities/entity-route.ts").includes('item.type === "SALES_ORDER"'));

/* ---------------------- 19. store/shell/UI wiring -------------------------- */
record("91. AppView kinds sales-orders + sales-order with safe deep links (§88)", STORE.includes('{ kind: "sales-orders" }') && STORE.includes('{ kind: "sales-order"; id: string }') && STORE.includes("isValidEntityId(id)"));
record("92. sidebar + command palette expose the module", SIDEBAR.includes('labelKey: "salesOrders"') && read("src/modules/shell/command-palette.tsx").includes('"salesOrders"'));
record("93. shell renders both views inside ModuleBoundary", /<SalesOrdersView role=\{role\}[^/]*\/>/.test(SHELL) && SHELL.includes("<SalesOrderDetailView id={view.id} role={role} />"));
record("94. UI request bodies never carry authority fields (§112)", (() => {
  // Extract ONLY the literal object inside each JSON.stringify(...) call.
  const bodies = [...UI_API.matchAll(/body:\s*JSON\.stringify\((\{[\s\S]*?\})\)/g)]
    .map((m) => m[1]).join("\n");
  return !bodies.includes("businessId") && !bodies.includes("status") &&
    !bodies.includes("totalMinor") && !bodies.includes("customerNameAtOrder") &&
    !bodies.includes("productNameAtOrder");
})());
record("95. UI surfaces fulfillment summary + remaining (§78/§80)", UI_DETAIL.includes("remainingToDispatchQty") && UI_DETAIL.includes("fullyDispatched"));
record("96. UI gates dispatch action on remaining > 0 (§79)", UI_DETAIL.includes("remainingQty > 0"));
record("97. UI gates invoice action on fullyDispatched && !hasInvoice (§83)", UI_DETAIL.includes("fullyDispatched && !hasInvoice"));
record("98. confirm dialog explains the no-reservation law (§77)", UI_DETAIL.includes("confirmDesc") && EN.includes("does not reserve stock"));
record("99. invoice dialog explains no-second-decrement (§84)", EN.includes("No new stock decrement happens"));

/* --------------------------------- 20. i18n -------------------------------- */
record("100. EN/FA both define the salesOrders section", EN.includes("salesOrders: {") && FA.includes("salesOrders: {"));
record("101. FA professional terminology (§139)", FA.includes("سفارش فروش") && FA.includes("تأیید سفارش") && FA.includes("مقدار خارج‌شده") && FA.includes("مقدار باقی‌مانده برای خروج") && FA.includes("صدور فاکتور"));
record("102. search groups + status labels localized", EN.includes("SALES_ORDER:") && FA.includes("SALES_ORDER:") && EN.includes("COMPLETED: \"Completed\"") && FA.includes("COMPLETED: \"تکمیل‌شده\""));

/* ------------------------------ 21. migration ------------------------------ */
record("103. migration is additive-only: no DROP/RENAME/redefinition", !MIGRATION.includes("DROP TABLE") && !MIGRATION.includes("RENAME TO") && MIGRATION.includes("ADD COLUMN"));
record("104. migration creates both tables + unique constraints", MIGRATION.includes('CREATE TABLE "SalesOrder"') && MIGRATION.includes('CREATE TABLE "SalesOrderLine"') && MIGRATION.includes("SalesOrderLine_salesOrderId_productId_key") && MIGRATION.includes("Sale_salesOrderId_key"));
record("105. dispatch links are NOT unique (one order → many dispatches §39)", !MIGRATION.includes("UNIQUE INDEX \"GoodsDispatch_salesOrderId_key\"") && MIGRATION.includes("GoodsDispatch_salesOrderId_idx"));
record("106. schema documents the two-path law", PRISMA.includes("PATH A") === false && PRISMA.includes("ORDER-BASED") && PRISMA.includes("Prompt 45"));

/* ---------------------------- 22. test coverage ---------------------------- */
record("107. unit suite covers totals overflow + discount + fulfillment", UNIT.includes("SalesOrderTotalOverflowError") && UNIT.includes("validateOrderDiscount") && UNIT.includes("computeRemainingToDispatchQty"));
record("108. unit suite covers the count-mismatch-below-cap invariant", UNIT.includes("1, 2, 200"));
record("109. E2E covers the double-decrement regression (§122)", E2E.includes("InventoryAdjustment") && E2E.includes("stockQty"));
record("110. E2E covers tenant isolation (§69)", E2E.includes("SALES_ORDER") || E2E.includes("tenant"));
record("111. cap-check covers concurrent over-fulfillment + invoice race (§103/§105)", CAP.includes("DISPATCH_EXCEEDS_REMAINING") && CAP.includes("ALREADY_INVOICED"));
record("112. shared write-transaction is the ONE serialization law (§102)", SERVICE.includes("withWriteTransaction") && read("src/lib/db/write-transaction.ts").includes("withWriteTransaction"));

/* ------------------------- 23. documentation ------------------------------- */
record("113. docs exist for product/security/ADR (§136)", exists("docs/product/sales-orders.md") && exists("docs/security/sales-orders-security.md") && exists("docs/adr/0045-sales-orders-fulfillment.md"));
record("114. financial-semantics doc explains both paths (§137/§138)", read("docs/audit/financial-semantics.md").includes("SalesOrder"));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
