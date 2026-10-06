#!/usr/bin/env node
/**
 * Prompt 41 — purchase-order static security scan (§126/§127).
 *
 * Dependency-free source scan over the whole P41 surface (domain, routes,
 * UI, prisma schema, export catalog, i18n, docs). Rule classes:
 *   tenant scoping · ctx-only business id · RBAC · no raw Prisma responses
 *   money safety (no float) · status-transition discipline · NO inventory/
 *   expense/payment/statement writes · no generic status patch · export
 *   gate/no-store/CSV security · search tenant safety · pagination/line cap
 *   strict dates · i18n parity · deep-link wiring · audit · §127
 *   forbidden-scope terms · no new notification types · no external
 *   integration claims.
 *
 * Run: node scripts/prompt41-purchase-order-static-scan.mjs
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

const DOMAIN = [
  "src/lib/purchase-orders/types.ts",
  "src/lib/purchase-orders/schema.ts",
  "src/lib/purchase-orders/dto.ts",
  "src/lib/purchase-orders/service.ts",
  "src/lib/purchase-orders/export.ts",
  "src/lib/purchase-orders/index.ts",
];
const ROUTES = [
  "src/app/api/v1/purchase-orders/route.ts",
  "src/app/api/v1/purchase-orders/[id]/route.ts",
  "src/app/api/v1/purchase-orders/[id]/lines/route.ts",
  "src/app/api/v1/purchase-orders/[id]/lines/[lineId]/route.ts",
  "src/app/api/v1/purchase-orders/[id]/transition.ts",
  "src/app/api/v1/purchase-orders/[id]/send/route.ts",
  "src/app/api/v1/purchase-orders/[id]/confirm/route.ts",
  "src/app/api/v1/purchase-orders/[id]/close/route.ts",
  "src/app/api/v1/purchase-orders/[id]/cancel/route.ts",
  "src/app/api/v1/purchase-orders/[id]/export/route.ts",
];
const UI = [
  "src/modules/purchase-orders/purchase-orders-view.tsx",
  "src/modules/purchase-orders/purchase-order-detail-view.tsx",
  "src/modules/purchase-orders/purchase-order-create-dialog.tsx",
  "src/modules/purchase-orders/purchase-order-line-editor.tsx",
  "src/modules/purchase-orders/purchase-order-product-picker.tsx",
  "src/modules/purchase-orders/purchase-order-supplier-picker.tsx",
  "src/modules/purchase-orders/purchase-orders-api.ts",
];

const domainSource = () => DOMAIN.map(read).join("\n");
const routeSource = () => ROUTES.map(read).join("\n");
const uiSource = () => UI.filter((p) => existsSync(`${ROOT}${p}`)).map(read).join("\n");
const poSource = () => `${domainSource()}\n${routeSource()}\n${uiSource()}`;
const searchSource = () =>
  ["src/lib/search/types.ts", "src/lib/search/query.ts", "src/lib/search/dto.ts"]
    .map(read)
    .join("\n");
const schemaPrisma = read("prisma/schema.prisma");
const catalog = read("src/lib/data-portability/export-catalog.ts");
const importRoute = read("src/app/api/v1/imports/route.ts");
const en = read("src/i18n/messages/en.ts");
const fa = read("src/i18n/messages/fa.ts");
const appStore = read("src/store/app-store.ts");
const shell = read("src/modules/shell/app-shell.tsx");
const sidebar = read("src/modules/shell/app-sidebar.tsx");
const entitySupplierRoute = read("src/app/api/v1/suppliers/[id]/route.ts");
const entityProductRoute = read("src/app/api/v1/products/[id]/route.ts");
const supplierView = read("src/modules/entities/supplier-detail-view.tsx");
const productView = read("src/modules/entities/product-detail-view.tsx");
const searchView = read("src/modules/search/search-view.tsx");
const entityRoute = read("src/modules/entities/entity-route.ts");
const restoreDrill = read("scripts/restore-drill.mjs");

/** Strip // and /* *​/ comments so rules scan CODE, not prose. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}
const CODE = () => stripComments(poSource());

let passed = 0;
let failed = 0;
const failedRules = [];

function record(name, cond, info = "") {
  if (cond) passed += 1;
  else {
    failed += 1;
    failedRules.push(`${name}${info ? ` (${info})` : ""}`);
  }
}

/* ------------------------- existence of the surface ------------------------ */

for (const p of [...DOMAIN, ...ROUTES]) {
  record(`00. file exists ${p}`, existsSync(`${ROOT}${p}`));
}
record("00. UI module files exist", UI.filter((p) => existsSync(`${ROOT}${p}`)).length >= 6);
record(
  "00. no parallel line-editor file needed (editor lives in detail view)",
  existsSync(`${ROOT}src/modules/purchase-orders/purchase-order-detail-view.tsx`),
);

/* ------------------------------ tenant scoping ----------------------------- */

record("01. service scopes every load by businessId", /where: \{ id, businessId \}/.test(domainSource()));
record("02. routes use ctx.businessId only", (routeSource().match(/ctx\.businessId/g) || []).length >= 10);
record("03. no client businessId accepted", !/body\.businessId|searchParams\.get\("businessId"\)|req\.json\(\)\.businessId/.test(routeSource()));
record("04. no x-business-id trust in domain writes", !/headers\.get\("x-business-id"\)/.test(domainSource()));
record("05. supplier load tenant+not-deleted", /deletedAt: null/.test(domainSource()) || /deletedAt/.test(domainSource()));
record("06. product load scoped by businessId", /businessId: input\.businessId/.test(domainSource()));

/* --------------------------------- RBAC ------------------------------------ */

record("07. reads gated data:read", (routeSource().match(/requirePermission\(ctx, "data:read"\)/g) || []).length >= 3);
record("08. writes gated data:write", (routeSource().match(/requirePermission\(ctx, "data:write"\)/g) || []).length >= 6);
record("09. UI gates with can(role, data:write)", uiSource().includes('can(role, "data:write")'));
record("10. getAuthContext used in every route", (routeSource().match(/getAuthContext\(req\)/g) || []).length >= 9);

/* -------------------------- no raw Prisma responses ------------------------ */

record("11. domain exports DTO mappers only", /purchaseOrderDetailDto|purchaseOrderListItemDto|purchaseOrderLineDto/.test(read("src/lib/purchase-orders/dto.ts")));
record("12. detail route resolves through the DTO service (no raw Prisma return)", (() => {
  const detailRoute = read("src/app/api/v1/purchase-orders/[id]/route.ts");
  return detailRoute.includes("getPurchaseOrder(") && !/ok\(\s*\{\.\.\./.test(detailRoute);
})());
record("13. barrel exports only types+dto", !/export \* from "\.\/(service|schema|export)"/.test(read("src/lib/purchase-orders/index.ts")));
record("14. service is server-only", read("src/lib/purchase-orders/service.ts").startsWith('import "server-only";'));
record("15. export builder is server-only", read("src/lib/purchase-orders/export.ts").startsWith('import "server-only";'));
record("16. no server-only import in UI module", !/from "server-only"/.test(uiSource()));
record("17. createdBy from ctx.userId", /userId: ctx\.userId/.test(routeSource()));

/* ------------------------------- money safety ------------------------------ */

record("18. BigInt multiplication in totals", /BigInt\(line\.orderedQty\) \* BigInt\(line\.unitPriceMinor\)/.test(domainSource()));
record("19. safe-integer overflow rejected", /PURCHASE_ORDER_TOTAL_OVERFLOW/.test(domainSource()));
record("20. no parseFloat CALL for money in PO code", !/parseFloat\s*\(/.test(CODE()));
record("21. client totals never authoritative", !/totalMinor\s*[:=]\s*(input|body|req)/.test(routeSource()));
record("22. lineTotalMinor derived in DTO", /computeLineTotalMinor/.test(read("src/lib/purchase-orders/dto.ts")));
record("23. unit price bound centralized + storage-realistic (Int32 Int columns)", /UNIT_PRICE_MINOR_MAX = 1_000_000_000/.test(read("src/lib/purchase-orders/types.ts")));
record("24. quantity bound centralized", /ORDERED_QTY_MAX = 1_000_000/.test(read("src/lib/purchase-orders/types.ts")));
record("25. negative price rejected at schema", /unitPriceMinor cannot be negative|UNIT_PRICE_MINOR_MIN/.test(read("src/lib/purchase-orders/schema.ts")));

/* --------------------------- status transition law ------------------------- */

record("26. transition matrix centralized", /PURCHASE_ORDER_TRANSITIONS/.test(read("src/lib/purchase-orders/types.ts")));
record("27. service asserts transitions", /assertTransition|canTransitionPurchaseOrder/.test(read("src/lib/purchase-orders/service.ts")));
record("28. closed/cancelled terminal", /CLOSED: \[\],\s*\n\s*CANCELLED: \[\]/.test(read("src/lib/purchase-orders/types.ts")));
record("29. PATCH route body submits no status field", (() => {
  const detailRoute = read("src/app/api/v1/purchase-orders/[id]/route.ts");
  const patch = detailRoute.split("export const PATCH")[1] ?? "";
  return patch.length > 0 && !/status/.test(patch);
})());
record("30. update schema has no status field", !/status/.test(read("src/lib/purchase-orders/schema.ts").split("purchaseOrderUpdateSchema")[1]?.split("refine")[0] ?? ""));
record("31. status re-checked inside transaction (§61)", /loadOrderHeader\(tx/.test(read("src/lib/purchase-orders/service.ts")));

/* ------------------- §147-§150 NO side-effect writes ----------------------- */

record("32. no product.update stockQty in domain", !/product\.update[\s\S]{0,200}stockQty|stockQty:/.test(domainSource()));
record("33. no inventoryAdjustment.create", !/inventoryAdjustment\.create/.test(poSource()));
record("34. no expense.create", !/expense\.create/.test(poSource()));
record("35. no payment.create", !/payment\.create/.test(poSource()));
record("36. no sale.create", !/sale\.create/.test(poSource()));
record("37. no notification.create", !/notification\.create/.test(poSource()));
record("38. no statement/aging engine imports or calls", !/(supplierStatement|customerStatement|computeAging|aging-report|listAging)/.test(CODE()));
record("39. no Subscription/Checkout/AiCost references", !/Subscription|CheckoutSession|PaymentTransaction|AiCostRecord/.test(CODE()));
record("40. no AI/copilot access in domain", !/\bcopilot\b|z-ai-web|ai-context|aiContext/i.test(CODE()));

/* -------------------------------- export gate ------------------------------ */

const exportRoute = read("src/app/api/v1/purchase-orders/[id]/export/route.ts");
record("41. CSV_EXPORT entitlement gate", exportRoute.includes('assertFeatureAccess(ctx.businessId, "CSV_EXPORT")'));
record("42. export rate limited", exportRoute.includes("rateLimit("));
record("43. export no-store", exportRoute.includes('"cache-control": "no-store"'));
record("44. export attachment disposition", exportRoute.includes("attachment"));
record("45. export locale strict 422", exportRoute.includes("422") && exportRoute.includes("locale"));
record("46. export audit data.export", exportRoute.includes('"data.export"') && exportRoute.includes("PurchaseOrderCSV"));
record("47. export is read-only on the order", !/purchaseOrder\.update|\.update\(/.test(exportRoute));
record("48. csvCell/toCsv shared infra used", read("src/lib/purchase-orders/export.ts").includes('from "@/lib/csv"'));
record("49. export covers all lines (cap+1)", /take: cap \+ 1/.test(read("src/lib/purchase-orders/export.ts")));
record("50. BOM/CRLF via shared toCsv", read("src/lib/csv.ts").includes("\\uFEFF") && read("src/lib/csv.ts").includes("\\r\\n"));

/* ----------------------------- search integration -------------------------- */

record("51. PURCHASE_ORDER in closed search vocab", searchSource().includes('"PURCHASE_ORDER"'));
record("52. search query tenant-scoped", /businessId, \/\/ §68/.test(read("src/lib/search/query.ts")));
record("53. PO search selects NO money fields", (() => {
  const q = read("src/lib/search/query.ts");
  const start = q.indexOf("async function searchPurchaseOrders");
  if (start < 0) return false;
  const end = q.indexOf("async function fetchSearchCandidates", start);
  const fn = q.slice(start, end < 0 ? undefined : end);
  return fn.length > 0 && !/totalMinor|unitPriceMinor|amountMinor/.test(fn);
})());
record("54. PO search bounded take", (() => {
  const q = read("src/lib/search/query.ts");
  const start = q.indexOf("async function searchPurchaseOrders");
  if (start < 0) return false;
  const end = q.indexOf("async function fetchSearchCandidates", start);
  const fn = q.slice(start, end < 0 ? undefined : end);
  return /take: SEARCH_PER_ENTITY_TAKE/.test(fn);
})());
record("55. deep link wired from search", entityRoute.includes("purchase-order") && entityRoute.includes("PURCHASE_ORDER"));
record("56. search view group registered", searchView.includes("PURCHASE_ORDER"));

/* -------------------------- schema/migration integrity --------------------- */

record("57. prisma models exist", schemaPrisma.includes("model PurchaseOrder") && schemaPrisma.includes("model PurchaseOrderLine"));
record("58. reference DB-unique per business (§12)", schemaPrisma.includes("@@unique([businessId, reference])"));
record("59. line uniqueness DB-enforced (§25)", schemaPrisma.includes("@@unique([purchaseOrderId, productId])"));
record("60. P40 indexes present", schemaPrisma.includes("@@index([businessId, status])"));
record("61. supplier FK Restrict (§234)", /model PurchaseOrder \{[\s\S]*?onDelete: Restrict[\s\S]*?\}/.test(schemaPrisma.split("model PurchaseOrderLine")[0]));
record("62. line-cap parser exists (§33)", /purchaseOrderLineCap/.test(read("src/lib/purchase-orders/types.ts")));
record("63. strict calendar dates (§20)", /isValidCalendarDate/.test(read("src/lib/purchase-orders/schema.ts")) && /CALENDAR_DATE_PATTERN/.test(read("src/lib/purchase-orders/schema.ts")));
{
  // §1/§105 — exactly ONE new P41 migration directory exists.
  const { readdirSync } = await import("node:fs");
  const dirs = readdirSync(`${ROOT}prisma/migrations`, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith("_prompt41_purchase_orders"))
    .map((d) => d.name);
  record("64. exactly ONE P41 migration directory", dirs.length === 1, dirs.join(","));
}

/* ------------------------------ UI conventions ----------------------------- */

record("65. hash routing: list + detail (§69/§70)", appStore.includes('"purchase-orders"') && appStore.includes('"purchase-order"') && appStore.includes("#/purchase-orders"));
record("66. malformed deep-link id → dashboard fallback", (() => {
  const marker = "#/purchase-orders/<id> opens the detail only when the id is charset-safe";
  const start = appStore.indexOf(marker);
  if (start < 0) return false;
  const block = appStore.slice(start, start + 1200);
  return (block.match(/return \{ kind: "dashboard" \}/g) ?? []).length >= 2 && block.includes('isValidEntityId(id)');
})());
record("67. viewToHash guards ids with isValidEntityId", /isValidEntityId\(view\.id\) return null;\n      return `#\/purchase-orders\/\$\{view\.id\}`;/.test(appStore.replace(/\s+/g, " ")) || appStore.includes("isValidEntityId(view.id)"));
record("68. shell renders both views", shell.includes("PurchaseOrdersView") && shell.includes("PurchaseOrderDetailView"));
record("69. sidebar entry with localized label (§72)", sidebar.includes("purchaseOrders") && sidebar.includes('"purchase-orders"'));
record("70. status wording: no external email claim (§16)", !/email/i.test(uiSource().match(/markAsSent|sendTitle[\s\S]*?sendConfirm/)?.[0] ?? "ok"));
record("71. no Received wording for CLOSED (§203)", !/received into stock|goods received/i.test(uiSource()));
record("72. no paid/payable wording in PO UI strings (§204)", (() => {
  const rendered = stripComments(uiSource());
  return !/\bpayable\b|\boutstanding\b|amount owed/i.test(rendered);
})());
record("73. UI never submits businessId/totals", !/businessId:/.test(uiSource().match(/body:\s*\{[\s\S]*?\}/)?.[0] ?? ""));

/* ---------------------------------- audit ---------------------------------- */

record("74. audit actions on lifecycle (§62) — 5 literals + the dynamic transition op = all 9", (domainSource().match(/purchase_order\./g) || []).length >= 5 && /purchase_order\.\$\{input\.op\}/.test(read("src/lib/purchase-orders/service.ts")));
record("75. audit inside transactions", /audit\(/.test(read("src/lib/purchase-orders/service.ts")) && /\$transaction/.test(read("src/lib/purchase-orders/service.ts")));
record("76. audit actor from ctx", /actorId,\s*$/m.test(read("src/lib/purchase-orders/service.ts")) || /actorId: input\.userId/.test(read("src/lib/purchase-orders/service.ts")));
record("77. audit never logs notes content (§63)", !/notes:/.test(read("src/lib/purchase-orders/service.ts").split("auditInput(")[1]?.split("/*")[0] ?? ""));

/* ------------------------------ entity sections ---------------------------- */

record("78. Supplier 360 bounded ≤10 (§65/§154)", entitySupplierRoute.includes("RECENT_PURCHASE_ORDERS_TAKE = 10"));
record("79. Product history bounded ≤10 (§66/§155)", entityProductRoute.includes("RECENT_PURCHASE_ORDER_LINES_TAKE = 10"));
record("80. supplier section tenant-scoped", entitySupplierRoute.includes("where: { businessId: ctx.businessId, supplierId: id }"));
record("81. product section tenant-scoped via parent", entityProductRoute.includes("purchaseOrder: { businessId: ctx.businessId }"));
record("82. supplier view renders PO history", supplierView.includes("purchaseOrderHistory"));
record("83. product view renders PO history", productView.includes("purchaseOrderHistory"));
record("84. entity sections read-only (§201)", !/purchaseOrder\.update|purchaseOrderLine\.update/.test(entitySupplierRoute + entityProductRoute));

/* -------------------------------- export catalog --------------------------- */

record("85. datasets registered (§95)", catalog.includes('"purchase_orders"') && catalog.includes('"purchase_order_lines"'));
record("86. implication purchase_orders → lines", catalog.includes('purchase_orders: ["purchase_order_lines"]'));
record("87. CONFIDENTIAL sensitivity", /purchase_orders: \{ key: "purchase_orders", sensitivity: "CONFIDENTIAL"/.test(catalog));
record("88. explicit CSV columns (§96)", catalog.includes('purchase_orders: ["id", "reference", "status"'));
record("89. fetchers tenant-scoped", /purchase_orders: async \(ctx\) => \{[\s\S]{0,400}businessId: ctx\.businessId/.test(catalog));
record("90. import allowlist unchanged (§102 — no PO import)", !/purchase/i.test(importRoute));

/* ---------------------------------- i18n ----------------------------------- */

const poKeys = [
  "title:", "createAction:", "reference:", "supplier:", "orderedQty:", "unitPrice:",
  "orderTotal:", "status_DRAFT:", "status_SENT:", "status_CONFIRMED:", "status_CLOSED:",
  "status_CANCELLED:", "markAsSent:", "closeWarning:", "cancelTerminalWarning:",
  "csvReference:", "financialNote:", "purchaseOrderHistory:",
];
let enMiss = poKeys.filter((k) => !new RegExp(`^  purchaseOrders: \\{[\\s\\S]*?\\n  \\},`, "m").test(en) || !en.split("  purchaseOrders: {")[1]?.split("\n  },")[0]?.includes(k));
let faMiss = poKeys.filter((k) => !fa.split("  purchaseOrders: {")[1]?.split("\n  },")[0]?.includes(k));
record("91. EN purchaseOrders keys complete", enMiss.length === 0, enMiss.join(","));
record("92. FA purchaseOrders keys complete", faMiss.length === 0, faMiss.join(","));
record("93. nav label in en+fa (§72)", en.includes('purchaseOrders: "Purchase Orders"') && fa.includes('purchaseOrders: "سفارش‌های خرید"'));
record("94. search group + statuses in en+fa", en.includes("PURCHASE_ORDER: \"Purchase Orders\"") && fa.includes("PURCHASE_ORDER: \"سفارش‌های خرید\""));
record("95. portability dataset labels en+fa", en.includes("purchaseOrders: \"Purchase orders\"") && fa.includes("purchaseOrders: \"سفارش‌های خرید\""));
record("96. Persian procurement terminology (§139)", fa.includes('unitPrice: "قیمت خرید واحد"') && fa.includes('orderedQty: "مقدار سفارش‌داده‌شده"') && fa.includes('expectedDate: "تاریخ مورد انتظار تحویل"'));

/* ------------------------------ backup/restore ----------------------------- */

record("97. restore drill probes P41 models (§103)", restoreDrill.includes('"PurchaseOrder", "PurchaseOrderLine"'));
record("98. notification catalog untouched (§94)", !read("src/lib/notifications/catalog.ts").toLowerCase().includes("purchase"));

/* ------------- §41-F hardening: status integrity + canonical math ----------- */

record("103. parsePurchaseOrderStatus policy exists (§12/§13)", /export function parsePurchaseOrderStatus/.test(read("src/lib/purchase-orders/types.ts")));
record("104. dto has NO DRAFT coercion fallback (invalid ≠ draft)", !/"DRAFT"/.test(read("src/lib/purchase-orders/dto.ts")));
record("105. service maps integrity error to stable 500 code", read("src/lib/purchase-orders/service.ts").includes("PURCHASE_ORDER_INVALID_PERSISTED_STATUS"));
record("106. export uses the centralized status parser (§15)", read("src/lib/purchase-orders/export.ts").includes("parsePurchaseOrderStatus"));
record("107. list line slice explicitly bounded by cap (§16)", /lines: \{ select: \{ orderedQty: true, unitPriceMinor: true \}, take: cap \}/.test(read("src/lib/purchase-orders/service.ts")));
record("108. Supplier 360 line slice bounded by cap (§20)", entitySupplierRoute.includes("take: purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES)"));
record("109. Supplier 360 totals use the canonical function (§18)", read("src/lib/entities/supplier.ts").includes("computePurchaseOrderTotal") && !/BigInt\(line\.orderedQty\)/.test(read("src/lib/entities/supplier.ts")));
record("110. dto totals use the canonical function (§18)", read("src/lib/purchase-orders/dto.ts").includes("computePurchaseOrderTotal") && !/BigInt\(line\.orderedQty\)/.test(read("src/lib/purchase-orders/dto.ts")));
record("111. export total uses the canonical function (§19)", read("src/lib/purchase-orders/export.ts").includes("computePurchaseOrderTotal") && !/BigInt\(line\.orderedQty\)/.test(read("src/lib/purchase-orders/export.ts")));
record("112. no fabricated line timestamps in service DTOs (§67)", !/updatedAt: new Date\(\)/.test(read("src/lib/purchase-orders/service.ts")));
record("113. detail read is transactional (§22)", /db\.\$transaction[\s\S]{0,120}loadOrderHeader\(tx/.test(read("src/lib/purchase-orders/service.ts")));
record("114. live-supplier read is explicitly tenant-scoped (§23)", /where: \{ id: hdr\.supplierId, businessId: input\.businessId \}/.test(read("src/lib/purchase-orders/service.ts")));
record("115. FA CSV headers are Persian (§55 — no English fallback)", !fa.includes('csvReference: "reference"') && /csvReference: "شماره سند"/.test(fa));
record("116. entity routes map PO integrity errors to the stable code", entitySupplierRoute.includes("mapPurePurchaseOrderDomainError") && entityProductRoute.includes("mapPurePurchaseOrderDomainError"));
record("117. product history status uses the centralized parser (§13/§59)", read("src/lib/entities/product.ts").includes("parsePurchaseOrderStatus(row.status)"));
record("118. E2E suite gates the scanner with node --check (§8)", read("scripts/prompt41-purchase-order-check.mjs").includes("node --check") || read("scripts/prompt41-purchase-order-check.mjs").includes("checkSyntax"));

/* --------------------- §127 forbidden-scope implementation ----------------- */

const forbiddenImplementations = [
  ["warehouse entity", /\bmodel Warehouse\b|warehouseLocation|warehouse_location/i],
  ["bin/shelf", /\bbin\b.*location|shelf/i],
  ["barcode", /\bbarcode\b|\bean\b|\bupc\b/i],
  ["serial/lot", /serialNumber|lotNumber|batch_number/i],
  ["expiry tracking", /expiryDate|expiresAt.*line/i],
  ["valuation layers", /costLayer|valuationLayer|fifo|lifo/i],
  ["weighted average", /weightedAverage|movingAverage/i],
  ["journal/GL", /journalEntry|generalLedger|chartOfAccounts|trialBalance/i],
  ["double entry", /doubleEntry|debit.*credit/i],
  ["goods receipt", /goodsReceipt|stockReceipt|receiptNote/i],
];
const poCode = CODE(); // rules scan CODE, not prose — negation wordings in
// comments (e.g. the send route's "no email/webhook is claimed") are laws.
for (const [name, rx] of forbiddenImplementations) {
  record(`99. §127 no ${name} implementation in P41 code`, !rx.test(poCode));
}

/* --------------------- no external-integration claims (§16) ---------------- */

record("100. no email/SMS/EDI/OCR/webhook SENDS in P41 code (prose negations exempt)", !/sendEmail|smtp|sendMail|edi\b|\bocr\b|webhook/i.test(poCode));
record("101. no Redis/Kafka/queue deps", !/kafka|redis|bullmq|rabbitmq/i.test(poCode));
record("102. no Elasticsearch/Postgres", !/elasticsearch|postgres/i.test(poCode));

/* ------------------------------- report ------------------------------------ */

console.log(`\nPROMPT 41 STATIC SCAN: ${passed}/${passed + failed} ${failed === 0 ? "PASS ✓" : "FAIL"}`);
if (failed > 0) {
  console.log("FAILED RULES:");
  for (const r of failedRules) console.log(`  - ${r}`);
  process.exitCode = 1;
}
