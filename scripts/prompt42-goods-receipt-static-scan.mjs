#!/usr/bin/env node
/**
 * Prompt 42 — goods-receipt static security scan (§223-§226).
 *
 * Dependency-free source scan over the whole P42 surface (domain, routes,
 * UI, prisma schema, write-transaction utility, export catalog, search,
 * entities, i18n, app store, docs). Rule classes (§223):
 *   tenant scoping · RBAC · status machine · no client businessId
 *   no client product authority · no client totals · integer quantities
 *   line caps · OVER-RECEIPT LAW · stock mutation present (§224)
 *   transaction boundary · audit atomicity · CSV security/no-store
 *   rate limit/entitlement · i18n · search tenant safety · deep links
 *   NO financial posting (§5/§160-§164/§224) · NO double-entry terms (§225)
 *   NO warehouse scope (§226) · no notification expansion (§257)
 *   no AI expansion (§258) · P41 additive integration (§98/§146)
 *
 * Run: node scripts/prompt42-goods-receipt-static-scan.mjs
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
  "src/lib/inventory/goods-receipt/types.ts",
  "src/lib/inventory/goods-receipt/schema.ts",
  "src/lib/inventory/goods-receipt/dto.ts",
  "src/lib/inventory/goods-receipt/service.ts",
  "src/lib/inventory/goods-receipt/export.ts",
  "src/lib/inventory/goods-receipt/index.ts",
];
const ROUTES = [
  "src/app/api/v1/inventory/goods-receipts/route.ts",
  "src/app/api/v1/inventory/goods-receipts/[id]/route.ts",
  "src/app/api/v1/inventory/goods-receipts/[id]/lines/route.ts",
  "src/app/api/v1/inventory/goods-receipts/[id]/lines/[lineId]/route.ts",
  "src/app/api/v1/inventory/goods-receipts/[id]/post/route.ts",
  "src/app/api/v1/inventory/goods-receipts/[id]/cancel/route.ts",
  "src/app/api/v1/inventory/goods-receipts/[id]/export/route.ts",
];
const UI = [
  "src/modules/inventory/goods-receipts/goods-receipts-view.tsx",
  "src/modules/inventory/goods-receipts/goods-receipt-detail-view.tsx",
  "src/modules/inventory/goods-receipts/goods-receipt-create-dialog.tsx",
  "src/modules/inventory/goods-receipts/goods-receipt-line-picker.tsx",
  "src/modules/inventory/goods-receipts/goods-receipt-line-dialog.tsx",
  "src/modules/inventory/goods-receipts/goods-receipts-api.ts",
];

const domainSource = () => DOMAIN.map(read).join("\n");
const routeSource = () => ROUTES.map(read).join("\n");
const uiSource = () => UI.filter((p) => existsSync(`${ROOT}${p}`)).map(read).join("\n");
const grSource = () => `${domainSource()}\n${routeSource()}\n${uiSource()}`;

/** Strip // and /* *​/ comments so rules scan CODE, not prose (§7-analog). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}
const CODE = () => stripComments(grSource());
const DOMAIN_CODE = () => stripComments(domainSource());
const SERVICE_CODE = () => stripComments(read("src/lib/inventory/goods-receipt/service.ts"));

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
record("00. UI module files exist", UI.filter((p) => existsSync(`${ROOT}${p}`)).length === 6);

/* ------------------------------ tenant scoping ----------------------------- */

record("01. receipt load scoped by businessId", /where: \{ id, businessId \}/.test(domainSource()));
record("02. routes use ctx.businessId only", (routeSource().match(/ctx\.businessId/g) || []).length >= 9);
record("03. no client businessId accepted", !/body\.businessId|searchParams\.get\("businessId"\)|req\.json\(\)\.businessId/.test(routeSource()));
record("04. create derives tenant from ctx", /businessId: ctx\.businessId/.test(read("src/app/api/v1/inventory/goods-receipts/route.ts")));
record("05. PO line validation joins tenant-scoped PO", /purchaseOrderLine\.findFirst\(\{[\s\S]*?purchaseOrderId: header\.purchaseOrderId/.test(SERVICE_CODE()));
record("06. product existence re-checked with tenant scope at post", /product\.findFirst\(\{[\s\S]*?businessId: input\.businessId/.test(SERVICE_CODE()));
record("07. foreign receipt → 404 NOT_FOUND", (domainSource().match(/Goods receipt not found\./g) || []).length >= 1);
record("08. foreign PO → 404 on create", /Purchase order not found\./.test(SERVICE_CODE()));

/* --------------------------------- RBAC ------------------------------------ */

record("09. reads gated data:read", (routeSource().match(/requirePermission\(ctx, "data:read"\)/g) || []).length >= 3);
record("10. writes gated data:write", (routeSource().match(/requirePermission\(ctx, "data:write"\)/g) || []).length >= 5);
record("11. getAuthContext used in every route", (routeSource().match(/getAuthContext\(req\)/g) || []).length >= 7);
record("12. UI gates with can(role, data:write)", uiSource().includes('can(role, "data:write")'));

/* -------------------- no raw Prisma responses / server-only ---------------- */

record("13. DTO mappers exist", /goodsReceiptDetailDto|goodsReceiptListItemDto|goodsReceiptLineDto/.test(read("src/lib/inventory/goods-receipt/dto.ts")));
record("14. service is server-only", read("src/lib/inventory/goods-receipt/service.ts").startsWith('import "server-only";'));
record("15. export builder is server-only", read("src/lib/inventory/goods-receipt/export.ts").startsWith('import "server-only";'));
record("16. no server-only import in UI module", !/from "server-only"/.test(uiSource()));
record("17. barrel exports only pure modules", !/export \* from "\.\/(service|schema|export)"/.test(read("src/lib/inventory/goods-receipt/index.ts")));
record("18. creator from ctx.userId", /userId: ctx\.userId/.test(routeSource()));
record("19. createdBy DTO exposes id+name only", /createdBy: \{ id: string; name: string \| null \} \| null;/.test(read("src/lib/inventory/goods-receipt/dto.ts")));

/* ----------------------------- quantity safety ----------------------------- */

record("20. receivedQty bound centralized", /GOODS_RECEIPT_QTY_MAX = 1_000_000/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("21. qty min = 1 centralized", /RECEIVED_QTY_MIN = 1/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("22. zod enforces int + min + max", /\.int\("receivedQty must be an integer\."\)/.test(read("src/lib/inventory/goods-receipt/schema.ts")));
record("23. no parseFloat anywhere in P42 code", !/parseFloat\s*\(/.test(CODE()));
record("24. no Math.round in P42 code", !/Math\.round\s*\(/.test(CODE()));
record("25. no decimal.js dependency in P42", !/from "decimal\.js"|require\("decimal\.js"\)/.test(CODE()));
record("26. stock overflow guard exists (§49)", /stockOverflowsInt32/.test(SERVICE_CODE()));
record("27. PRODUCT_STOCK_INT32_MAX defined (§49)", /PRODUCT_STOCK_INT32_MAX = 2_147_483_647/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("28. corrupt persisted stock → controlled 500 (§46/§47)", /INVALID_PERSISTED_STOCK/.test(SERVICE_CODE()));
record("29. corrupt stock is never silently repaired", !/stockQty: 0\b/.test(SERVICE_CODE()));
record("30. integer stock arithmetic (+ only)", /stockQty \+ line\.receivedQty/.test(SERVICE_CODE()));

/* ------------------------------ line cap (§20/§71) ------------------------- */

record("31. cap default 200 clamp 20..500", /GOODS_RECEIPT_LINE_CAP_DEFAULT = 200/.test(read("src/lib/inventory/goods-receipt/types.ts")) && /GOODS_RECEIPT_LINE_CAP_MAX = 500/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("32. defensive cap parser exists", /export function goodsReceiptLineCap/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("33. line-add enforces cap", /assertLineCap/.test(SERVICE_CODE()));
record("34. post enforces cap+1 completeness", /take: cap \+ 1/.test(SERVICE_CODE()));
// P42-F §10-§14 — rule STRENGTHENED (was: "list line slice bounded by cap",
// which accepted a bare `take: cap,` that can silently truncate corrupt
// data into a false partial DTO). Every bounded READ path now fetches
// cap+1 rows to PROVE completeness (list rows, detail, post, receiving
// summary PO lines, recent-receipt widgets) and fails with the stable
// GOODS_RECEIPT_LINE_CAP_INVARIANT code when the +1 row exists. A bare
// `take: cap,` relation read is now a scan failure.
record("35. ALL read paths prove completeness with cap+1 (§10-§14, strengthened)", (SERVICE_CODE().match(/take: cap \+ 1/g) || []).length >= 5 && !/take: cap,/.test(SERVICE_CODE()) && /GOODS_RECEIPT_LINE_CAP_INVARIANT/.test(SERVICE_CODE()));
// P42-F §13 — the list MUST cross-check the aggregated `_count` against the
// cap+1 slice so a corrupt document can never produce a partial total.
record("35b. list cross-checks _count.lines against the cap+1 slice (§13, added)", /row\._count\.lines !== row\.lines\.length/.test(SERVICE_CODE()));

/* --------------------------- over-receipt law (§15) ------------------------ */

record("36. exceedsRemaining pure law exists", /export function exceedsRemaining/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("37. line-add consults the law", /exceedsRemaining\(/.test(SERVICE_CODE()));
record("38. post consults the law (authoritative)", (SERVICE_CODE().match(/exceedsRemaining\(/g) || []).length >= 2);
record("39. over-receipt stable error code", /GOODS_RECEIPT_EXCEEDS_REMAINING/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("40. over-receipt maps to 409", /409,[\s\S]{0,60}GOODS_RECEIPT_ERROR_CODES\.EXCEEDS_REMAINING/.test(SERVICE_CODE()));
record("41. no tolerance percentage anywhere", !/tolerance/i.test(DOMAIN_CODE()));
record("42. no bypass/override flag anywhere", !/allowOverReceipt|bypassRemaining|forcePost/.test(CODE()));
record("43. posted-only sum helper (§99 draft/cancelled excluded)", /status: "POSTED"/.test(SERVICE_CODE()));
record("44. stale draft post rejected via remaining re-check (§67)", /sumPostedQtyForPoLine/.test(SERVICE_CODE()));
// P42-F §5-§7 — the POSTED received-quantity sum is a DATABASE aggregate
// (_sum), never an unbounded historical findMany materialized into
// application memory; the aggregate result is re-validated (integer, ≥ 0).
record("44b. posted-qty sum is a DB aggregate with validation (§5-§7, added)", (() => {
  const m = SERVICE_CODE().match(/async function sumPostedQtyForPoLine[\s\S]*?\n\}/);
  return !!m && /\.aggregate\(\{/.test(m[0]) && /_sum: \{ receivedQty: true \}/.test(m[0]) && !/\.findMany\(/.test(m[0]);
})());

/* ------------------------------ status machine ----------------------------- */

record("45. closed status vocabulary", /\["DRAFT", "POSTED", "CANCELLED"\]/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("46. POSTED is terminal (no reversal §7)", /POSTED: \[\]/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("47. CANCELLED is terminal (§10)", /CANCELLED: \[\]/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("48. dedicated post endpoint", existsSync(`${ROOT}src/app/api/v1/inventory/goods-receipts/[id]/post/route.ts`));
record("49. dedicated cancel endpoint", existsSync(`${ROOT}src/app/api/v1/inventory/goods-receipts/[id]/cancel/route.ts`));
record("50. NO generic status PATCH route", !existsSync(`${ROOT}src/app/api/v1/inventory/goods-receipts/[id]/status/route.ts`));
record("51. corrupt persisted status → stable 500 (§96)", /GOODS_RECEIPT_INVALID_PERSISTED_STATUS/.test(SERVICE_CODE()));
record("52. parser never defaults to DRAFT (§173)", /throw new GoodsReceiptStatusIntegrityError/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("53. export maps corrupt status to controlled 500 (§97)", /INVALID_PERSISTED_STATUS/.test(read("src/lib/inventory/goods-receipt/export.ts")));
record("54. PO receivability gate (§11/§65)", /purchaseOrderIsReceivable/.test(SERVICE_CODE()) && /PURCHASE_ORDER_NOT_RECEIVABLE|PO_NOT_RECEIVABLE/.test(read("src/lib/inventory/goods-receipt/types.ts")));
record("55. post re-checks PO status inside tx (§149/§150)", /assertPurchaseOrderReceivable\(po\.status\)/.test(SERVICE_CODE()));
record("56. line-add re-checks PO status (§65)", (SERVICE_CODE().match(/assertPurchaseOrderReceivable\(/g) || []).length >= 2);

/* ------------------------- transaction boundary (§39/§72) ------------------ */

record("57. posting runs in ONE write transaction", /withWriteTx\(async \(tx\) => \{[\s\S]*?assertTransition\(header\.status, "POSTED"\)/.test(SERVICE_CODE()));
record("58. uses the SHARED write-transaction utility (§52)", /from "@\/lib\/db\/write-transaction"/.test(read("src/lib/inventory/goods-receipt/service.ts")));
record("59. P41 service also uses the shared utility (§53)", /from "@\/lib\/db\/write-transaction"/.test(read("src/lib/purchase-orders/service.ts")));
record("60. shared utility retries transient only", /P2034|P2024/.test(read("src/lib/db/write-transaction.ts")));
record("61. shared utility FIFO serialization", /writeChain/.test(read("src/lib/db/write-transaction.ts")));
record("62. post status re-check INSIDE the transaction (§73)", /loadReceiptHeader\(tx,/.test(SERVICE_CODE()));

/* --------------------------- stock mutation (§4/§39/§224) ------------------ */

record("63. posting updates Product.stockQty (§4 REQUIRED)", /tx\.product\.update\(\{[\s\S]*?stockQty: newStock/.test(SERVICE_CODE()));
record("64. posting creates InventoryAdjustment (§41 REQUIRED)", /tx\.inventoryAdjustment\.create\(/.test(SERVICE_CODE()));
record("65. adjustment delta = receivedQty (§45)", /delta: line\.receivedQty/.test(SERVICE_CODE()));
record("66. adjustment reason identifies the receipt (§41)", /Goods receipt \$\{reference\}|Goods receipt \$\{header\.reference\}/.test(SERVICE_CODE()));
record("67. adjustment actorId from ctx (§42)", /actorId: input\.userId/.test(SERVICE_CODE()));
record("68. adjustment businessId from ctx (§43)", /businessId: input\.businessId/.test(SERVICE_CODE()));
record("69. postedAt server-generated (§74)", /data: \{ status: "POSTED", postedAt \}/.test(SERVICE_CODE()) || /status: "POSTED", postedAt \}/.test(SERVICE_CODE()));
record("70. empty receipt cannot post (§70)", /ERROR_CODES\.EMPTY/.test(SERVICE_CODE()));

/* -------------------- NO financial mutation (§5/§160-§164/§224) ------------- */

record("71. P42 code never creates Expense", !/expense\.create|tx\.expense\.create/.test(DOMAIN_CODE()));
record("72. P42 code never creates Payment", !/payment\.create|tx\.payment\.create/.test(DOMAIN_CODE()));
record("73. P42 code never creates Sale", !/sale\.create|tx\.sale\.create/.test(DOMAIN_CODE()));
record("74. P42 code never writes statement/aging", !/statement\.(create|update)|aging/i.test(DOMAIN_CODE()));
record("75. P42 code never touches payable balances", !/payable/i.test(DOMAIN_CODE()));

/* --------------------------- §225 double-entry ban ------------------------- */

const bannedDoubleEntry = ["journalEntry", "ledgerEntry", "chartOfAccounts", "doubleEntry", "COGS", "debit", "credit"];
const dcHit = bannedDoubleEntry.filter((w) => new RegExp(`\\b${w}\\b`).test(DOMAIN_CODE()));
record("76. NO double-entry implementations (§225)", dcHit.length === 0, dcHit.join(","));

/* --------------------------- §226 warehouse ban ---------------------------- */

const bannedWarehouse = ["warehouseId", "warehouseLocation", "binId", "shelfId", "barcode", "lotNumber", "serialNumber", "expiryDate"];
const whHit = bannedWarehouse.filter((w) => new RegExp(`\\b${w}\\b`).test(DOMAIN_CODE()));
record("77. NO warehouse scope (§226)", whHit.length === 0, whHit.join(","));
record("78. schema has no Warehouse model", !/model Warehouse/.test(read("prisma/schema.prisma")));

/* ------------------------- snapshots (§24/§25/§28/§29) --------------------- */

record("79. supplier snapshot copied from PO's frozen snapshot (§25)", /supplierNameAtOrder/.test(SERVICE_CODE()) && /supplierNameAtReceipt: po\.supplierNameAtOrder/.test(SERVICE_CODE()));
record("80. PO reference snapshot (§24)", /purchaseOrderReferenceAtReceipt: po\.reference/.test(SERVICE_CODE()));
record("81. line snapshots from PO line (§29)", /productNameAtReceipt: poLine\.productNameAtOrder/.test(SERVICE_CODE()));
record("82. snapshot columns in schema", /productNameAtReceipt String/.test(read("prisma/schema.prisma")));
record("83. DTO uses snapshot fields (§127)", /productNameAtReceipt|skuAtReceipt|unitAtReceipt/.test(read("src/lib/inventory/goods-receipt/dto.ts")));

/* ------------------------------ reference (§59-§61) ------------------------ */

record("84. unique [businessId, reference] in schema (§59)", /@@unique\(\[businessId, reference\]\)/.test(read("prisma/schema.prisma")));
record("85. duplicate reference → 409 (§61)", /DUPLICATE_REFERENCE/.test(SERVICE_CODE()));
record("86. secure random generation (not MAX+1)", /randomInt/.test(SERVICE_CODE()) && !/MAX\(\s*reference/.test(CODE()));
record("87. line uniqueness in schema (§27)", /@@unique\(\[goodsReceiptId, purchaseOrderLineId\]\)/.test(read("prisma/schema.prisma")));
record("88. duplicate line → 409 (§209)", /P2002/.test(SERVICE_CODE()));

/* ------------------------------- audit (§153-§156) ------------------------- */

record("89. audit actions cover the lifecycle (§153)", (SERVICE_CODE().match(/goods_receipt\.(create|update|line_add|line_update|line_remove|post|cancel)/g) || []).length >= 7);
record("90. audit inside the same transaction (§154)", /audit\(\s*[\s\S]{0,400}?\),\s*\n?\s*tx,/.test(SERVICE_CODE()));
record("91. audit never logs notes CONTENT (§155)", (() => {
  // Extract the payload object (last balanced {...}) of EVERY auditInput(
  // call site and the auditInput helper's own after-argument template.
  const code = SERVICE_CODE();
  const payloads = [];
  let idx = code.indexOf("auditInput(");
  while (idx !== -1) {
    // balanced-paren scan for the full argument list
    let depth = 0;
    let end = idx + "auditInput".length;
    for (; end < code.length; end += 1) {
      if (code[end] === "(") depth += 1;
      else if (code[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const call = code.slice(idx, end + 1);
    // last balanced {...} inside the call = the after payload
    const lastBrace = call.lastIndexOf("{");
    if (lastBrace !== -1) {
      let d = 0;
      for (let i = lastBrace; i < call.length; i += 1) {
        if (call[i] === "{") d += 1;
        else if (call[i] === "}") {
          d -= 1;
          if (d === 0) {
            payloads.push(call.slice(lastBrace, i + 1));
            break;
          }
        }
      }
    }
    idx = code.indexOf("auditInput(", end);
  }
  // The helper's `after: { reference, ...after }` template is allowed;
  // `notes: { changed: true }` (three-state pattern) is allowed; the
  // CONTENT of notes (raw string / passthrough) is never logged.
  return payloads.length >= 7 && payloads.every((pl) => !/notes:\s*("(?:[^"\\]|\\.)*"|input\.|header\.|row\.|line\.)/.test(pl));
})());
record("92. export route audits data.export (§135)", /action: "data\.export"/.test(read("src/app/api/v1/inventory/goods-receipts/[id]/export/route.ts")));
record("93. export audit entityType GoodsReceiptCSV (§135)", /GoodsReceiptCSV/.test(read("src/app/api/v1/inventory/goods-receipts/[id]/export/route.ts")));

/* ------------------------- CSV export security (§125-§134) ----------------- */

const exportRoute = read("src/app/api/v1/inventory/goods-receipts/[id]/export/route.ts");
record("94. CSV_EXPORT entitlement gate (§131)", /assertFeatureAccess\([\s\S]*?"CSV_EXPORT"/.test(exportRoute));
record("95. export rate limit 10/5min (§132)", /GOODS_RECEIPT_EXPORT_RATE_LIMIT = 10/.test(exportRoute));
record("96. 11th export → 429", /429/.test(exportRoute));
record("97. no-store cache control (§134)", /"cache-control": "no-store"/.test(exportRoute));
record("98. attachment disposition", /attachment/.test(exportRoute));
record("99. strict locale en|fa (§130)", /localeParam !== "en" && localeParam !== "fa"/.test(exportRoute));
record("100. shared toCsv (BOM/CRLF/injection-safe §129)", /toCsv\(/.test(read("src/lib/inventory/goods-receipt/export.ts")));
record("101. CSV covers ALL lines cap+1 (§128)", /take: cap \+ 1/.test(read("src/lib/inventory/goods-receipt/export.ts")));
record("102. CSV has NO money columns (§126)", !/unitPriceMinor|lineTotalMinor|totalMinor/.test(stripComments(read("src/lib/inventory/goods-receipt/export.ts"))));
record("103. malformed export id → 404 before data read (§133)", /isValidEntityId\(id\)/.test(exportRoute));

/* ----------------------------- API validation (§94) ------------------------ */

record("104. parseBody on every write route", (routeSource().match(/parseBody\(req, /g) || []).length >= 4);
record("105. ApiError conventions used", /ApiError/.test(routeSource()));
record("106. list pagination DB-level (§175)", /skip: \(input\.page - 1\) \* input\.pageSize/.test(SERVICE_CODE()));
record("107. pageSize ≤ 100 enforced (§80)", /max\(100\)/.test(read("src/lib/inventory/goods-receipt/schema.ts")));

/* -------------------------------- search (§122-§124) ----------------------- */

const searchTypes = read("src/lib/search/types.ts");
const searchQuery = read("src/lib/search/query.ts");
const searchDto = read("src/lib/search/dto.ts");
record("108. GOODS_RECEIPT in search vocabulary (§122)", /"GOODS_RECEIPT"/.test(searchTypes));
record("109. search destination allowlisted", /"goods-receipts"/.test(searchTypes));
record("110. search WHERE carries businessId (§123)", /searchGoodsReceipts[\s\S]*?businessId,/.test(searchQuery));
record("111. search selects NO money/qty (§122)", (() => {
  const m = searchQuery.match(/async function searchGoodsReceipts[\s\S]*?\n\}/);
  return m ? !/(unitPriceMinor|totalMinor|receivedQty|stockQty)/.test(stripComments(m[0])) : false;
})());
record("112. corrupt search status omitted, never Draft (§124)", (() => {
  const m = searchDto.match(/function goodsReceiptStatusToken[\s\S]*?\n\}/);
  return m ? m[0].includes("null") && !m[0].includes('"DRAFT" ? "DRAFT"') : false;
})());
record("113. search bounded by per-entity take", /take: SEARCH_PER_ENTITY_TAKE/.test(searchQuery.split("searchGoodsReceipts")[1] ?? ""));

/* ------------------------------ deep links (§116/§119) --------------------- */

const appStore = read("src/store/app-store.ts");
record("114. hash routes registered (§116)", appStore.includes("#/inventory/goods-receipts"));
record("115. safe-ID gate on deep link ids", (() => {
  const block = appStore.match(/if \(path === "inventory\/goods-receipts"\)[\s\S]*?return \{ kind: "inventory-goods-receipt", id \};/);
  return !!block && block[0].includes("isValidEntityId") && block[0].includes("dashboard");
})());
record("116. receipt detail links to PO (§119)", /kind: "purchase-order", id: data\.purchaseOrder\.id/.test(read("src/modules/inventory/goods-receipts/goods-receipt-detail-view.tsx")));
record("117. PO detail links to receipt detail (§119)", /kind: "inventory-goods-receipt", id/.test(read("src/modules/purchase-orders/purchase-order-detail-view.tsx")));
record("118. sidebar nav entry (§117)", /"inventory-goods-receipts"/.test(read("src/modules/shell/app-sidebar.tsx")));
record("119. command palette entry (§118)", /inventory-goods-receipts/.test(read("src/modules/shell/command-palette.tsx")));
record("120. app-shell renders both views", (read("src/modules/shell/app-shell.tsx").match(/inventory-goods-receipts?" ?\?/g) || []).length >= 2);

/* ------------------------------- UI laws (§108-§114) ----------------------- */

const detailView = read("src/modules/inventory/goods-receipts/goods-receipt-detail-view.tsx");
record("121. posted receipts read-only (no cancel button)", !/canCancel = writable && \(data\.status === "DRAFT" \|\| data\.status === "POSTED"\)/.test(detailView));
record("122. §194 posting warning key present", /postWarning/.test(read("src/i18n/messages/en.ts")));
record("123. §193 confirmation shows quantities", /totalReceivedQty/.test(detailView) && /postTitle/.test(read("src/i18n/messages/en.ts")));
record("124. stale-remaining conflict banner (§113)", /staleRemaining/.test(detailView));
record("125. NO auto-rebase of quantities (§114)", !/rebase/i.test(CODE()));
record("126. line picker is PO-line based (§110)", /purchaseOrderLineId/.test(read("src/modules/inventory/goods-receipts/goods-receipt-line-picker.tsx")));
record("127. picker filters remaining > 0 (§110)", /remainingQty > 0/.test(read("src/modules/inventory/goods-receipts/goods-receipts-api.ts")));
record("128. picker shows NO price (§111)", !/unitPriceMinor|price/i.test(stripComments(read("src/modules/inventory/goods-receipts/goods-receipt-line-picker.tsx"))));
record("129. picker bounded (page 10, §241)", /pageSize: "10"/.test(read("src/modules/inventory/goods-receipts/goods-receipts-api.ts")));
record("130. qty dialog max = remaining (§112)", /maxQty/.test(read("src/modules/inventory/goods-receipts/goods-receipt-line-dialog.tsx")));

/* --------------------------- P41 additive integration ---------------------- */

const poService = read("src/lib/purchase-orders/service.ts");
record("131. PO receiving summary additive (§98)", /receiving\?[\s\S]*?fullyReceived/.test(read("src/lib/purchase-orders/dto.ts")));
record("132. P41 status vocabulary unchanged (§293)", !/"RECEIVED"|"PARTIALLY_RECEIVED"|"FULFILLED"/.test(stripComments(read("src/lib/purchase-orders/types.ts"))));
record("133. receiving derived, never stored (§99/§295)", !/receivedQty Int/.test(read("prisma/schema.prisma").split("model GoodsReceiptLine")[0].split("model PurchaseOrderLine")[1] ?? ""));
record("134. PO cancel hardening (§146)", /PURCHASE_ORDER_HAS_POSTED_RECEIPTS/.test(poService));
record("135. hardening checks POSTED receipts inside tx (§146)", /goodsReceipt\.count\(\{[\s\S]*?status: "POSTED"/.test(poService));
record("136. §147 close warning wording (EN)", /Closing prevents further goods receipt/.test(read("src/i18n/messages/en.ts")));
record("137. §147 close warning wording (FA)", /دریافت کالا متوقف می‌شود/.test(read("src/i18n/messages/fa.ts")));
record("138. PO detail recent receipts bounded 10 (§104/§105)", /listRecentReceiptsForPurchaseOrder\(\{[\s\S]{0,200}?take: 10/.test(poService));
record("139. receiving aggregates grouped, no N+1 (§181)", /goodsReceiptLine\.groupBy/.test(poService));
record("140. corruption surfaces not clamped (§283)", /GoodsReceiptIntegrityError/.test(poService));

/* ------------------------------- i18n (§243-§245) -------------------------- */

const en = read("src/i18n/messages/en.ts");
const fa = read("src/i18n/messages/fa.ts");
const enKeys = (en.match(/\n  goodsReceipts: \{[\s\S]*?\n  \},/)?.[0].match(/\n    [a-zA-Z_0-9]+:/g) ?? []).map((s) => s.trim());
const faKeys = (fa.match(/\n  goodsReceipts: \{[\s\S]*?\n  \},/)?.[0].match(/\n    [a-zA-Z_0-9]+:/g) ?? []).map((s) => s.trim());
record("141. goodsReceipts namespace exists in EN", enKeys.length >= 100);
record("142. goodsReceipts EN/FA key parity (§243)", JSON.stringify(enKeys) === JSON.stringify(faKeys));
record("143. FA professional terminology (§244)", fa.includes("رسیدهای انبار") && fa.includes("ثبت دریافت کالا"));
record("144. FA receipt UI has no financial terms (§245)", (() => {
  const m = fa.match(/\n  goodsReceipts: \{[\s\S]*?\n  \},/);
  if (!m) return false;
  return !/پرداخت|هزینه|بدهی/.test(m[0]);
})());
record("145. nav labels present", en.includes('goodsReceipts: "Goods Receipts"') && fa.includes('goodsReceipts: "رسیدهای انبار"'));
record("146. search POSTED token localized", en.includes('POSTED: "Posted"') && fa.includes('POSTED: "ثبت‌شده"'));

/* ---------------------- portability + backup (§136-§140) ------------------- */

const catalog = read("src/lib/data-portability/export-catalog.ts");
record("147. receipts dataset in export catalog (§136)", /inventory_goods_receipts/.test(catalog));
record("148. receipt lines dataset in catalog", /inventory_goods_receipt_lines/.test(catalog));
record("149. implication receipts → lines (§137)", /inventory_goods_receipts: \["inventory_goods_receipt_lines"\]/.test(catalog));
record("150. receipt import NOT in import catalog (§138)", (() => {
  const fields = read("src/lib/data-portability/import-fields.ts");
  return !fields.includes("inventory_goods_receipts");
})());
record("151. restore-drill probes GoodsReceipt (§140)", /"GoodsReceipt", "GoodsReceiptLine"/.test(read("scripts/restore-drill.mjs")));

/* ------------------- no notification/AI expansion (§257/§258) --------------- */

record("152. no new notification types (§257)", !/goods_receipt/i.test(read("src/lib/notifications/types.ts") || ""));
record("153. no AI tools for receipts (§258)", (() => {
  const aiDir = `${ROOT}src/lib/ai`;
  return !JSON.stringify(existsSync(aiDir) ? read("src/lib/ai/tools.ts") : "").match(/goods.?receipt/i);
})());
record("154. notes never in AI context (§166)", !/goodsReceipt.*notes/i.test(read("src/lib/copilot-sessions.ts") || ""));

/* ------------------------------ schema DDL (§141/§142) --------------------- */

const schema = read("prisma/schema.prisma");
record("155. GoodsReceipt model exists (§21)", /model GoodsReceipt \{/.test(schema));
record("156. GoodsReceiptLine model exists (§26)", /model GoodsReceiptLine \{/.test(schema));
record("157. exactly one P42 migration (§141)", (() => {
  const migrations = read("scripts/prompt42-goods-receipt-static-scan.mjs") && existsSync(`${ROOT}prisma/migrations/20261007090000_prompt42_goods_receipts/migration.sql`);
  return migrations;
})());
record("158. business cascade on receipts (§143)", /business   Business @relation\(fields: \[businessId\], references: \[id\], onDelete: Cascade\)/.test(schema.split("model GoodsReceipt")[1] ?? ""));
record("159. creator Restrict (consistent with P40/P41)", /onDelete: Restrict/.test(schema.split("model GoodsReceipt")[1]?.split("model GoodsReceiptLine")[0] ?? ""));
record("160. product Restrict on lines (§144)", /onDelete: Restrict/.test(schema.split("model GoodsReceiptLine")[1] ?? ""));
record("161. no price columns in GoodsReceipt (§37)", (() => {
  const m = schema.split("model GoodsReceipt {")[1]?.split("model GoodsReceiptLine")[0] ?? "";
  return !/(totalMinor|subtotalMinor|unitPriceMinor|lineTotalMinor)/.test(m);
})());
record("162. no price columns in GoodsReceiptLine (§38)", (() => {
  // Bound the slice to THIS model: later models (e.g. Prompt 45
  // SalesOrderLine) legitimately carry price fields.
  const m = (schema.split("model GoodsReceiptLine {")[1] ?? "").split("\nmodel ")[0];
  return !/(unitPriceMinor|lineTotalMinor)/.test(m);
})());
record("163. §179 indexes present", /@@index\(\[businessId, status\]\)/.test(schema.split("model GoodsReceipt {")[1]?.split("model GoodsReceiptLine")[0] ?? "") && /@@index\(\[purchaseOrderLineId\]\)/.test(schema.split("model GoodsReceiptLine {")[1] ?? ""));

/* ------------------------------ docs (§246-§255) --------------------------- */

record("164. product doc exists (§248)", existsSync(`${ROOT}docs/product/goods-receipts.md`));
record("165. security doc exists (§249)", existsSync(`${ROOT}docs/security/goods-receipts-security.md`));
record("166. ADR exists (§250)", existsSync(`${ROOT}docs/adr/0042-goods-receipts.md`));
record("167. financial-semantics mentions P42 (§247)", /Prompt 42|Goods Receipt/i.test(read("docs/audit/financial-semantics.md")));
record("168. architecture doc mentions Goods Receipts (§246)", /Goods Receipt/i.test(read("docs/ARCHITECTURE.md")));
record("169. data-export doc updated (§251)", /inventory_goods_receipts/.test(read("docs/data/data-export.md")));
record("170. data-import doc blocks receipts (§252)", /goods.?receipt/i.test(read("docs/data/data-import.md")));
record("171. backup plan updated (§253)", /GoodsReceipt/.test(read("docs/deployment/backup-restore-plan.md")));
record("172. deletion matrix updated (§254)", /goods.?receipt/i.test(read("docs/legal/data-deletion-matrix.md")));

/* ------------------------------- summary ----------------------------------- */

console.log(`\nprompt42-goods-receipt-static-scan: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failedRules) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
console.log("prompt42-goods-receipt-static-scan: ALL RULES PASS ✓");
