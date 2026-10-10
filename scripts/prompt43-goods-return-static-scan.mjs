#!/usr/bin/env node
/**
 * Prompt 43 — goods-return static security scan (§150).
 *
 * Dependency-free source scan over the whole P43 surface (domain, routes,
 * UI, prisma schema, migration, write-transaction reuse, export catalog,
 * search, entities, i18n, app store, docs). Rule classes (§150):
 *   tenant scope · RBAC · source receipt validation · POSTED-only returns
 *   cumulative return cap · current stock check · negative adjustment
 *   atomic transaction · audit atomicity · return immutability
 *   invalid status handling · cap+1 read completeness · DB aggregation
 *   no float math · no client-trusted stock · no client businessId
 *   no financial writes · CSV security · import rejection · search tenant
 *   safety · i18n parity · NO prohibited scope (credit notes / payments /
 *   warehouse / lots / valuation / AI / notifications)
 *
 * Run: node scripts/prompt43-goods-return-static-scan.mjs
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

const DOMAIN = [
  "src/lib/inventory/goods-return/types.ts",
  "src/lib/inventory/goods-return/schema.ts",
  "src/lib/inventory/goods-return/dto.ts",
  "src/lib/inventory/goods-return/service.ts",
  "src/lib/inventory/goods-return/export.ts",
  "src/lib/inventory/goods-return/index.ts",
];
const ROUTES = [
  "src/app/api/v1/inventory/goods-returns/route.ts",
  "src/app/api/v1/inventory/goods-returns/[id]/route.ts",
  "src/app/api/v1/inventory/goods-returns/[id]/lines/route.ts",
  "src/app/api/v1/inventory/goods-returns/[id]/lines/[lineId]/route.ts",
  "src/app/api/v1/inventory/goods-returns/[id]/post/route.ts",
  "src/app/api/v1/inventory/goods-returns/[id]/cancel/route.ts",
  "src/app/api/v1/inventory/goods-returns/[id]/export/route.ts",
];
const UI = [
  "src/modules/inventory/goods-returns/goods-returns-view.tsx",
  "src/modules/inventory/goods-returns/goods-return-detail-view.tsx",
  "src/modules/inventory/goods-returns/goods-return-create-dialog.tsx",
  "src/modules/inventory/goods-returns/goods-return-line-picker.tsx",
  "src/modules/inventory/goods-returns/goods-return-line-dialog.tsx",
  "src/modules/inventory/goods-returns/goods-returns-api.ts",
];
const EN = "src/i18n/messages/en.ts";
const FA = "src/i18n/messages/fa.ts";

const TYPES_CODE = stripComments(read(DOMAIN[0]));
const SCHEMA_CODE = stripComments(read(DOMAIN[1]));
const DTO_CODE = stripComments(read(DOMAIN[2]));
const SERVICE_CODE = stripComments(read(DOMAIN[3]));
const EXPORT_CODE = stripComments(read(DOMAIN[4]));
const SCHEMA_PRISMA = read("prisma/schema.prisma");
const API_CODE = ROUTES.map(read).join("\n");
const UI_CODE = UI.map(read).join("\n");
const WRITE_TX = read("src/lib/db/write-transaction.ts");
const EN_SRC = read(EN);
const FA_SRC = read(FA);

/** Section extraction by a top-level declaration name (robust vs dashes). */
function section(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return "";
  // Return until the next top-level export/section comment after this one.
  const rest = src.slice(idx);
  const next = rest.slice(10).search(/\n\*\/|\nexport |\n\/\* -+ /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

let pass = 0;
let fail = 0;
const failures = [];

/** Strip JS/TS comments so prose mentions never fire code rules. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Line comments: strip only when `//` appears BEFORE any quote char on
    // that single line (never crosses newlines — safe for strings/URLs).
    .split("\n")
    .map((line) => {
      const commentIdx = line.indexOf("//");
      if (commentIdx === -1) return line;
      const quoteIdx = Math.min(
        ...["\"", "'", "`"].map((q) => {
          const i = line.indexOf(q);
          return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        }),
      );
      return commentIdx < quoteIdx ? line.slice(0, commentIdx) : line;
    })
    .join("\n");
}

function record(name, cond, info = "") {
  if (cond) pass++;
  else fail++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}
const exists = (p) => existsSync(`${ROOT}${p}`);

/* --------------------------- 1. surface presence -------------------------- */
record("1. domain module files exist", DOMAIN.every(exists));
record("2. all 7 API route files exist", ROUTES.every(exists));
record("3. all 6 UI module files exist", UI.every(exists));
record("4. docs exist (product/security/ADR)", ["docs/product/goods-returns.md", "docs/security/goods-returns-security.md", "docs/adr/0043-goods-returns.md"].map(exists).every(Boolean));
record("5. unit + E2E + fixture + this scan exist", ["scripts/prompt43-unit.ts", "scripts/prompt43-goods-return-check.mjs", "scripts/prompt43-goods-returns-browser-fixture.mjs", "scripts/prompt43-goods-return-static-scan.mjs"].map(exists).every(Boolean));

/* --------------------------- 2. migration law ----------------------------- */
record("6. EXACTLY ONE P43 migration directory (§117)", (() => {
  const dirs = readdirSync(`${ROOT}prisma/migrations`).filter((d) => d.includes("prompt43"));
  return dirs.length === 1 && dirs[0].endsWith("_prompt43_goods_returns");
})());
record("7. migration DDL is additive (2 CREATE TABLE + indexes only, §118)", (() => {
  const sql = read("prisma/migrations/20261008090000_prompt43_goods_returns/migration.sql");
  return (
    (sql.match(/CREATE TABLE/g) ?? []).length === 2 &&
    sql.includes('"GoodsReturn"') &&
    sql.includes('"GoodsReturnLine"') &&
    !/DROP TABLE|ALTER TABLE .* ADD CONSTRAINT/i.test(sql)
  );
})());

/* --------------------------- 3. schema law -------------------------------- */
record("8. GoodsReturn model exists (§24)", /model GoodsReturn \{/.test(SCHEMA_PRISMA));
record("9. GoodsReturnLine model exists (§27)", /model GoodsReturnLine \{/.test(SCHEMA_PRISMA));
record("10. @@unique([businessId, reference]) DB-enforced (§19)", /model GoodsReturn \{[\s\S]*?@@unique\(\[businessId, reference\]\)/.test(SCHEMA_PRISMA));
record("11. @@unique([goodsReturnId, goodsReceiptLineId]) DB-enforced (§29)", /model GoodsReturnLine \{[\s\S]*?@@unique\(\[goodsReturnId, goodsReceiptLineId\]\)/.test(SCHEMA_PRISMA));
record("12. §119 indexes: businessId+status/createdAt/postedAt/goodsReceiptId", ["@@index([businessId, status])", "@@index([businessId, createdAt])", "@@index([businessId, postedAt])", "@@index([businessId, goodsReceiptId])"].every((i) => /model GoodsReturn \{[\s\S]*?@@unique/.test(SCHEMA_PRISMA) === false || SCHEMA_PRISMA.includes(i)));
record("13. line reverse indexes (§119)", (() => {
  const m = SCHEMA_PRISMA.split("model GoodsReturnLine {")[1] ?? "";
  return ["@@index([goodsReceiptLineId])", "@@index([productId])", "@@index([goodsReturnId])"].every((i) => m.includes(i));
})());
record("14. Business cascade on GoodsReturn (§25/§120)", /model GoodsReturn \{[\s\S]*?business   Business @relation\(fields: \[businessId\], references: \[id\], onDelete: Cascade\)/.test(SCHEMA_PRISMA));
record("15. Product Restrict on GoodsReturnLine (§28/§120)", (() => {
  const m = SCHEMA_PRISMA.split("model GoodsReturnLine {")[1] ?? "";
  return m.includes("onDelete: Restrict");
})());
record("16. NO new receipt/PO status values (§130)", (() => {
  const banned = ['@default("PARTIALLY_RETURNED")', '@default("RETURNED")', '@default("REOPENED")', '@default("RECEIVED_AGAIN")'];
  return banned.every((b) => !SCHEMA_PRISMA.includes(b));
})());
record("17. receivedQty NOT denormalized onto GoodsReturnLine (§34)", (() => {
  const m = SCHEMA_PRISMA.split("model GoodsReturnLine {")[1] ?? "";
  return !/receivedQty\s+Int/.test(m);
})());

/* --------------------------- 4. status machine ----------------------------- */
record("18. closed status vocabulary (§9)", /\["DRAFT", "POSTED", "CANCELLED"\]/.test(TYPES_CODE));
record("19. POSTED terminal (§11 — no reversal)", /POSTED: \[\]/.test(TYPES_CODE));
record("20. CANCELLED terminal (§12)", /CANCELLED: \[\]/.test(TYPES_CODE));
record("21. parseGoodsReturnStatus centralized (§65)", /export function parseGoodsReturnStatus/.test(TYPES_CODE));
record("22. corrupt status → integrity class (never Draft)", /class GoodsReturnStatusIntegrityError/.test(TYPES_CODE));
record("23. NO →DRAFT fallback in the domain", !/status = "DRAFT"|status: "DRAFT"\s*\|\|/.test(TYPES_CODE.replace("status: \"DRAFT\"", "")));
record("24. lifecycle gates exported (§10/§11/§12)", /goodsReturnLinesEditable/.test(TYPES_CODE) && /goodsReturnIsReadOnly/.test(TYPES_CODE));

/* --------------------------- 5. quantity laws ------------------------------ */
record("25. returnedQty integer 1..1e6 (§32)", /RETURNED_QTY_MIN = 1/.test(TYPES_CODE) && /GOODS_RETURN_QTY_MAX = 1_000_000/.test(TYPES_CODE));
record("26. line cap default 200 clamp [20,500] (§33)", /GOODS_RETURN_LINE_CAP_DEFAULT = 200/.test(TYPES_CODE) && /GOODS_RETURN_LINE_CAP_MIN = 20/.test(TYPES_CODE) && /GOODS_RETURN_LINE_CAP_MAX = 500/.test(TYPES_CODE));
record("27. defensive cap parser with safe fallback (§33)", /export function goodsReturnLineCap\(env[\s\S]*?Number\.parseInt[\s\S]*?return GOODS_RETURN_LINE_CAP_DEFAULT/.test(TYPES_CODE));
record("28. closed reason vocabulary (§23)", /GOODS_RETURN_REASON_CODES = \[\s*"DAMAGED",\s*"WRONG_ITEM",\s*"QUALITY_ISSUE",\s*"EXCESS",\s*"OTHER",?\s*\]/.test(TYPES_CODE));

/* --------------------------- 6. canonical math ----------------------------- */
record("29. ONE returnable-qty law (§36)", /export function computeReturnableQty/.test(TYPES_CODE));
record("30. returnable corruption: returned > received throws (never clamps)", /returnedQty > receivedQty[\s\S]*?GoodsReturnIntegrityError/.test(TYPES_CODE));
record("31. ONE cumulative-return cap law (§35)", /export function exceedsReturnable/.test(TYPES_CODE));
record("32. ONE net-received law (§77)", /export function computeNetReceivedQty/.test(TYPES_CODE));
record("33. net corruption: returned > gross throws (§79)", /returnedQty > grossReceivedQty[\s\S]*?GoodsReturnIntegrityError/.test(TYPES_CODE));
record("34. ONE net-remaining law (§79)", /export function computeNetRemainingQty/.test(TYPES_CODE));
record("35. net > ordered throws (§79)", /netReceivedQty > orderedQty[\s\S]*?GoodsReturnIntegrityError/.test(TYPES_CODE));
record("36. stockAfterReturn exact-integer law (§42)", /export function stockAfterReturn/.test(TYPES_CODE));
record("37. negative persisted stock throws (never zeroed, §41)", /currentStock < 0[\s\S]*?GoodsReturnIntegrityError/.test(TYPES_CODE));
record("38. newStock < 0 throws (§39/§41)", /newStock < 0[\s\S]*?GoodsReturnIntegrityError/.test(TYPES_CODE));
record("39. no float math in domain (§139)", !/parseFloat\(|Math\.round\(|toFixed\(/.test(TYPES_CODE + SERVICE_CODE));

/* --------------------------- 7. tenant + RBAC ------------------------------ */
record("40. every route requires auth + permission (§69)", (API_CODE.match(/requirePermission\(ctx, "data:(read|write)"\)/g) ?? []).length >= 9);
record("41. routes derive tenant from ctx only (§67)", (API_CODE.match(/ctx\.businessId/g) ?? []).length >= 7);
record("42. NO route reads a client businessId", !/body\.businessId|input\.businessId/.test(API_CODE));
record("43. malformed ids resolve to safe 404 (§68)", (API_CODE.match(/isValidEntityId/g) ?? []).length >= 5);
record("44. NO existence leak in 404 messages", !/another (tenant|business)/i.test(API_CODE));

/* --------------------------- 8. source-receipt law ------------------------- */
record("45. source receipt loaded through ONE tenant-scoped loader (§13)", /async function loadPostedSourceReceipt/.test(SERVICE_CODE));
record("46. corrupt SOURCE receipt status uses P42 parser (§66)", SERVICE_CODE.includes("parseGoodsReceiptStatus") && SERVICE_CODE.includes("GOODS_RECEIPT_INVALID_PERSISTED_STATUS"));
record("47. non-POSTED source → stable 422 (§13)", section(SERVICE_CODE, "async function loadPostedSourceReceipt").includes("GOODS_RETURN_ERROR_CODES.SOURCE_NOT_POSTED"));
record("48. foreign source line → 404 with stable code (§68/§142)", section(SERVICE_CODE, "export async function addGoodsReturnLine").includes("GOODS_RETURN_ERROR_CODES.SOURCE_LINE_NOT_FOUND"));
record("49. product derives from receipt line (never client, §28/§47)", SERVICE_CODE.includes("productId: receiptLine.productId"));
record("50. product tenant belt-and-braces check at line add", /receiptLine\.product\.businessId !== input\.businessId/.test(SERVICE_CODE));

/* --------------------------- 9. snapshots ---------------------------------- */
record("51. supplier snapshot from receipt (never live Supplier, §16)", SERVICE_CODE.includes("supplierNameAtReturn: receipt.supplierNameAtReceipt"));
record("52. receipt reference snapshot (§17)", SERVICE_CODE.includes("goodsReceiptReferenceAtReturn: receipt.reference"));
record("53. PO reference snapshot (§18)", SERVICE_CODE.includes("purchaseOrderReferenceAtReturn: receipt.purchaseOrderReferenceAtReceipt"));
record("54. line snapshots from RECEIPT LINE (§30)", SERVICE_CODE.includes("productNameAtReturn: receiptLine.productNameAtReceipt"));

/* --------------------------- 10. line-add validation ----------------------- */
record("55. duplicate source line → 409 GOODS_RETURN_DUPLICATE_LINE (§75)", section(SERVICE_CODE, "export async function addGoodsReturnLine").includes("GOODS_RETURN_ERROR_CODES.DUPLICATE_LINE") && section(SERVICE_CODE, "export async function addGoodsReturnLine").includes("P2002"));
record("56. line cap enforced at add (§62)", section(SERVICE_CODE, "export async function addGoodsReturnLine").includes("assertLineCap") && SERVICE_CODE.includes("GOODS_RETURN_ERROR_CODES.LINE_LIMIT"));
record("57. advisory cumulative check at add (§62)", (() => {
  const m = SERVICE_CODE.split("export async function addGoodsReturnLine")[1]?.split("/* ------------------------------- line update")[0] ?? "";
  return m.includes("exceedsReturnable(") && m.includes("sumPostedReturnedQtyForReceiptLine");
})());

/* --------------------------- 11. aggregate law (§37/§140) ------------------ */
record("58. returned sums are DB aggregates (§37)", /goodsReturnLine\.aggregate\(\{/.test(SERVICE_CODE) && /_sum: \{ returnedQty: true \}/.test(SERVICE_CODE));
record("59. NO in-memory history findMany for the single-line sum", (() => {
  const m = SERVICE_CODE.match(/export async function sumPostedReturnedQtyForPoLine[\s\S]*?\n\}/)?.[0] ?? "";
  return m.includes(".aggregate({") && !m.includes(".findMany(");
})());
record("60. grouped multi-line sums (no N+1, §141)", /sumPostedReturnedQtyForReceiptLines[\s\S]*?groupBy/.test(SERVICE_CODE) || /groupBy\(\{[\s\S]*?goodsReceiptLineId/.test(SERVICE_CODE));
record("61. aggregate re-validated (SAFE integer, ≥0, never clamped, §8)", (() => {
  const m = SERVICE_CODE.match(/function validateReturnedSum[\s\S]*?\n\}/)?.[0] ?? "";
  return m.includes("Number.isSafeInteger") && m.includes("sum < 0");
})());
record("62. POSTED-only aggregate filter (§9 — drafts never counted)", (SERVICE_CODE.match(/status: "POSTED"/g) ?? []).length >= 4);

/* --------------------------- 12. read completeness (§76) ------------------- */
record("63. ≥5 cap+1 completeness reads", (SERVICE_CODE.match(/cap \+ 1/g) ?? []).length >= 5);
record("64. NO bare take:cap truncation", !/take: cap,/.test(SERVICE_CODE));
record("65. list _count consistency invariant (§16 — canonical validator + explicit mismatch arm)", (() => {
  const list = SERVICE_CODE.slice(SERVICE_CODE.indexOf("export async function listGoodsReturns"), SERVICE_CODE.indexOf("/* -------------------------------- detail"));
  return list.includes("assertGoodsReturnLineSetComplete(row.lines.length, row._count.lines, cap)");
})());
record("66. ONE cap-invariant law: the pure canonical validator + ONE mapper branch (§76/§15)", TYPES_CODE.includes("export function assertGoodsReturnLineSetComplete") && SERVICE_CODE.includes("error.message.includes(GOODS_RETURN_LINE_CAP_INVARIANT)"));
record("67. detail read enforces the invariant", (() => {
  const m = SERVICE_CODE.split("export async function getGoodsReturn")[1]?.split("/* ------------------------------ header patch")[0] ?? "";
  return m.includes("assertGoodsReturnLineSetComplete");
})());
record("68. canonical cap-invariant code (§76/§142)", SERVICE_CODE.includes("GOODS_RETURN_LINE_CAP_INVARIANT") && TYPES_CODE.includes('GOODS_RETURN_LINE_CAP_INVARIANT = "GOODS_RETURN_LINE_CAP_INVARIANT"'));

/* --------------------------- 13. post transaction (§43/§48) ---------------- */
record("69. post uses the SHARED write transaction (§50)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("withWriteTx(");
})());
record("70. write-transaction helper reused verbatim (no second serializer)", SERVICE_CODE.includes('from "@/lib/db/write-transaction"') && WRITE_TX.includes("export async function withWriteTransaction"));
record("71. status re-checked INSIDE the tx (§43 step 3 / §53)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("assertTransition(header.status, \"POSTED\")") && m.includes("loadReturnHeader(tx");
})());
record("72. source receipt re-verified inside the post tx (§43 step 5)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("loadPostedSourceReceipt(tx");
})());
record("73. post-time lines read with cap+1 (§43 step 7)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("take: cap + 1");
})());
record("74. empty post rejected 422 (§61)", (() => {
  const m = section(SERVICE_CODE, "export async function postGoodsReturn");
  return m.includes("GOODS_RETURN_ERROR_CODES.EMPTY") && m.includes("lines.length === 0");
})());
record("75. authoritative cumulative check at post (§43 step 11)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("exceedsReturnable(") && m.includes("sumPostedReturnedQtyForReceiptLines");
})());
record("76. current stock check at post (§39)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("INSUFFICIENT_STOCK") && m.includes("product.stockQty < line.returnedQty");
})());
record("77. stockAfterReturn used (exact integer arithmetic, §42)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("stockAfterReturn(");
})());
record("78. stock decrement present (§6 — one update per line)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("tx.product.update") && m.includes("stockQty: newStock");
})());
record("79. ONE NEGATIVE adjustment per line (§44)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("tx.inventoryAdjustment.create") && m.includes("delta: -line.returnedQty");
})());
record("80. adjustment reason ties to the return reference (§44)", /RETURN_ADJUSTMENT_REASON = \(reference: string\) =>[\s\S]*?Goods return \$\{reference\}/.test(SERVICE_CODE));
record("81. adjustment actor/business server-derived (§45/§46)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("actorId: input.userId") && m.includes("businessId: input.businessId");
})());
record("82. postedAt server-generated with status (§43 step 19)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("const postedAt = new Date()") && m.includes('status: "POSTED", postedAt');
})());
record("83. post audit INSIDE the same tx (§48/§133)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes('audit(\n      auditInput(input.businessId, input.userId, "goods_return.post"') || (m.includes('"goods_return.post"') && m.includes("tx,"));
})());
record("84. stock rollback bookkeeping returned (multi-line failure → zero survivors §52)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return m.includes("stockChanges");
})());
record("85. NO source-receipt mutation in the post path (§8)", (() => {
  const m = SERVICE_CODE.split("export async function postGoodsReturn")[1]?.split("/* --------------------------------- cancel")[0] ?? "";
  return !m.includes("tx.goodsReceipt.update") && !m.includes("tx.goodsReceiptLine.update") && !m.includes("tx.goodsReceiptLine.delete");
})());

/* --------------------------- 14. cancel semantics -------------------------- */
record("86. cancel = DRAFT-only pure transition (§12)", (() => {
  const m = SERVICE_CODE.split("export async function cancelGoodsReturn")[1] ?? "";
  return m.includes('assertTransition(header.status, "CANCELLED")') && !m.includes("tx.product.update") && !m.includes("tx.inventoryAdjustment");
})());

/* --------------------------- 15. immutability ------------------------------ */
record("87. NO generic status PATCH route (§59 — dedicated endpoints)", !exists("src/app/api/v1/inventory/goods-returns/[id]/status/route.ts"));
record("88. NO user-facing delete route for returns (§120)", !exists("src/app/api/v1/inventory/goods-returns/[id]/delete/route.ts") && !(read("src/app/api/v1/inventory/goods-returns/[id]/route.ts").includes("export const DELETE")));
record("89. header patch: DRAFT-only, reference/notes only (§59)", (() => {
  const m = section(SERVICE_CODE, "export async function updateGoodsReturn");
  return m.includes("requireDraft(header.status)") && m.includes("data.reference = input.reference") && !m.includes("goodsReceiptId:");
})());

/* --------------------------- 16. error vocabulary -------------------------- */
record("90. §142 error codes centralized", (() => {
  const codes = [
    "GOODS_RETURN_DUPLICATE_REFERENCE",
    "GOODS_RETURN_DUPLICATE_LINE",
    "GOODS_RETURN_EMPTY",
    "GOODS_RETURN_LINE_LIMIT_REACHED",
    "GOODS_RETURN_EXCEEDS_RETURNABLE",
    "GOODS_RETURN_INSUFFICIENT_STOCK",
    "GOODS_RETURN_INVALID_TRANSITION",
    "GOODS_RETURN_INVALID_PERSISTED_STATUS",
    "GOODS_RETURN_CORRUPT_HISTORY",
    "GOODS_RETURN_LINE_CAP_INVARIANT",
    "GOODS_RETURN_IMMUTABLE",
    "GOODS_RETURN_SOURCE_NOT_POSTED",
    "GOODS_RETURN_SOURCE_LINE_NOT_FOUND",
  ];
  return codes.every((c) => TYPES_CODE.includes(c));
})());
record("91. no raw internals in client-facing errors (§143)", !/stack|sqlMessage|prisma error/i.test(SERVICE_CODE.split("throw new ApiError").join("")));

/* --------------------------- 17. zod boundaries ---------------------------- */
record("92. line create is STRICT (client productId rejected, §57)", /goodsReturnLineCreateSchema = z\s*\n?\s*\.object\(/.test(SCHEMA_CODE) && /\.strict\(\)/.test(SCHEMA_CODE.split("goodsReturnLineCreateSchema")[1]?.split("export const")[0] ?? ""));
record("93. line update ONLY qty+reason (§58)", (() => {
  const m = SCHEMA_CODE.split("export const goodsReturnLineUpdateSchema")[1]?.split("export const")[0] ?? "";
  return m.includes("returnedQty") && m.includes("reasonCode") && m.includes(".strict()");
})());
record("94. patch schema has no goodsReceiptId/status (§59)", (() => {
  const m = SCHEMA_CODE.split("export const goodsReturnUpdateSchema")[1]?.split("export const")[0] ?? "";
  return !m.includes("goodsReceiptId") && !m.includes("status:");
})());
record("95. strict calendar dates (§74 — no rollover, ONE canonical law)", (() => {
  // The canonical validator lives in types.ts; the schema re-exports it.
  const t = TYPES_CODE;
  return t.includes("export function isValidCalendarDate") && t.includes("daysInMonth") && SCHEMA_CODE.includes("export { isValidCalendarDate }") && !SCHEMA_CODE.includes("const daysInMonth");
})());

/* --------------------------- 18. DTO allowlists ---------------------------- */
record("96. DTO mappers parse status centrally (never Draft)", (DTO_CODE.match(/parseGoodsReturnStatus/g) ?? []).length >= 1);
record("97. NO money field anywhere in the DTO module (§70)", !/(unitPriceMinor|amountMinor|totalMinor)\s*[:?]/.test(DTO_CODE));
record("98. NO money field anywhere in the service (§7)", !/(unitPriceMinor|amountMinor|totalMinor)\s*[:?]/.test(SERVICE_CODE));

/* --------------------------- 19. CSV export -------------------------------- */
record("99. export route: entitlement gate (§108)", read(ROUTES[6]).includes("CSV_EXPORT"));
record("100. export route: rate limit present (§109)", read(ROUTES[6]).includes("rateLimit("));
record("101. export route: no-store + attachment (§106)", read(ROUTES[6]).includes("no-store") && read(ROUTES[6]).includes("attachment"));
record("102. export route: data.export audit (§111)", read(ROUTES[6]).includes("data.export"));
record("103. export route: strict locale en|fa (§103)", read(ROUTES[6]).includes('"fa" ? "fa" : "en"'));
record("104. shared toCsv serializer reused (§106 — no second engine)", EXPORT_CODE.includes('from "@/lib/csv"') && EXPORT_CODE.includes("toCsv("));
record("105. export: cap+1 completeness + truncated flag (§105)", EXPORT_CODE.includes("take: cap + 1") && EXPORT_CODE.includes("truncated"));
record("106. export columns: NO money (§104)", !/unitPriceMinor|amountMinor|totalMinor/.test(EXPORT_CODE));
record("107. export: reason column present (§104)", EXPORT_CODE.includes("l.reasonCode"));

/* --------------------------- 20. P42 integration --------------------------- */
record("108. P42 service consumes the canonical return aggregate (§80)", (() => {
  const s = read("src/lib/inventory/goods-receipt/service.ts");
  return s.includes("sumPostedReturnedQtyForPoLine") && s.includes("netReceivedForPoLine");
})());
record("109. P42 over-receipt law still consulted (§125)", (read("src/lib/inventory/goods-receipt/service.ts").match(/exceedsRemaining\(/g) ?? []).length >= 3);
record("110. receiving summary reports gross + returned + net (§77-§79)", (() => {
  const s = read("src/lib/inventory/goods-receipt/service.ts");
  return s.includes("netReceivedQty") && s.includes("returnedQty") && s.includes("fullyReceived: remainingQty === 0");
})());
record("111. PO detail DTO carries ADDITIVE net fields (§78)", (() => {
  const d = read("src/lib/purchase-orders/dto.ts");
  return d.includes("returnedQty") && d.includes("netReceivedQty") && d.includes("receivedQty: number");
})());
record("112. gross received meaning PRESERVED (§78 — receivedQty stays gross)", (() => {
  const s = read("src/lib/inventory/goods-receipt/service.ts");
  return /receivedQty = 0; \/\/ §78 — GROSS received/.test(s);
})());
record("113. receipt detail route merges ADDITIVE return facts (§86-§88)", read("src/app/api/v1/inventory/goods-receipts/[id]/route.ts").includes("getGoodsReceiptReturnFacts") && read("src/app/api/v1/inventory/goods-receipts/[id]/route.ts").includes("listRecentReturnsForReceipt"));

/* --------------------------- 21. entity 360s + search ---------------------- */
record("114. supplier 360 bounded return history (≤10, §100)", read("src/app/api/v1/suppliers/[id]/route.ts").includes("listRecentReturnsForSupplier"));
record("115. product detail bounded return history (≤10, §99)", read("src/app/api/v1/products/[id]/route.ts").includes("listRecentReturnsForProduct"));
record("116. entity types declare recentGoodsReturns (§99/§100)", (() => {
  const t = read("src/lib/entities/types.ts");
  return t.includes("recentGoodsReturns?: SupplierRecentReturn[]") && t.includes("recentGoodsReturns?: ProductRecentReturn[]");
})());
record("117. SEARCH_ENTITY_TYPES includes GOODS_RETURN (§101)", read("src/lib/search/types.ts").includes('"GOODS_RETURN"'));
record("118. search destination allowlisted (§91/§101)", read("src/lib/search/types.ts").includes('"goods-returns"'));
record("119. search prefilter tenant-scoped (§102)", (() => {
  const q = read("src/lib/search/query.ts").split("async function searchGoodsReturns")[1]?.split("/**")[0] ?? "";
  return q.includes("businessId,") && q.includes("db.goodsReturn.findMany");
})());
record("120. search candidate bounded lines (never unbounded)", (() => {
  const q = read("src/lib/search/query.ts").split("async function searchGoodsReturns")[1]?.split("/**")[0] ?? "";
  return q.includes("goodsReturnLineCap(");
})());
record("121. search carries NO money (§101)", !/unitPriceMinor|amountMinor|totalMinor/.test((() => {
  const q = read("src/lib/search/query.ts").split("async function searchGoodsReturns")[1]?.split("/**")[0] ?? "";
  return q;
})()));

/* --------------------------- 22. portability ------------------------------- */
record("122. export catalog: inventory_goods_returns dataset (§112)", read("src/lib/data-portability/export-catalog.ts").includes('"inventory_goods_returns"'));
record("123. export catalog: lines dataset (§112)", read("src/lib/data-portability/export-catalog.ts").includes('"inventory_goods_return_lines"'));
record("124. implication: returns → lines (§113)", /inventory_goods_returns: \["inventory_goods_return_lines"\]/.test(read("src/lib/data-portability/export-catalog.ts")));
record("125. datasets classified CONFIDENTIAL (§112)", (() => {
  const c = read("src/lib/data-portability/export-catalog.ts");
  return /inventory_goods_returns: \{ key: "inventory_goods_returns", sensitivity: "CONFIDENTIAL"/.test(c) && /inventory_goods_return_lines: \{ key: "inventory_goods_return_lines", sensitivity: "CONFIDENTIAL"/.test(c);
})());
record("126. return datasets are EXPORT-ONLY (§114 — not in import catalog)", (() => {
  const imp = read("src/lib/data-portability/import-fields.ts");
  return !imp.includes("inventory_goods_returns") && !imp.includes("inventory_goods_return_lines");
})());
record("127. return export rows: NO money conversion (§7)", (() => {
  const c = read("src/lib/data-portability/export-catalog.ts").split("inventory_goods_returns: async")[1]?.split("inventory_goods_return_lines: async")[0] ?? "";
  return !c.includes("formatMinorToDecimal");
})());

/* --------------------------- 23. UI laws ----------------------------------- */
record("128. detail view: POSTED/CANCELLED read-only (§97/§98)", (() => {
  const v = read(UI[1]);
  return v.includes("canPost = writable && isDraft") && v.includes("canEdit = writable && isDraft");
})());
record("129. post confirmation shows the §95 warning", read(UI[1]).includes("postWarning"));
record("130. post confirmation shows the §147 financial note", read(UI[1]).includes("postFinancialNote"));
record("131. post confirmation shows estimated stock impact (§95)", read(UI[1]).includes("estimatedStockImpact"));
record("132. NO refund/credit-note/payment wording in the UI (§96)", (() => {
  const v = read(UI[1]) + read(UI[0]) + read(UI[2]);
  return !/refund issued|credit note created|supplier balance reduced|payment reversed|expense reversed/i.test(v);
})());
record("133. line dialog max = current returnable (§94)", read(UI[4]).includes("line.returnableQty"));
record("134. picker offers ONLY returnable receipt lines (§93)", (() => {
  const p = read(UI[3]);
  return p.includes("returnableQty") && !p.includes("unitPrice");
})());
record("135. reason selector uses the CLOSED vocabulary (§23)", read(UI[4]).includes("GOODS_RETURN_REASON_CODES"));
record("136. create dialog submits ONLY goodsReceiptId/reference/notes (§56)", read(UI[2]).includes("goodsReceiptId:") && !read(UI[2]).includes("status:"));
record("137. §87 CTA present on the receipt detail", read("src/modules/inventory/goods-receipts/goods-receipt-detail-view.tsx").includes("create-goods-return-cta"));
record("138. §88 return history present on the receipt detail", read("src/modules/inventory/goods-receipts/goods-receipt-detail-view.tsx").includes("returnHistory"));
record("139. §83 PO net receiving labels present", read("src/modules/purchase-orders/purchase-order-detail-view.tsx").includes("netReceived") && read("src/modules/purchase-orders/purchase-order-detail-view.tsx").includes("returnedToSupplier"));
record("140. §85 closed-PO explanation present", read("src/modules/purchase-orders/purchase-order-detail-view.tsx").includes("poClosedAfterReturn"));
record("141. invalidation list includes products+adjustments+entities (§148)", read(UI[1]).includes('queryKey: ["products"]') && read(UI[1]).includes('queryKey: ["adjustments"]') && read(UI[1]).includes('queryKey: ["entities", businessId]'));
record("142. deep-link hash routing #/inventory/goods-returns(>/<id>) (§91)", (() => {
  const s = read("src/store/app-store.ts");
  return s.includes('"inventory/goods-returns"') && s.includes("inventory/goods-returns/");
})());
record("143. malformed deep-link id falls back to dashboard (§91)", (() => {
  const s = read("src/store/app-store.ts").split("if (path === \"inventory/goods-returns\")")[1]?.split("const entityRoute")[0] ?? "";
  return (s.match(/return \{ kind: "dashboard" \}/g) ?? []).length >= 2;
})());
record("144. navigation entry: Goods Returns (§90)", read("src/modules/shell/app-sidebar.tsx").includes('labelKey: "goodsReturns"'));
record("145. command palette entry (§90)", read("src/modules/shell/command-palette.tsx").includes('labelKey: "goodsReturns"'));

/* --------------------------- 24. i18n -------------------------------------- */
record("146. EN+FA goodsReturns namespaces present (§144)", EN_SRC.includes("  goodsReturns: {") && FA_SRC.includes("  goodsReturns: {"));
record("147. EN+FA nav keys (§90)", EN_SRC.includes('goodsReturns: "Goods Returns"') && FA_SRC.includes('goodsReturns: "مرجوعی کالا"'));
record("148. Persian §145 terms present", ["مرجوعی کالا", "مقدار مرجوع‌شده", "مقدار قابل مرجوع", "مقدار کل دریافت‌شده", "مقدار دریافت‌شده خالص", "علت مرجوعی", "ثبت‌شده", "لغوشده"].every((k) => FA_SRC.includes(k)));
record("149. EN+FA reason vocabulary (§23)", ["DAMAGED", "WRONG_ITEM", "QUALITY_ISSUE", "EXCESS", "OTHER"].every((r) => EN_SRC.includes(`reason_${r}`) && FA_SRC.includes(`reason_${r}`)));
record("150. FA never financial-return wording (§96)", !/بازگشت پول|برگشت پرداخت/.test(FA_SRC.split("goodsReturns: {")[1]?.split("\n  },")[0] ?? ""));
record("151. EN returns namespace never refund wording (§96)", (() => {
  const ns = EN_SRC.split("  goodsReturns: {")[1]?.split("\n  },")[0] ?? "";
  return !/refund/i.test(ns);
})());
record("152. portability dataset labels EN+FA (§112)", EN_SRC.includes("inventoryGoodsReturns") && FA_SRC.includes("inventoryGoodsReturns"));
record("153. search group label EN+FA (§101)", EN_SRC.includes('GOODS_RETURN: "Goods Returns"') && FA_SRC.includes('GOODS_RETURN: "مرجوعی کالا"'));

/* --------------------------- 25. audit ------------------------------------- */
record("154. all 7 audit actions in the service (§131)", (() => {
  const actions = ["goods_return.create", "goods_return.update", "goods_return.line_add", "goods_return.line_update", "goods_return.line_remove", "goods_return.post", "goods_return.cancel"];
  return actions.every((a) => SERVICE_CODE.includes(a));
})());
record("155. audit metadata carries NO notes content (§22/§132)", (() => {
  const m = section(SERVICE_CODE, "function auditInput");
  return m.includes("after: { reference") && !m.includes("notes");
})());
record("156. post audit carries quantity facts only (§132)", (() => {
  const m = section(SERVICE_CODE, '"goods_return.post"');
  return m.includes("totalReturnedQty") && !m.includes("notes:");
})());

/* --------------------------- 26. NO prohibited scope ----------------------- */
record("157. NO credit-note/expense/payment model created (§3)", (() => {
  const banned = ["model CreditNote", "model SupplierInvoice", "model PurchaseInvoice", "model PayablesAging"];
  return banned.every((b) => !SCHEMA_PRISMA.includes(b));
})());
record("158. domain writes NO financial rows (§7)", (() => {
  const banned = ["tx.expense.create", "tx.payment.create", "tx.sale.create", "tx.creditNote"];
  return banned.every((b) => !SERVICE_CODE.includes(b));
})());
record("159. NO statement/payable writes from the domain (§7)", !/(supplierStatement|payablesAging|customerStatement)/i.test(SERVICE_CODE));
record("160. NO notification expansion (§134)", !SERVICE_CODE.includes("notification.create") && !UI_CODE.toLowerCase().includes("sendnotification"));
record("161. NO AI expansion (§135)", !SERVICE_CODE.includes("copilot") && !SERVICE_CODE.includes("aiContext"));
record("162. NO warehouse/lot/serial/barcode scope (§3)", (() => {
  const banned = ["warehouseId", "lotNo", "serialNo", "barcode", "binLocation", "expiryDate"];
  const all = TYPES_CODE + SERVICE_CODE + SCHEMA_CODE;
  return banned.every((b) => !all.includes(b));
})());
record("163. NO Redis/queue/worker scope (§3)", !SERVICE_CODE.includes("redis") && !SERVICE_CODE.includes("new Worker") && !SERVICE_CODE.includes("bullmq"));

/* --------------------------- 27. portability + backup ---------------------- */
record("164. restore-drill probes GoodsReturn + GoodsReturnLine (§116)", (() => {
  const s = read("scripts/restore-drill.mjs");
  return s.includes('"GoodsReturn", "GoodsReturnLine"');
})());
record("165. env-repair baseline carries the P43 migration (§117)", read("scripts/env-repair.mjs").includes("20261008090000_prompt43_goods_returns"));

/* --------------------------- 28. docs -------------------------------------- */
record("166. product doc states lifecycle + cap + stock check (§175)", (() => {
  const d = read("docs/product/goods-returns.md").toLowerCase();
  return d.includes("draft") && d.includes("posted") && d.includes("cancel") && d.includes("returnable");
})());
record("167. security doc exists and covers tenant + concurrency (§150)", (() => {
  const d = read("docs/security/goods-returns-security.md").toLowerCase();
  return d.includes("tenant") && d.includes("concurren");
})());
record("168. ADR exists (§174)", read("docs/adr/0043-goods-returns.md").length > 200);
record("169. financial semantics doc: inventory YES / financial NO (§176)", (() => {
  const d = read("docs/audit/financial-semantics.md");
  return d.includes("GoodsReturn") && d.includes("InventoryAdjustment");
})());
record("170. goods-receipts doc updated for net receiving (§177)", (() => {
  const d = read("docs/product/goods-receipts.md");
  return d.includes("net") || d.includes("Net");
})());
record("171. data-export doc covers the new datasets (§179)", read("docs/data/data-export.md").includes("inventory_goods_returns"));
record("172. data-import doc documents the export-only policy (§180)", read("docs/data/data-import.md").includes("inventory_goods_returns") || read("docs/data/data-import.md").toLowerCase().includes("goods return"));
record("173. backup-restore plan updated (§181)", read("docs/deployment/backup-restore-plan.md").includes("GoodsReturn"));
record("174. deletion matrix updated (§120)", read("docs/legal/data-deletion-matrix.md").includes("GoodsReturn"));
record("175. ARCHITECTURE mentions the goods-return domain (§174)", read("docs/ARCHITECTURE.md").includes("GoodsReturn") || read("docs/ARCHITECTURE.md").toLowerCase().includes("goods return"));

/* ------------------ 29. P43-F correctness-hardening laws ------------------- */
// §6 — every quantity validator requires SAFE integers.
record("176. isValidReturnedQty requires Number.isSafeInteger (§6)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function isValidReturnedQty"), TYPES_CODE.indexOf("isValidPersistedReturnedQty"));
  return fn.includes("Number.isSafeInteger") && !/Number\.isInteger\(/.test(fn);
})());
record("177. isValidPersistedReturnedQty exists + is safe-integer + ≥1 (§6/§7)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function isValidPersistedReturnedQty"), TYPES_CODE.indexOf("isSafeNonNegativeInteger"));
  return fn.includes("Number.isSafeInteger") && fn.includes("RETURNED_QTY_MIN") && fn.includes("GOODS_RETURN_QTY_MAX");
})());
// §7 — the canonical sum rejects a persisted zero and proves total safety.
record("178. computeReturnedQty rejects zero/negative summands (≥1 law, §7)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function computeReturnedQty"), TYPES_CODE.indexOf("assertGoodsReturnLineSetComplete"));
  return fn.includes("isValidPersistedReturnedQty(qty)") && !fn.includes("qty < 0");
})());
record("179. computeReturnedQty proves the running total stays SAFE (§7)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function computeReturnedQty"), TYPES_CODE.indexOf("assertGoodsReturnLineSetComplete"));
  return fn.includes("Number.isSafeInteger(total)");
})());
// §8 — the aggregate re-validation requires a safe integer.
record("180. validateReturnedSum requires Number.isSafeInteger + ≥0 (§8)", (() => {
  const fn = SERVICE_CODE.slice(SERVICE_CODE.indexOf("function validateReturnedSum"), SERVICE_CODE.indexOf("sumPostedReturnedQtyForReceiptLines"));
  return fn.includes("Number.isSafeInteger") && fn.includes("sum < 0");
})());
// §10/§11 — net math rejects unsafe integers and never clamps.
record("181. computeNetReceivedQty is safe-integer-checked (§10)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function computeNetReceivedQty"), TYPES_CODE.indexOf("export function computeNetRemainingQty"));
  return (fn.match(/isSafeNonNegativeInteger/g) ?? []).length >= 2;
})());
record("182. computeNetRemainingQty is safe-integer-checked, NO clamp (§11)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function computeNetRemainingQty"), TYPES_CODE.indexOf("§41/§42 stock arithmetic"));
  return (fn.match(/isSafeNonNegativeInteger/g) ?? []).length >= 2 && !fn.includes("Math.max(0");
})());
record("183. computeReturnableQty is safe-integer-checked (§6/§8)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function computeReturnableQty"), TYPES_CODE.indexOf("export function exceedsReturnable"));
  return (fn.match(/Number\.isSafeInteger/g) ?? []).length >= 2;
})());
// §12 — exceedsReturnable enforces the canonical quantity contract.
record("184. exceedsReturnable validates all THREE operands before comparing (§12)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function exceedsReturnable"), TYPES_CODE.indexOf("export function computeNetReceivedQty"));
  return (fn.match(/GoodsReturnIntegrityError/g) ?? []).length >= 4 && fn.includes("isValidPersistedReturnedQty(newQty)") && fn.includes("Number.isSafeInteger(cumulative)");
})());
// §13 — post validates every persisted line BEFORE any mutation.
record("185. postGoodsReturn validates EVERY persisted line qty pre-mutation (§13)", (() => {
  const postSection = SERVICE_CODE.slice(SERVICE_CODE.indexOf("export async function postGoodsReturn"));
  return postSection.includes("isValidPersistedReturnedQty(line.returnedQty)") && postSection.indexOf("isValidPersistedReturnedQty(line.returnedQty)") < postSection.indexOf("tx.product.update");
})());
// §14 — stock law splits the classification.
record("186. stockAfterReturn: unsafe inputs rejected; returnedQty → CORRUPT_HISTORY; stock → INVALID_PERSISTED_STOCK (§14)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function stockAfterReturn"), TYPES_CODE.indexOf("export function goodsReturnDayWindow"));
  return fn.includes("Number.isSafeInteger(currentStock)") && fn.includes("isValidPersistedReturnedQty(returnedQty)") && /\$\{GOODS_RETURN_CORRUPT_HISTORY\}: returnedQty/.test(fn) && /\$\{GOODS_RETURN_INVALID_PERSISTED_STOCK\}: currentStock/.test(fn);
})());
// §15/§16/§17 — the count-mismatch law is explicit and independent of cap.
record("187. canonical assertGoodsReturnLineSetComplete enforces fetched/counted/cap invariants (§16)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function assertGoodsReturnLineSetComplete"), TYPES_CODE.indexOf("export function computeReturnableQty"));
  return fn.includes("countedLines > cap") && fn.includes("countedLines !== fetchedLines") && fn.includes("GOODS_RETURN_LINE_CAP_INVARIANT");
})());
record("188. listGoodsReturns routes BOTH counts through the canonical validator (§15/§16)", (() => {
  const list = SERVICE_CODE.slice(SERVICE_CODE.indexOf("export async function listGoodsReturns"), SERVICE_CODE.indexOf("/* -------------------------------- detail"));
  return list.includes("assertGoodsReturnLineSetComplete(row.lines.length, row._count.lines, cap)") && !list.includes("Math.max(row.lines.length");
})());
record("189. detail read also proves completeness via the canonical validator (§54/§55)", (() => {
  const detail = SERVICE_CODE.slice(SERVICE_CODE.indexOf("export async function getGoodsReturn"), SERVICE_CODE.indexOf("/* ------------------------------ header patch"));
  return detail.includes("assertGoodsReturnLineSetComplete(row.lines.length, row.lines.length, cap)");
})());
// §18/§19/§20 — the cap-classification split.
record("190. post-time over-cap is the 500 LINE_CAP_INVARIANT, never 422 LINE_LIMIT (§19)", (() => {
  const postSection = SERVICE_CODE.slice(SERVICE_CODE.indexOf("export async function postGoodsReturn"), SERVICE_CODE.indexOf("export async function cancelGoodsReturn"));
  const overCapIdx = postSection.indexOf("if (lines.length > cap)");
  const gate = postSection.slice(overCapIdx, overCapIdx + 500);
  return gate.includes("GOODS_RETURN_LINE_CAP_INVARIANT") && !gate.includes("GOODS_RETURN_ERROR_CODES.LINE_LIMIT");
})());
record("191. assertLineCap splits: count > cap → 500 INVARIANT; count === cap → 422 LINE_LIMIT (§20)", (() => {
  const fn = SERVICE_CODE.slice(SERVICE_CODE.indexOf("async function assertLineCap"), SERVICE_CODE.indexOf("/* -------------------------------- create"));
  return fn.includes("lineCount > cap") && fn.includes("GOODS_RETURN_LINE_CAP_INVARIANT") && fn.includes("lineCount === cap") && fn.includes("GOODS_RETURN_ERROR_CODES.LINE_LIMIT");
})());
// §22-§24 — business-timezone date filtering.
record("192. NO UTC-midnight day window remains in the service (§22)", !SERVICE_CODE.includes("T00:00:00.000Z") && !SERVICE_CODE.includes("T23:59:59.999Z"));
record("193. list route passes ctx.business.timezone into the service (§23)", read(ROUTES[0]).includes("ctx.business.timezone"));
record("194. goodsReturnDayWindow composes the ESTABLISHED tz helpers (§23 — no second date utility)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function goodsReturnDayWindow"), TYPES_CODE.indexOf("/* ------------------------- §52/§74 calendar dates"));
  return TYPES_CODE.includes('from "@/lib/crm/normalization"') && TYPES_CODE.includes('from "@/lib/statements/schema"') && fn.includes("nextCalendarDay(to)");
})());
record("195. the tz window rejects invalid calendar dates (never JS rollover, §24) + exclusive upper bound (§24)", (() => {
  const fn = TYPES_CODE.slice(TYPES_CODE.indexOf("export function goodsReturnDayWindow"), TYPES_CODE.indexOf("/* ------------------------- §52/§74 calendar dates"));
  return fn.includes("isValidCalendarDate(from)") && fn.includes("isValidCalendarDate(to)") && fn.includes("nextCalendarDay(to)");
})());
record("196. ONE canonical calendar validator (schema re-exports types — no second copy, §23/§52)", (() => {
  const s = SCHEMA_CODE;
  return s.includes('export { isValidCalendarDate }') && !s.includes("const daysInMonth");
})());
// §29/§30 — the E2E financial test is NON-vacuous (before/after snapshots).
record("197. E2E financial section uses NON-ZERO fixtures + before/after exact snapshots (§29/§30)", (() => {
  const s = read("scripts/prompt43-goods-return-check.mjs");
  const fin = s.slice(s.indexOf("financial non-mutation — NON-VACUOUS"), s.indexOf("restore-drill — STRICT"));
  return fin.includes("db.expense.create") && fin.includes("db.payment.create") && fin.includes("after.expenses, before.expenses") && fin.includes("before.supplierStatement") && fin.includes("before.payablesAging") && fin.includes("before.receivables");
})());
record("198. E2E financial snapshot proves the harness detects REAL mutations (stock −qty + 1 adjustment, §29)", (() => {
  const s = read("scripts/prompt43-goods-return-check.mjs");
  const fin = s.slice(s.indexOf("financial non-mutation — NON-VACUOUS"), s.indexOf("restore-drill — STRICT"));
  return fin.includes("stockBeforeFin - 4") && fin.includes("adjBeforeFin + 1");
})());
// §31/§32 — strict restore-drill law.
record("199. E2E restore-drill requires exit 0 AND both probes AND RESULT: PASS (§32)", (() => {
  const s = read("scripts/prompt43-goods-return-check.mjs");
  const drill = s.slice(s.indexOf("restore-drill — STRICT"), s.indexOf("34. cap/concurrency"));
  return drill.includes("drill.status, 0") && drill.includes('rows:GoodsReturn"') && drill.includes('rows:GoodsReturnLine"') && drill.includes("RESULT:") && !/\|\|\s*\/rows:GoodsReturn/.test(drill);
})());
// §9 — corrupted persisted zero-qty E2E probes exist (not vacuous).
record("200. E2E probes corrupted persisted ZERO quantity across detail/list/export/post (§9)", (() => {
  const s = read("scripts/prompt43-goods-return-check.mjs");
  const zero = s.slice(s.indexOf("31c. corrupted persisted ZERO quantity"), s.indexOf("32. financial NON-mutation"));
  return zero.includes("returnedQty: 0") && zero.includes("31c.1") && zero.includes("31c.3") && zero.includes("31c.4") && zero.includes("31c.7");
})());
record("201. E2E business-timezone probes cover +offset/−offset/local-midnight/from-only/to-only (§25)", (() => {
  const s = read("scripts/prompt43-goods-return-check.mjs");
  const tz = s.slice(s.indexOf("31b. business-timezone date filtering"), s.indexOf("31c. corrupted persisted ZERO"));
  return tz.includes("Asia/Tehran") && tz.includes("America/New_York") && tz.includes("20:45") && tz.includes("31b.3") && tz.includes("31b.4");
})());
record("202. unit suite behaviorally covers zero-qty rejection + safe overflow + count mismatch (§26/§17)", (() => {
  const s = read("scripts/prompt43-unit.ts");
  return s.includes("computeReturnedQty([0])") && s.includes("computeReturnedQty([Number.MAX_SAFE_INTEGER, 1])") && s.includes("assertGoodsReturnLineSetComplete(1, 2, 200)");
})());
record("203. reason codes are DTO-boundary-validated (§51 — never translated to OTHER)", (() => {
  const dto = DTO_CODE;
  return dto.includes("isGoodsReturnReasonCode(row.reasonCode)") && dto.includes("GoodsReturnIntegrityError");
})());

console.log(`\n=== prompt43-goods-return-static-scan: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
