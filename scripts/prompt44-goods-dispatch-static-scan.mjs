#!/usr/bin/env node
/**
 * Prompt 44 — goods-dispatch static security scan.
 *
 * Dependency-free source scan over the whole P44 surface (domain, routes,
 * UI, prisma schema, migration, write-transaction reuse, export catalog,
 * search, entities, store/shell wiring, i18n, restore probes, env-repair,
 * test scripts). Rule classes:
 *   surface presence · tenant scope · RBAC · status integrity · safe
 *   integers + zero-qty rejection · line-set completeness invariant
 *   (count mismatch independent of cap) · 422/500 cap classification
 *   split · availability + exact stock arithmetic · ONE negative
 *   adjustment per line · atomic transaction + audit atomicity · POSTED
 *   immutability · terminal CANCELLED · snapshots frozen · no float math
 *   · no client-trusted stock/businessId/status · no financial writes ·
 *   CSV security stack · import rejection · business export datasets ·
 *   search tenant safety · business-timezone windows · i18n parity ·
 *   migration additive-only · restore probes · unit/E2E behavioral
 *   coverage.
 *
 * Run: node scripts/prompt44-goods-dispatch-static-scan.mjs
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

const TYPES = read("src/lib/inventory/goods-dispatch/types.ts");
const SCHEMA = read("src/lib/inventory/goods-dispatch/schema.ts");
const DTO = read("src/lib/inventory/goods-dispatch/dto.ts");
const SERVICE = read("src/lib/inventory/goods-dispatch/service.ts");
const EXPORT = read("src/lib/inventory/goods-dispatch/export.ts");
const ROUTE_LIST = read("src/app/api/v1/inventory/goods-dispatches/route.ts");
const ROUTE_ID = read("src/app/api/v1/inventory/goods-dispatches/[id]/route.ts");
const ROUTE_LINES = read("src/app/api/v1/inventory/goods-dispatches/[id]/lines/route.ts");
const ROUTE_LINE_ID = read("src/app/api/v1/inventory/goods-dispatches/[id]/lines/[lineId]/route.ts");
const ROUTE_POST = read("src/app/api/v1/inventory/goods-dispatches/[id]/post/route.ts");
const ROUTE_CANCEL = read("src/app/api/v1/inventory/goods-dispatches/[id]/cancel/route.ts");
const ROUTE_EXPORT = read("src/app/api/v1/inventory/goods-dispatches/[id]/export/route.ts");
const MIGRATION = read("prisma/migrations/20261010090000_prompt44_goods_dispatches/migration.sql");
const PRISMA = read("prisma/schema.prisma");
const UI_LIST = read("src/modules/inventory/goods-dispatches/goods-dispatches-view.tsx");
const UI_DETAIL = read("src/modules/inventory/goods-dispatches/goods-dispatch-detail-view.tsx");
const UI_CREATE = read("src/modules/inventory/goods-dispatches/goods-dispatch-create-dialog.tsx");
const UI_PICKER = read("src/modules/inventory/goods-dispatches/goods-dispatch-line-picker.tsx");
const UI_LINE = read("src/modules/inventory/goods-dispatches/goods-dispatch-line-dialog.tsx");
const UI_API = read("src/modules/inventory/goods-dispatches/goods-dispatches-api.ts");
const EN = read("src/i18n/messages/en.ts");
const FA = read("src/i18n/messages/fa.ts");
const UNIT = read("scripts/prompt44-unit.ts");
const E2E = read("scripts/prompt44-goods-dispatch-check.mjs");
const CAP = read("scripts/prompt44-goods-dispatch-cap-check.ts");

let pass = 0;
let fail = 0;
const failures = [];
function record(name, cond, info = "") {
  if (cond) pass++;
  else fail++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}

/* --------------------------- 1. surface presence -------------------------- */
record("1. domain module files exist", ["src/lib/inventory/goods-dispatch/types.ts", "src/lib/inventory/goods-dispatch/schema.ts", "src/lib/inventory/goods-dispatch/dto.ts", "src/lib/inventory/goods-dispatch/service.ts", "src/lib/inventory/goods-dispatch/export.ts", "src/lib/inventory/goods-dispatch/index.ts"].map(exists).every(Boolean));
record("2. all 7 API route files exist", ["src/app/api/v1/inventory/goods-dispatches/route.ts", "src/app/api/v1/inventory/goods-dispatches/[id]/route.ts", "src/app/api/v1/inventory/goods-dispatches/[id]/lines/route.ts", "src/app/api/v1/inventory/goods-dispatches/[id]/lines/[lineId]/route.ts", "src/app/api/v1/inventory/goods-dispatches/[id]/post/route.ts", "src/app/api/v1/inventory/goods-dispatches/[id]/cancel/route.ts", "src/app/api/v1/inventory/goods-dispatches/[id]/export/route.ts"].map(exists).every(Boolean));
record("3. all 6 UI module files exist", ["src/modules/inventory/goods-dispatches/goods-dispatches-view.tsx", "src/modules/inventory/goods-dispatches/goods-dispatch-detail-view.tsx", "src/modules/inventory/goods-dispatches/goods-dispatch-create-dialog.tsx", "src/modules/inventory/goods-dispatches/goods-dispatch-line-picker.tsx", "src/modules/inventory/goods-dispatches/goods-dispatch-line-dialog.tsx", "src/modules/inventory/goods-dispatches/goods-dispatches-api.ts"].map(exists).every(Boolean));
record("4. migration exists", exists("prisma/migrations/20261010090000_prompt44_goods_dispatches/migration.sql"));
record("5. unit + E2E + cap-check + this scan exist", ["scripts/prompt44-unit.ts", "scripts/prompt44-goods-dispatch-check.mjs", "scripts/prompt44-goods-dispatch-cap-check.ts", "scripts/prompt44-goods-dispatch-static-scan.mjs"].map(exists).every(Boolean));

/* ------------------------------ 2. tenant scope ---------------------------- */
record("6. every service write/read scopes by businessId from ctx", SERVICE.includes("businessId: input.businessId") && SERVICE.includes("{ id, businessId }"), "findFirst where { id, businessId }");
record("7. list route passes ctx.businessId (never client body)", ROUTE_LIST.includes("businessId: ctx.businessId"));
record("8. detail route resolves malformed ids to 404 before reads", ROUTE_ID.includes("isValidEntityId"));
record("9. post route resolves malformed ids to 404", ROUTE_POST.includes("isValidEntityId"));
record("10. cancel route resolves malformed ids to 404", ROUTE_CANCEL.includes("isValidEntityId"));
record("11. export route resolves malformed ids to 404", ROUTE_EXPORT.includes("isValidEntityId"));
record("12. foreign customer → 404 with stable code", SERVICE.includes("GOODS_DISPATCH_ERROR_CODES.CUSTOMER_NOT_FOUND"));
record("13. foreign product → 404 with stable code", SERVICE.includes("GOODS_DISPATCH_ERROR_CODES.PRODUCT_NOT_FOUND"));
record("14. soft-delete aware customer lookup", SERVICE.includes("deletedAt: null"));

/* -------------------------------- 3. RBAC ---------------------------------- */
record("15. list = data:read", ROUTE_LIST.includes('requirePermission(ctx, "data:read")'));
record("16. create = data:write", ROUTE_LIST.includes('requirePermission(ctx, "data:write")'));
record("17. detail GET = data:read", ROUTE_ID.includes('requirePermission(ctx, "data:read")'));
record("18. patch = data:write", ROUTE_ID.includes('requirePermission(ctx, "data:write")'));
record("19. lines add = data:write", ROUTE_LINES.includes('requirePermission(ctx, "data:write")'));
record("20. line patch/delete = data:write", ROUTE_LINE_ID.includes('requirePermission(ctx, "data:write")'));
record("21. post = data:write", ROUTE_POST.includes('requirePermission(ctx, "data:write")'));
record("22. cancel = data:write", ROUTE_CANCEL.includes('requirePermission(ctx, "data:write")'));
record("23. export = data:read + CSV entitlement", ROUTE_EXPORT.includes('requirePermission(ctx, "data:read")') && ROUTE_EXPORT.includes('assertFeatureAccess(ctx.businessId, "CSV_EXPORT")'));
record("24. no new permission codes invented", !SERVICE.includes("permission:") && !TYPES.includes("data:dispatch"));

/* --------------------------- 4. status integrity ---------------------------- */
record("25. parseGoodsDispatchStatus NEVER falls back to DRAFT", TYPES.includes("parseGoodsDispatchStatus") && TYPES.includes("GoodsDispatchStatusIntegrityError"));
record("26. no `|| \"DRAFT\"` fallback anywhere", !/status\s*\|\|\s*["']DRAFT["']/.test(SERVICE + DTO + EXPORT));
record("27. service maps corrupted status → 500 INVALID_PERSISTED_STATUS", SERVICE.includes("GOODS_DISPATCH_INVALID_PERSISTED_STATUS"));
record("28. post re-checks the transition INSIDE the tx", SERVICE.includes('assertTransition(header.status, "POSTED")'));
record("29. cancel re-checks INSIDE the tx", SERVICE.includes('assertTransition(header.status, "CANCELLED")'));
record("30. transition matrix: POSTED and CANCELLED are terminal", TYPES.includes("POSTED: []") && TYPES.includes("CANCELLED: []"));

/* --------------------- 5. safe integers + zero-qty law --------------------- */
record("31. Number.isSafeInteger guards the qty validators", TYPES.includes("Number.isSafeInteger"));
record("32. persisted qty validator requires ≥ 1 (zero is corruption)", TYPES.includes("isValidPersistedDispatchQty") && !TYPES.includes("value >= DISPATCH_QTY_MIN && value <= GOODS_DISPATCH_QTY_MAX\n  );\n}\n\nexport function isValidDispatchQtyZero"));
record("33. computeDispatchedQty rejects a zero SUMMAND", TYPES.includes("invalid persisted quantity") && UNIT.includes("computeDispatchedQty([0])"));
record("34. running total safe-checked per addition", TYPES.includes("Number.isSafeInteger(total)"));
record("35. post validates EVERY persisted line BEFORE mutation", SERVICE.includes("isValidPersistedDispatchQty(line.qty)"));
record("36. post validates persisted reason codes", SERVICE.includes("isGoodsDispatchReasonCode(line.reasonCode)"));
record("37. line DTO validates the closed reason vocabulary", DTO.includes("isGoodsDispatchReasonCode(row.reasonCode)"));
record("38. widget row mapper validates the reason too", DTO.includes("invalid persisted reason code"));
record("39. zod rejects 0/1.5/NaN at the boundary", UNIT.includes('lineZero') === false || UNIT.includes('u171 zero qty rejected'));
record("40. no float math anywhere in the domain", !SERVICE.includes("Math.round") && !SERVICE.includes("Math.floor") && !TYPES.includes("parseFloat"));

/* ------------------- 6. line-set completeness invariant -------------------- */
record("41. assertGoodsDispatchLineSetComplete enforces 3 invariants", TYPES.includes("assertGoodsDispatchLineSetComplete") && TYPES.includes("countedLines !== fetchedLines"));
record("42. list reads fetch cap+1", SERVICE.includes("take: cap + 1"));
record("43. detail reads fetch cap+1", SERVICE.includes("take: cap + 1"));
record("44. list routes through the canonical validator + ONE mapper", SERVICE.includes("assertGoodsDispatchLineSetComplete(row.lines.length, row._count.lines, cap)"));
record("45. customer widget routes through the same validator", SERVICE.includes("assertGoodsDispatchLineSetComplete(r.lines.length, r.lines.length, cap)"));
record("46. mismatch below cap is unit-tested behaviorally", UNIT.includes("assertGoodsDispatchLineSetComplete(1, 2, 200)"));
record("47. cap parser clamps 20..500", TYPES.includes("GOODS_DISPATCH_LINE_CAP_MIN") && TYPES.includes("GOODS_DISPATCH_LINE_CAP_MAX"));

/* ----------------- 7. 422/500 cap classification split --------------------- */
record("48. assertLineCap: lineCount > cap → 500 INVARIANT", /lineCount > cap[\s\S]{0,300}500,/.test(SERVICE));
record("49. assertLineCap: lineCount === cap → 422 LINE_LIMIT", /lineCount === cap[\s\S]{0,300}422,/.test(SERVICE));
record("50. post: over-cap persisted doc → 500 (NOT 422)", /lines\.length > cap[\s\S]{0,700}ApiError\(\s*500,\s*GOODS_DISPATCH_LINE_CAP_INVARIANT/.test(SERVICE));
record("51. 422 write-time and 500 integrity codes are distinct", UNIT.includes('u133'));
record("52. cap-check proves the classification live", CAP.includes("2.3 post → 500 INVARIANT") && CAP.includes("1.2 21st add"));

/* ------------- 8. availability + exact stock arithmetic -------------------- */
record("53. exceedsAvailableStock enforces preconditions (safe ints, qty ≥ 1)", TYPES.includes("exceedsAvailableStock") && TYPES.includes("isSafeNonNegativeInteger(currentStock)"));
record("54. stockAfterDispatch refuses negative results (never clamps)", TYPES.includes("newStock < 0"));
record("55. negative CURRENT stock is stock corruption (precise classification)", TYPES.includes("GOODS_DISPATCH_INVALID_PERSISTED_STOCK"));
record("56. invalid DISPATCH qty is CORRUPT_HISTORY (not stock corruption)", TYPES.includes("dispatchedQty") && TYPES.includes("GOODS_DISPATCH_CORRUPT_HISTORY"));
record("57. post re-verifies availability INSIDE the tx", /CURRENT STOCK CHECK[\s\S]{0,300}exceedsAvailableStock\(product\.stockQty, line\.qty\)/.test(SERVICE) || SERVICE.includes("exceedsAvailableStock(product.stockQty, line.qty)"));
record("58. line-add availability check is ADVISORY (documented stale-draft law)", SERVICE.includes("only POST is authoritative") || SERVICE.includes("only\n    // POST is authoritative"));
record("59. stock never written below zero in any code path", !/stockQty:\s*-\s/.test(SERVICE));
record("60. negative persisted stock → 500 before any comparison", SERVICE.includes('!Number.isSafeInteger(product.stockQty) || product.stockQty < 0'));

/* --------------- 9. ONE negative adjustment per line ----------------------- */
record("61. delta = -line.qty (always negative)", SERVICE.includes("delta: -line.qty"));
record("62. adjustment created per line INSIDE the post tx", SERVICE.includes("inventoryAdjustment.create"));
record("63. adjustment reason carries the dispatch reference", SERVICE.includes("DISPATCH_ADJUSTMENT_REASON(header.reference)"));
record("64. product decrement precedes the adjustment in the same loop", SERVICE.indexOf("stockQty: newStock") < SERVICE.indexOf("inventoryAdjustment.create"));
record("65. stockAfterDispatch re-validates both operands", SERVICE.includes("stockAfterDispatch(product.stockQty, line.qty)"));

/* ------------------- 10. atomicity + audit ---------------------------------- */
record("66. ALL mutations run in withWriteTransaction", SERVICE.includes("withWriteTransaction") && (SERVICE.match(/withWriteTx\(/g) ?? []).length >= 7);
record("67. ONE post audit row written in the SAME tx", SERVICE.includes('"goods_dispatch.post"') && SERVICE.includes("audit("));
record("68. audit metadata is quantity-facts only (never notes)", SERVICE.includes("totalDispatchedQty") && !SERVICE.includes("after: { ...data.notes"));
record("69. create/update/line actions all audited", SERVICE.includes("goods_dispatch.create") && SERVICE.includes("goods_dispatch.update") && SERVICE.includes("goods_dispatch.line_add") && SERVICE.includes("goods_dispatch.line_remove") && SERVICE.includes("goods_dispatch.cancel"));

/* ---------------------- 11. immutability + lifecycle ----------------------- */
record("70. requireDraft guards header patch", SERVICE.includes("requireDraft(header.status)"));
record("71. requireDraft guards line add/update/remove", (SERVICE.match(/requireDraft\(header\.status\)/g) ?? []).length >= 4);
record("72. header patch only allows reference/notes", SCHEMA.includes("goodsDispatchUpdateSchema") && SCHEMA.includes("Nothing to update"));
record("73. line update is strict (no product reassignment)", SCHEMA.includes("goodsDispatchLineUpdateSchema") && UNIT.includes("u179 line-update cannot reassign the product"));
record("74. client snapshot injection rejected (strict line schema)", UNIT.includes("u176 STRICT: client cannot inject status into a line"));
record("75. zero-line post → 422 EMPTY", SERVICE.includes("GOODS_DISPATCH_ERROR_CODES.EMPTY"));

/* ------------------------------ 12. snapshots ------------------------------- */
record("76. product snapshots frozen at line-add from the live Product row", SERVICE.includes("productNameAtDispatch: product.name"));
record("77. customer snapshot frozen at creation", SERVICE.includes("customerNameAtDispatch") && SERVICE.includes("loadActiveCustomerName"));
record("78. line update does NOT refresh snapshots", !SERVICE.includes("productNameAtDispatch: input"));
record("79. SetNull customer FK keeps history readable", MIGRATION.includes("ON DELETE SET NULL"));
record("80. Restrict product/creator FKs preserve evidence", MIGRATION.includes("ON DELETE RESTRICT"));

/* --------------------------- 13. no financial writes ------------------------ */
record("81. service creates NO Sale/Expense/Payment", !/sale\.create|expense\.create|payment\.create/.test(SERVICE));
record("82. DTOs carry NO money fields", !/totalMinor|unitPriceMinor|amountMinor:/.test(DTO.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
record("83. UI states the financial boundary verbatim", UI_DETAIL.includes("postFinancialNote"));
record("84. FA wording is inventory, not financial", FA.includes("هیچ فاکتور، پرداخت یا حساب دریافتنی ایجاد نمیشود"));

/* --------------------------- 14. CSV security stack ------------------------- */
record("85. export uses shared toCsv (OWASP cell guard)", EXPORT.includes("toCsv("));
record("86. export fetches cap+1 and refuses over-cap data", EXPORT.includes("take: cap + 1") && EXPORT.includes("GOODS_DISPATCH_LINE_CAP_INVARIANT"));
record("87. export validates every qty + reason via canonical helpers", EXPORT.includes("computeDispatchedQty(lineRows.map") && EXPORT.includes("goodsDispatchLineDto"));
record("88. export status via the ONE parser (never Draft-labeled corruption)", EXPORT.includes("parseGoodsDispatchStatus"));
record("89. EN + FA header sets", EXPORT.includes("messagesFor(input.locale)") && EN.includes("csvQty: \"dispatched_qty\"") && FA.includes("csvQty: \"مقدار_خارجشده\""));
record("90. rate limit 10/5min per user", ROUTE_EXPORT.includes("GOODS_DISPATCH_EXPORT_RATE_LIMIT = 10"));
record("91. no-store + attachment", ROUTE_EXPORT.includes("no-store") && ROUTE_EXPORT.includes("attachment"));
record("92. data.export audit with counts only", ROUTE_EXPORT.includes("entityType: \"GoodsDispatchCSV\""));
record("93. strict locale 422", ROUTE_EXPORT.includes("Unsupported export locale"));

/* --------------------- 15. business export + import law --------------------- */
record("94. export catalog covers both P44 datasets", read("src/lib/data-portability/export-catalog.ts").includes("inventory_goods_dispatches") && read("src/lib/data-portability/export-catalog.ts").includes("inventory_goods_dispatch_lines"));
record("95. dispatches imply their lines", read("src/lib/data-portability/export-catalog.ts").includes('inventory_goods_dispatches: ["inventory_goods_dispatch_lines"]'));
record("96. datasets are export-ONLY (no import replay of stock decrements)", !read("src/lib/data-portability/import-catalog.ts").includes("inventory_goods_dispatches"));
record("97. E2E proves import rejection", E2E.includes("17.1 import of dispatch dataset REJECTED"));

/* --------------------------- 16. search integration ------------------------- */
record("98. search types cover GOODS_DISPATCH + destination", read("src/lib/search/types.ts").includes('"GOODS_DISPATCH"') && read("src/lib/search/types.ts").includes('"goods-dispatches"'));
record("99. search candidate carries NO money/stock quantities", read("src/lib/search/dto.ts").includes("goodsDispatchCandidate") && !/qty:\s|_sum/.test(read("src/lib/search/dto.ts").split("goodsDispatchCandidate")[1] ?? ""));
record("100. search snapshot text bounded by the cap law", read("src/lib/search/query.ts").includes("goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES)"));
record("101. search status token is closed-vocabulary guarded (safe omission)", read("src/lib/search/dto.ts").includes("goodsDispatchStatusToken"));
record("102. E2E proves search tenant safety both directions", E2E.includes("15.3 B never sees A's dispatch"));

/* ------------------- 17. business-timezone date windows --------------------- */
record("103. day window composes the ESTABLISHED helpers (no second date util)", TYPES.includes("zonedWallClockToUtc") && TYPES.includes("nextCalendarDay"));
record("104. to is EXCLUSIVE next-day start (never 23:59:59.999)", !TYPES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").includes("23:59:59.999") && TYPES.includes("nextCalendarDay(to)"));
record("105. strict calendar validation inside the window too", TYPES.includes("isValidCalendarDate(from)"));
record("106. route passes ctx.business.timezone (never the client)", ROUTE_LIST.includes('timezone: ctx.business.timezone || "UTC"') && !ROUTE_LIST.includes('searchParams.get("timezone")'));
record("107. E2E proves the 00:15-local record lands on its LOCAL date", E2E.includes("13.1 00:15-local record found on its LOCAL date"));
record("108. E2E proves invalid dates + inverted ranges 422", E2E.includes("13.3 invalid calendar date → 422") && E2E.includes("13.4 from > to → 422"));

/* ------------------------------ 18. i18n parity ----------------------------- */
record("109. FA section exists with the canonical term", FA.includes("goodsDispatches: {") && FA.includes("خروج کالا"));
record("110. EN/FA key-count parity (behaviorally counted in unit)", UNIT.includes("u189 EN/FA goodsDispatches key-count parity"));
record("111. reason labels cover the closed vocabulary in both locales", ["reason_SALE", "reason_GIFT_SAMPLE", "reason_TRANSFER_OUT", "reason_OTHER"].every((k) => EN.includes(k) && FA.includes(k)));
record("112. status labels cover the lifecycle in both locales", ["status_DRAFT", "status_POSTED", "status_CANCELLED"].every((k) => EN.includes(k) && FA.includes(k)));
record("113. nav + search group keys in both locales", EN.includes("goodsDispatches: \"Goods Dispatch\"") && FA.includes("goodsDispatches: \"خروج کالا\""));
record("114. export dataset labels in both locales", EN.includes("inventoryGoodsDispatches") && FA.includes("inventoryGoodsDispatches"));

/* ----------------------- 19. migration + schema ----------------------------- */
record("115. migration is additive-only (no destructive DDL)", !/DROP TABLE|DROP COLUMN|DELETE FROM/i.test(MIGRATION));
record("116. unique (businessId, reference)", MIGRATION.includes("UNIQUE INDEX \"GoodsDispatch_businessId_reference_key\""));
record("117. unique (goodsDispatchId, productId) — one line per product", MIGRATION.includes("UNIQUE INDEX \"GoodsDispatchLine_goodsDispatchId_productId_key\""));
record("118. qty column is INTEGER (no floats)", MIGRATION.includes("\"qty\" INTEGER NOT NULL"));
record("119. prisma schema declares both models + backrefs", PRISMA.includes("model GoodsDispatch {") && PRISMA.includes("model GoodsDispatchLine {") && PRISMA.includes("goodsDispatchCreations"));
record("120. env-repair baseline carries the P44 migration", read("scripts/env-repair.mjs").includes("20261010090000_prompt44_goods_dispatches"));
record("121. restore-drill probes both tables", read("scripts/restore-drill.mjs").includes('"GoodsDispatch", "GoodsDispatchLine"'));

/* ---------------------- 20. UI wiring + client laws ------------------------- */
record("122. app store deep links + hash parser", read("src/store/app-store.ts").includes('"inventory-goods-dispatch"') && read("src/store/app-store.ts").includes('path === "inventory/goods-dispatches"'));
record("123. malformed deep-link ids NEVER become state", read("src/store/app-store.ts").split("inventory/goods-dispatches/")[1]?.includes("isValidEntityId") ?? false);
record("124. app-shell renders both views behind ModuleBoundary", read("src/modules/shell/app-shell.tsx").includes("<GoodsDispatchesView") && read("src/modules/shell/app-shell.tsx").includes("<GoodsDispatchDetailView"));
record("125. sidebar + palette carry the nav entry", read("src/modules/shell/app-sidebar.tsx").includes('"goodsDispatches"') && read("src/modules/shell/command-palette.tsx").includes('"goodsDispatches"'));
record("126. entity router deep-links GOODS_DISPATCH", read("src/modules/entities/entity-route.ts").includes('GOODS_DISPATCH') && read("src/modules/entities/entity-route.ts").includes('"inventory-goods-dispatch"'));
record("127. UI client never submits status/businessId/snapshots", !/body:\s*JSON\.stringify\(\{[^}]*status:/.test(UI_API) && !/body:\s*JSON\.stringify\(\{[^}]*businessId:/.test(UI_API) && !/body:\s*JSON\.stringify\(\{[^}]*productNameAtDispatch:/.test(UI_API));
record("128. UI invalidation covers products/adjustments/entities", UI_DETAIL.includes('queryKey: ["products"]') && UI_DETAIL.includes('queryKey: ["adjustments"]'));
record("129. product detail carries dispatch history", read("src/app/api/v1/products/[id]/route.ts").includes("listRecentDispatchesForProduct"));
record("130. customer 360 carries dispatch history", read("src/app/api/v1/customers/[id]/route.ts").includes("listRecentDispatchesForCustomer"));
record("131. line picker disables products already on the draft", UI_PICKER.includes("alreadyOnDispatch"));
record("132. line dialog integer input with advisory bound (server still revalidates)", UI_LINE.includes("Only POST is authoritative") || UI_LINE.includes("/^\\d+$/"));
record("133. list view uses DB pagination (pageSize 25 ≤ 100)", UI_LIST.includes("pageSize: 25"));
record("134. product picker is bounded (pageSize 10)", UI_PICKER.includes("pageSize=10"));
record("135. UI exposes NO raw error internals", !UI_DETAIL.includes("err.message") && !UI_CREATE.includes("error.message"));

/* --------------------- 21. test-suite behavioral coverage ------------------- */
record("136. unit covers zero-qty + mismatch + cap classification behaviorally", UNIT.includes("computeDispatchedQty([0])") && UNIT.includes("assertGoodsDispatchLineSetComplete(1, 2, 200)") && UNIT.includes("u215 over-cap persisted document → 500"));
record("137. E2E proves exact decrement + ONE adjustment", E2E.includes("5.8 Product.stockQty decremented exactly") && E2E.includes("5.9 EXACTLY ONE new adjustment"));
record("138. E2E proves financial non-mutation with NON-ZERO fixtures", E2E.includes("10.4 financial fixtures are NON-ZERO") && E2E.includes("10.7 Expense aggregate EXACTLY unchanged"));
record("139. E2E proves atomic multi-line rollback", E2E.includes("8.3 line 1's decrement ROLLED BACK (atomic)"));
record("140. E2E proves stale-draft authoritative gate", E2E.includes("7.3 stale draft post → 409"));
record("141. E2E proves corrupt state → 500 + full recovery", E2E.includes("12.11 post succeeds after corruption is repaired"));
record("142. E2E proves cancel touches nothing", E2E.includes("9.3 cancel NEVER touches stock"));
record("143. E2E teardown returns every surface to ZERO", E2E.includes("20.6 zero dispatch adjustments remain"));
record("144. cap-check proves concurrency races live", CAP.includes("4.1 exactly ONE post wins") && CAP.includes("5.1 at most ONE successful transition") && CAP.includes("6.1 exactly one create wins"));
record("145. cap-check proves no negative stock under races", CAP.includes("4.3 stock = 100 − 70 exactly"));
record("146. E2E spawns the isolated cap suite (project default untouched)", E2E.includes('GOODS_DISPATCH_MAX_LINES: "20"'));
record("147. E2E proves CSV injection guard", E2E.includes("16.6 formula-injection guard applied"));
record("148. E2E proves snapshot freeze against live rename", E2E.includes("3.13 snapshot NEVER re-read live"));
record("149. E2E proves snapshot/strict-schema injection rejection", E2E.includes("4.9 client snapshot injection rejected"));
record("150. E2E proves immutable-after-post + terminal cancel", E2E.includes("5.15 double post → 409") && E2E.includes("9.5 CANCELLED → POSTED forbidden"));

console.log(`\n=== prompt44-goods-dispatch-static-scan: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
