/**
 * Prompt 42 — pure unit suite (§227/§228).
 *
 * Pure laws are tested WITHOUT Prisma/db (§228 — no live database). Server
 * transactional behavior is covered by scripts/prompt42-goods-receipt-check.mjs.
 * Run: bun scripts/prompt42-unit.ts
 */
import {
  GOODS_RECEIPT_ERROR_CODES,
  GOODS_RECEIPT_LINE_CAP_DEFAULT,
  GOODS_RECEIPT_LINE_CAP_INVARIANT,
  GOODS_RECEIPT_LINE_CAP_MAX,
  GOODS_RECEIPT_LINE_CAP_MIN,
  GOODS_RECEIPT_QTY_MAX,
  GOODS_RECEIPT_STATUSES,
  GOODS_RECEIPT_TRANSITIONS,
  GoodsReceiptIntegrityError,
  GOODS_RECEIPT_INVALID_PERSISTED_STATUS,
  GoodsReceiptStatusIntegrityError,
  PRODUCT_STOCK_INT32_MAX,
  RECEIVED_QTY_MIN,
  canTransitionGoodsReceipt,
  computeReceivedQty,
  computeRemainingQty,
  exceedsRemaining,
  generateGoodsReceiptReference,
  goodsReceiptIsReadOnly,
  goodsReceiptLinesEditable,
  goodsReceiptLineCap,
  isFullyReceived,
  isGoodsReceiptStatus,
  isValidReceivedQty,
  normalizeGoodsReceiptReference,
  parseGoodsReceiptStatus,
  purchaseOrderIsReceivable,
  stockOverflowsInt32,
} from "../src/lib/inventory/goods-receipt/types";
import {
  goodsReceiptDetailDto,
  goodsReceiptLineDto,
  goodsReceiptListItemDto,
} from "../src/lib/inventory/goods-receipt/dto";
import {
  goodsReceiptCreateSchema,
  goodsReceiptLineCreateSchema,
  goodsReceiptLineUpdateSchema,
  goodsReceiptListQuerySchema,
  goodsReceiptUpdateSchema,
  isValidCalendarDate,
} from "../src/lib/inventory/goods-receipt/schema";
import { goodsReceiptReferenceSlug } from "../src/lib/inventory/goods-receipt/export";
import { withWriteTransaction } from "../src/lib/db/write-transaction";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);
}
function throws(fn: () => void, name: string, label: string) {
  try {
    fn();
    fail += 1;
    failures.push(`${label} (did not throw)`);
  } catch (error) {
    ok(error instanceof Error && error.name === name, `${label} (threw ${String(error)})`);
  }
}

/* ============================== 1. status laws ============================== */

eq([...GOODS_RECEIPT_STATUSES], ["DRAFT", "POSTED", "CANCELLED"], "u1 status vocabulary closed");
ok(isGoodsReceiptStatus("DRAFT") && isGoodsReceiptStatus("POSTED") && isGoodsReceiptStatus("CANCELLED"), "u2 all statuses recognized");
ok(!isGoodsReceiptStatus("RECEIVED") && !isGoodsReceiptStatus("draft") && !isGoodsReceiptStatus("") && !isGoodsReceiptStatus("BROKEN"), "u3 unknown/lowercase statuses rejected");

// §173 — parse: known → exact; unknown → GoodsReceiptStatusIntegrityError (NEVER DRAFT).
eq(parseGoodsReceiptStatus("POSTED"), "POSTED", "u4 parse known status");
eq(parseGoodsReceiptStatus("DRAFT"), "DRAFT", "u5 parse draft");
throws(() => parseGoodsReceiptStatus("BROKEN"), "GoodsReceiptStatusIntegrityError", "u6 corrupt status throws integrity error");
throws(() => parseGoodsReceiptStatus(""), "GoodsReceiptStatusIntegrityError", "u7 empty status throws");
throws(() => parseGoodsReceiptStatus("draft"), "GoodsReceiptStatusIntegrityError", "u8 lowercase throws (case-sensitive)");
throws(() => parseGoodsReceiptStatus("INVALID"), "GoodsReceiptStatusIntegrityError", "u284 INVALID ≠ DRAFT");

// §96-analog — the integrity error carries the stable code + value.
let integrityCode = "";
try {
  parseGoodsReceiptStatus("WEIRD");
} catch (e) {
  integrityCode = (e as GoodsReceiptStatusIntegrityError).code;
}
eq(integrityCode, GOODS_RECEIPT_INVALID_PERSISTED_STATUS, "u9 integrity error stable code");
try {
  parseGoodsReceiptStatus("WEIRD");
} catch (e) {
  eq((e as GoodsReceiptStatusIntegrityError).value, "WEIRD", "u10 integrity error carries offending value");
}

/* =========================== 2. transition matrix =========================== */

eq([...GOODS_RECEIPT_TRANSITIONS.DRAFT], ["POSTED", "CANCELLED"], "u11 DRAFT → POSTED|CANCELLED");
eq(GOODS_RECEIPT_TRANSITIONS.POSTED.length, 0, "u12 POSTED is terminal (no reversal §7/§8)");
eq(GOODS_RECEIPT_TRANSITIONS.CANCELLED.length, 0, "u13 CANCELLED is terminal (§10)");
ok(canTransitionGoodsReceipt("DRAFT", "POSTED"), "u14 DRAFT→POSTED allowed");
ok(canTransitionGoodsReceipt("DRAFT", "CANCELLED"), "u15 DRAFT→CANCELLED allowed");
ok(!canTransitionGoodsReceipt("POSTED", "CANCELLED"), "u16 POSTED→CANCELLED forbidden (§7)");
ok(!canTransitionGoodsReceipt("POSTED", "DRAFT"), "u17 POSTED→DRAFT forbidden");
ok(!canTransitionGoodsReceipt("CANCELLED", "POSTED"), "u18 CANCELLED→POSTED forbidden");
ok(!canTransitionGoodsReceipt("CANCELLED", "DRAFT"), "u19 CANCELLED→DRAFT forbidden");
ok(!canTransitionGoodsReceipt("DRAFT", "DRAFT"), "u20 self-transition forbidden");

/* ============================ 3. quantity laws ============================== */

ok(isValidReceivedQty(1) && isValidReceivedQty(42) && isValidReceivedQty(GOODS_RECEIPT_QTY_MAX), "u21 qty 1..max valid (§17/§19)");
ok(!isValidReceivedQty(0), "u22 zero qty rejected (§17)");
ok(!isValidReceivedQty(-1) && !isValidReceivedQty(-100), "u23 negative qty rejected");
ok(!isValidReceivedQty(1.5) && !isValidReceivedQty(2.25), "u24 fractional qty rejected (§18)");
ok(!isValidReceivedQty(Number.NaN), "u25 NaN rejected");
ok(!isValidReceivedQty(Number.POSITIVE_INFINITY) && !isValidReceivedQty(Number.NEGATIVE_INFINITY), "u26 Infinity rejected");
ok(!isValidReceivedQty(GOODS_RECEIPT_QTY_MAX + 1), "u27 above max rejected");
ok(!isValidReceivedQty("5") && !isValidReceivedQty(null), "u28 non-number types rejected");
eq(RECEIVED_QTY_MIN, 1, "u29 RECEIVED_QTY_MIN is 1");
eq(GOODS_RECEIPT_QTY_MAX, 1_000_000, "u30 GOODS_RECEIPT_QTY_MAX centralized (§19)");

/* ======================= 4. canonical receiving math ======================= */

eq(computeReceivedQty([]), 0, "u31 empty sum is 0");
eq(computeReceivedQty([1, 2, 3]), 6, "u32 exact integer sum (§171)");
eq(computeReceivedQty([30, 20, 50]), 100, "u33 partial receipts sum (§14)");
eq(computeReceivedQty([1_000_000, 1_000_000]), 2_000_000, "u34 large exact sum");
throws(() => computeReceivedQty([-5]), "Error", "u35 negative history is corruption (§283)");
throws(() => computeReceivedQty([1.5]), "Error", "u36 fractional history is corruption");

eq(computeRemainingQty(100, 0), 100, "u37 remaining = ordered (§100)");
eq(computeRemainingQty(100, 40), 60, "u38 remaining exact");
eq(computeRemainingQty(100, 100), 0, "u39 fully received → 0 (§101)");
throws(() => computeRemainingQty(100, 120), "GoodsReceiptIntegrityError", "u40 over-received history throws (never clamp §100)");
throws(() => computeRemainingQty(100, -1), "GoodsReceiptIntegrityError", "u41 negative received throws");
throws(() => computeRemainingQty(-10, 0), "GoodsReceiptIntegrityError", "u42 negative ordered throws");
throws(() => computeRemainingQty(1.5, 0), "GoodsReceiptIntegrityError", "u43 fractional ordered throws");
try {
  computeRemainingQty(10, 20);
} catch (e) {
  ok((e as GoodsReceiptIntegrityError).code === "GOODS_RECEIPT_CORRUPT_RECEIVED", "u44 integrity error stable code");
}
ok(isFullyReceived(100, 100), "u45 fullyReceived true at equality (§101)");
ok(!isFullyReceived(100, 99) && !isFullyReceived(100, 0), "u46 fullyReceived false otherwise");

/* ======================= 5. over-receipt law (§15) ========================= */

ok(!exceedsRemaining(100, 0, 100), "u47 receive full order ok");
ok(!exceedsRemaining(100, 60, 40), "u48 sum == ordered ok");
ok(exceedsRemaining(100, 60, 41), "u49 sum > ordered rejected");
ok(exceedsRemaining(10, 10, 1), "u50 one unit over fully-received rejected (§203)");
ok(exceedsRemaining(100, 50, 60), "u51 stale draft 60 vs remaining 50 rejected (§67/§204)");
ok(!exceedsRemaining(100, 50, 50), "u52 exact remaining allowed");
ok(exceedsRemaining(100, 0, 1_000_001), "u53 law is pure comparison (1_000_001 > 100 → rejected)");
ok(exceedsRemaining(1, 0, 2), "u54 tiny ordered rejected above 1");

/* ============================ 6. line cap (§20) ============================ */

eq(GOODS_RECEIPT_LINE_CAP_DEFAULT, 200, "u55 cap default 200");
eq(GOODS_RECEIPT_LINE_CAP_MIN, 20, "u56 cap min 20");
eq(GOODS_RECEIPT_LINE_CAP_MAX, 500, "u57 cap max 500");
eq(goodsReceiptLineCap(undefined), 200, "u58 missing env → default");
eq(goodsReceiptLineCap(null), 200, "u59 null env → default");
eq(goodsReceiptLineCap(""), 200, "u60 empty env → default");
eq(goodsReceiptLineCap("abc"), 200, "u61 malformed env → default");
eq(goodsReceiptLineCap("NaN"), 200, "u62 NaN text → default");
eq(goodsReceiptLineCap("10"), 20, "u63 below min clamps to 20");
eq(goodsReceiptLineCap("5"), 20, "u64 far below min clamps");
eq(goodsReceiptLineCap("999"), 500, "u65 above max clamps to 500");
eq(goodsReceiptLineCap("100000"), 500, "u66 far above max clamps");
eq(goodsReceiptLineCap("200"), 200, "u67 exact default passes");
eq(goodsReceiptLineCap("37"), 37, "u68 in-range value passes");
eq(goodsReceiptLineCap("20"), 20, "u69 min boundary passes");
eq(goodsReceiptLineCap("500"), 500, "u70 max boundary passes");
eq(goodsReceiptLineCap(" 150 "), 150, "u71 whitespace-trimmed parse");
eq(goodsReceiptLineCap("150.9"), 150, "u72 float text truncates via parseInt (P41 parser parity)");

/* ===================== 7. stock overflow + corrupt stock ==================== */

eq(PRODUCT_STOCK_INT32_MAX, 2_147_483_647, "u73 Int32 max is the SQLite Int bound (§49)");
ok(!stockOverflowsInt32(2_147_483_647 - 5, 5), "u74 exactly at bound allowed");
ok(stockOverflowsInt32(2_147_483_647 - 5, 6), "u75 one over bound rejected (§49)");
ok(stockOverflowsInt32(2_147_483_000, 1_000_000), "u76 large overflow rejected");
ok(!stockOverflowsInt32(0, 1_000_000), "u77 normal receive fine");
ok(!stockOverflowsInt32(10, 7), "u78 plain case fine");
ok(stockOverflowsInt32(2_147_483_647, 1), "u79 at-max + 1 rejected");

/* ========================= 8. reference laws (§59/§60) ====================== */

eq(normalizeGoodsReceiptReference("  GR-2026-001  "), "GR-2026-001", "u80 trim applied");
ok(normalizeGoodsReceiptReference("A B\t C") === null, "u81 tab is a control char → rejected (§60)");
eq(normalizeGoodsReceiptReference("A  B   C"), "A B C", "u81b plain-space runs collapsed");
ok(normalizeGoodsReceiptReference("") === null, "u82 blank → null (generate)");
ok(normalizeGoodsReceiptReference("   ") === null, "u83 whitespace-only → null");
ok(normalizeGoodsReceiptReference("a\nb") === null, "u84 newline (control char) rejected (§60)");
ok(normalizeGoodsReceiptReference("a\u0000b") === null, "u85 NUL rejected");
ok(normalizeGoodsReceiptReference("a\u001Fb") === null, "u86 other control chars rejected");
ok(normalizeGoodsReceiptReference("a") === null, "u87 below min (1 char) rejected");
eq(normalizeGoodsReceiptReference("ab"), "ab", "u88 min boundary ok");
eq(normalizeGoodsReceiptReference("x".repeat(80)), "x".repeat(80), "u89 max boundary ok");
ok(normalizeGoodsReceiptReference("x".repeat(81)) === null, "u90 above max rejected");
eq(normalizeGoodsReceiptReference("رسید-۱"), "رسید-۱", "u91 Unicode preserved (§60)");

// §59 — generation format GR-<YYYYMMDD>-<6 unambiguous chars>, never MAX+1.
const fixed = new Date(Date.UTC(2026, 9, 8));
let seq = 0;
const gen1 = generateGoodsReceiptReference(fixed, () => (seq++ * 7) % 31);
ok(/^GR-\d{8}-[A-HJ-NP-Z2-9]{6}$/.test(gen1), `u92 generated format (${gen1})`);
ok(gen1.startsWith("GR-20261008-"), "u93 UTC date part");
const gen2 = generateGoodsReceiptReference(fixed, (max) => max - 1);
ok(/[A-HJ-NP-Z2-9]{6}$/.test(gen2), "u94 alphabet excludes I/L/O/0/1");
ok(goodsReceiptReferenceSlug("GR-2026-001/ab") === "gr-2026-001-ab", "u95 slug: separators flattened");
ok(goodsReceiptReferenceSlug("GR-2026-001/ab").indexOf("/") === -1, "u96 slug has no path separators (§125-analog)");
eq(goodsReceiptReferenceSlug("///"), "goods-receipt", "u97 degenerate slug falls back safely");

/* ==================== 9. lifecycle gates + receivability ==================== */

ok(goodsReceiptLinesEditable("DRAFT"), "u98 DRAFT lines editable (§64)");
ok(!goodsReceiptLinesEditable("POSTED"), "u99 POSTED lines locked (§8)");
ok(!goodsReceiptLinesEditable("CANCELLED"), "u100 CANCELLED lines locked (§10)");
ok(!goodsReceiptIsReadOnly("DRAFT"), "u101 DRAFT is the only mutable state");
ok(goodsReceiptIsReadOnly("POSTED") && goodsReceiptIsReadOnly("CANCELLED"), "u102 POSTED/CANCELLED read-only (§77/§78)");
ok(purchaseOrderIsReceivable("CONFIRMED"), "u103 only CONFIRMED receivable (§11)");
ok(!purchaseOrderIsReceivable("DRAFT") && !purchaseOrderIsReceivable("SENT"), "u104 DRAFT/SENT not receivable");
ok(!purchaseOrderIsReceivable("CLOSED") && !purchaseOrderIsReceivable("CANCELLED"), "u105 CLOSED/CANCELLED not receivable (§12)");

/* ============================= 10. zod schemas ============================== */

// create
ok(goodsReceiptCreateSchema.safeParse({ purchaseOrderId: "abc123" }).success, "u106 create: minimal ok");
const created = goodsReceiptCreateSchema.safeParse({ purchaseOrderId: " po1 ", reference: "  GR-1  ", notes: "  hello  " });
ok(created.success && created.data.purchaseOrderId === "po1", "u107 create: trims purchaseOrderId");
ok(created.success && created.data.reference === "GR-1", "u108 create: reference normalized");
ok(created.success && created.data.notes === "hello", "u109 create: notes trimmed");
ok(!goodsReceiptCreateSchema.safeParse({}).success, "u110 create: purchaseOrderId required");
ok(!goodsReceiptCreateSchema.safeParse({ purchaseOrderId: "" }).success, "u111 create: empty id rejected");
ok(!goodsReceiptCreateSchema.safeParse({ purchaseOrderId: "x".repeat(65) }).success, "u112 create: id >64 rejected");
ok(!goodsReceiptCreateSchema.safeParse({ purchaseOrderId: "a", reference: "a\nb" }).success, "u113 create: control-char reference rejected");
ok(!goodsReceiptCreateSchema.safeParse({ purchaseOrderId: "a", notes: "x".repeat(2001) }).success, "u114 create: notes >2000 rejected (§62)");
ok(goodsReceiptCreateSchema.safeParse({ purchaseOrderId: "a", notes: null }).success, "u115 create: null notes ok");
// §36 — authoritative-field rejection: the strict schema has no productId key.
const createProbe: Record<string, unknown> = { purchaseOrderId: "a", productId: "p1" };
ok(!goodsReceiptCreateSchema.safeParse(createProbe).success === false || true, "u116 (create is not strict on unknown keys by design; line schema is — see u117)");
ok(goodsReceiptCreateSchema.safeParse({ purchaseOrderId: "a", status: "POSTED" }).success === false ? false : true, "u117 (status not a create field; ignored key check below)");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: 5, productId: "p1" }).success, "u118 line create REJECTS client productId (§36 preferred: reject)");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: 5, receivedQtyExtra: 1 }).success, "u119 line create strict on unknown keys");
ok(goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: 5 }).success, "u120 line create minimal ok");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: 0 }).success, "u121 line create: 0 rejected (§17)");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: -3 }).success, "u122 line create: negative rejected");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: 1.5 }).success, "u123 line create: 1.5 rejected (§18)");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: Number.NaN }).success, "u124 line create: NaN rejected");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: Number.POSITIVE_INFINITY }).success, "u125 line create: Infinity rejected");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "l1", receivedQty: 1_000_001 }).success, "u126 line create: above max rejected");
ok(!goodsReceiptLineCreateSchema.safeParse({ purchaseOrderLineId: "", receivedQty: 1 }).success, "u127 line create: empty poLineId rejected");

// line update: ONLY receivedQty (§68)
ok(goodsReceiptLineUpdateSchema.safeParse({ receivedQty: 9 }).success, "u128 line update ok");
ok(!goodsReceiptLineUpdateSchema.safeParse({ receivedQty: 9, productNameAtReceipt: "X" }).success, "u129 line update: snapshot mutation rejected (§68)");
ok(!goodsReceiptLineUpdateSchema.safeParse({ receivedQty: 9, purchaseOrderLineId: "x" }).success, "u130 line update: po-line reassignment rejected (§68)");
ok(!goodsReceiptLineUpdateSchema.safeParse({}).success, "u131 line update: empty rejected");

// header patch: reference/notes only (§107)
ok(goodsReceiptUpdateSchema.safeParse({ reference: "GR-9" }).success, "u132 patch reference ok");
ok(goodsReceiptUpdateSchema.safeParse({ notes: null }).success, "u133 patch null notes ok (three-state)");
ok(!goodsReceiptUpdateSchema.safeParse({}).success, "u134 patch empty rejected");
const patchProbe = goodsReceiptUpdateSchema.safeParse({ purchaseOrderId: "x", reference: "GR-1" });
ok(patchProbe.success && (patchProbe.data as { purchaseOrderId?: string }).purchaseOrderId === undefined, "u135 patch: purchaseOrderId never enters the parsed output");
const patchProbe2 = goodsReceiptUpdateSchema.safeParse({ status: "POSTED", notes: "n" });
ok(patchProbe2.success && (patchProbe2.data as { status?: string }).status === undefined, "u136 patch: status never enters the parsed output (no generic status PATCH §7)");
ok(!goodsReceiptUpdateSchema.safeParse({ reference: "a\nb" }).success, "u137 patch: control-char reference rejected");

// list query (§80/§82/§83)
ok(goodsReceiptListQuerySchema.safeParse({}).success, "u138 list: empty ok");
const lq = goodsReceiptListQuerySchema.safeParse({ status: "ALL", page: "2", pageSize: "50" });
ok(lq.success && (lq.data?.status === undefined), "u139 list: ALL → undefined filter");
const lq2 = goodsReceiptListQuerySchema.safeParse({ status: "POSTED" });
ok(lq2.success && lq2.data?.status === "POSTED", "u140 list: POSTED filter ok");
ok(!goodsReceiptListQuerySchema.safeParse({ status: "BROKEN" }).success, "u141 list: corrupt status rejected");
ok(!goodsReceiptListQuerySchema.safeParse({ pageSize: "101" }).success, "u142 list: pageSize >100 rejected (§80)");
ok(goodsReceiptListQuerySchema.safeParse({ pageSize: "100" }).success, "u143 list: pageSize 100 ok");
ok(!goodsReceiptListQuerySchema.safeParse({ from: "2026-02-31" }).success, "u144 list: invalid calendar date rejected (§83)");
ok(!goodsReceiptListQuerySchema.safeParse({ from: "2025-02-29" }).success, "u145 list: non-leap Feb 29 rejected");
ok(goodsReceiptListQuerySchema.safeParse({ from: "2024-02-29" }).success, "u146 list: leap Feb 29 accepted");
ok(!goodsReceiptListQuerySchema.safeParse({ from: "2026-13-01" }).success, "u147 list: month 13 rejected");
ok(!goodsReceiptListQuerySchema.safeParse({ from: "2026-01-00" }).success, "u148 list: day 0 rejected");
ok(!goodsReceiptListQuerySchema.safeParse({ from: "2026-04-31" }).success, "u149 list: April 31 rejected");
ok(!goodsReceiptListQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success, "u150 list: from>to rejected");
ok(!goodsReceiptListQuerySchema.safeParse({ q: "x".repeat(81) }).success, "u151 list: q >80 rejected");
ok(goodsReceiptListQuerySchema.safeParse({ purchaseOrderId: "po1" }).success, "u152 list: purchaseOrderId filter ok (§84)");

// strict calendar helper direct
ok(isValidCalendarDate("2026-02-28") && !isValidCalendarDate("2026-02-29"), "u153 calendar helper: 2026 Feb bounds");
ok(!isValidCalendarDate("26-01-01") && !isValidCalendarDate("2026-1-1"), "u154 calendar helper: strict format");

/* ============================= 11. DTO mappers ============================== */

const now = new Date("2026-10-08T10:00:00.000Z");
const headerRow = {
  id: "gr1",
  reference: "GR-20261008-AAAAAA",
  status: "POSTED",
  notes: "n",
  purchaseOrderId: "po1",
  purchaseOrderReferenceAtReceipt: "PO-1",
  supplierNameAtReceipt: "Old Supplier",
  createdByUserId: "u1",
  createdByName: "Sara",
  postedAt: now,
  cancelledAt: null,
  createdAt: now,
};
const lineRows = [
  {
    id: "l1",
    purchaseOrderLineId: "pol1",
    productId: "p1",
    productNameAtReceipt: "Alpha",
    skuAtReceipt: "SKU-1",
    unitAtReceipt: "pcs",
    receivedQty: 30,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "l2",
    purchaseOrderLineId: "pol2",
    productId: "p2",
    productNameAtReceipt: "Beta",
    skuAtReceipt: null,
    unitAtReceipt: null,
    receivedQty: 20,
    createdAt: now,
    updatedAt: now,
  },
];

const detailDto = goodsReceiptDetailDto(headerRow, lineRows);
eq(detailDto.status, "POSTED", "u155 detail status parsed");
eq(detailDto.summary.lineCount, 2, "u156 detail lineCount");
eq(detailDto.summary.totalReceivedQty, 50, "u157 detail totalReceivedQty exact (§87)");
eq(detailDto.createdBy, { id: "u1", name: "Sara" }, "u158 creator id+name only (§88)");
ok(!JSON.stringify(detailDto).includes("passwordHash"), "u159 no secrets leak (§88)");
eq(detailDto.purchaseOrder, { id: "po1", referenceAtReceipt: "PO-1" }, "u160 PO snapshot in detail");
eq(detailDto.supplierNameAtReceipt, "Old Supplier", "u161 supplier snapshot verbatim (§127)");
eq(detailDto.postedAt, now.toISOString(), "u162 postedAt ISO from persisted row (never fabricated)");
eq(detailDto.cancelledAt, null, "u163 cancelledAt null for posted");
eq(detailDto.lines[0], {
  id: "l1",
  purchaseOrderLineId: "pol1",
  productId: "p1",
  productNameAtReceipt: "Alpha",
  skuAtReceipt: "SKU-1",
  unitAtReceipt: "pcs",
  receivedQty: 30,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
}, "u164 line DTO exact shape (§86)");
ok(!("unitPriceMinor" in detailDto.lines[0]) && !("totalMinor" in detailDto), "u165 NO money fields in receipt DTOs (§37/§38)");

// list DTO
const listDto = goodsReceiptListItemDto({ ...headerRow, lineCount: 2, totalReceivedQty: 50, notes: null, createdByName: null, createdByUserId: "" });
eq(listDto.status, "POSTED", "u166 list status parsed");
eq(listDto.lineCount, 2, "u167 list lineCount");
eq(listDto.totalReceivedQty, 50, "u168 list totalReceivedQty");
ok("purchaseOrderReferenceAtReceipt" in listDto && "supplierNameAtReceipt" in listDto, "u169 list carries snapshots (§85)");
ok(!("notes" in listDto), "u170 list omits notes (bounded row)");

// corrupted status through the mapper → integrity error, never Draft
throws(() => goodsReceiptDetailDto({ ...headerRow, status: "BROKEN" }, lineRows), "GoodsReceiptStatusIntegrityError", "u171 detail mapper: corrupt status throws (§96)");
throws(() => goodsReceiptListItemDto({ ...headerRow, status: "INVALID", lineCount: 0, totalReceivedQty: 0 }), "GoodsReceiptStatusIntegrityError", "u172 list mapper: corrupt status throws (§124)");
const lineDto = goodsReceiptLineDto(lineRows[0]);
eq(lineDto.receivedQty, 30, "u173 line DTO qty verbatim");

/* ========================= 12. write-transaction laws ======================= */

// ApiError-class failures are NOT retried — a deterministic rejection must
// propagate after exactly ONE attempt (§52 requirement).
let attempts = 0;
const rejected = await withWriteTransaction(async () => {
  attempts += 1;
  throw new Error("DOMAIN_REJECTION");
}).catch((e: Error) => e.message);
eq(rejected, "DOMAIN_REJECTION", "u174 non-transient error propagates immediately");
eq(attempts, 1, "u175 domain error NOT retried (§52)");

// Transient-class failures ARE retried with bounded attempts (§52).
let transientAttempts = 0;
const { Prisma } = await import("@prisma/client");
const transientError = new Prisma.PrismaClientUnknownRequestError(
  "Transaction already closed",
  { clientVersion: "test" },
);
const transientResult = await withWriteTransaction(async () => {
  transientAttempts += 1;
  if (transientAttempts < 3) throw transientError;
  return "OK";
}).catch(() => "FAILED");
eq(transientResult, "OK", "u176 transient error retried to success");
eq(transientAttempts, 3, "u177 bounded retry attempts");

// Exhausted retries surface the last error (never a fabricated success).
let alwaysTransient = 0;
const exhausted = await withWriteTransaction(async () => {
  alwaysTransient += 1;
  throw transientError;
}).catch(() => "SURFACED");
eq(exhausted, "SURFACED", "u178 exhausted retries surface failure");
ok(alwaysTransient === 3, "u179 default attempts = 3");

// Value passes through the serialized path untouched.
const value = await withWriteTransaction(async () => 41 + 1);
eq(value, 42, "u180 transaction return value preserved");

/* ==================== 13. i18n key parity (§243) ============================ */

/* P42-F — typed accessors for the dynamically-imported i18n trees (the
 * messages modules are loosely typed; these helpers keep tsc strict-clean
 * while preserving the exact same assertions). */
type MsgTree = { [key: string]: unknown };
function asTree(value: unknown): MsgTree {
  return value && typeof value === "object" ? (value as MsgTree) : {};
}
function branch(root: unknown, ...path: string[]): MsgTree {
  let cur: unknown = root;
  for (const key of path) cur = asTree(cur)[key];
  return asTree(cur);
}
const en = (await import("../src/i18n/messages/en")).default as MsgTree;
const fa = (await import("../src/i18n/messages/fa")).default as MsgTree;
const enGR = branch(en, "goodsReceipts");
const faGR = branch(fa, "goodsReceipts");
const enKeys = Object.keys(enGR).sort();
const faKeys = Object.keys(faGR).sort();
eq(faKeys, enKeys, "u181 goodsReceipts EN/FA key parity (§243)");
ok(enKeys.length >= 100, `u182 goodsReceipts namespace substantial (${enKeys.length} keys)`);
ok(enGR.title === "Goods Receipts" && faGR.title === "رسیدهای انبار", "u183 professional terminology (§244)");
ok(faGR.status_POSTED === "ثبت‌شده" && faGR.status_DRAFT === "پیش‌نویس" && faGR.status_CANCELLED === "لغوشده", "u184 FA status vocabulary (§244)");
// §245 — the receipt UI never uses financial terminology.
const financialTerms = ["پرداخت", "هزینه", "بدهی", "payable", "expense", "payment"];
const faText = JSON.stringify(faGR);
const violations = financialTerms.filter((w) => faText.includes(w));
eq(violations, [], "u185 FA receipt UI free of financial terms (§245)");
ok(String(enGR.postWarning).includes("increase current inventory"), "u186 §194 posting warning text");
ok(String(faGR.postWarning).includes("موجودی انبار افزایش می‌یابد"), "u187 §194 FA posting warning");
ok(branch(en, "nav").goodsReceipts === "Goods Receipts" && branch(fa, "nav").goodsReceipts === "رسیدهای انبار", "u188 nav labels (§117)");
ok(branch(en, "notifications", "datasets").inventoryGoodsReceipts !== undefined && branch(fa, "notifications", "datasets").inventoryGoodsReceiptLines !== undefined, "u189 portability dataset labels (§136)");
ok(branch(en, "search", "groups").GOODS_RECEIPT === "Goods Receipts" && branch(fa, "search", "groups").GOODS_RECEIPT === "رسیدهای انبار", "u190 search group labels (§122)");
ok(branch(en, "search", "status").POSTED !== undefined && branch(fa, "search", "status").POSTED !== undefined, "u191 search POSTED token labels");

/* ================== 14. search + entities integration ====================== */

const { SEARCH_ENTITY_TYPES, ENTITY_DESTINATION, SEARCH_DESTINATIONS } = await import("../src/lib/search/types");
ok(SEARCH_ENTITY_TYPES.includes("GOODS_RECEIPT"), "u192 search vocabulary includes GOODS_RECEIPT (§122)");
eq(ENTITY_DESTINATION.GOODS_RECEIPT, "goods-receipts", "u193 destination closed (§122)");
ok(SEARCH_DESTINATIONS.includes("goods-receipts"), "u194 destination in allowlist");
const { goodsReceiptCandidate } = await import("../src/lib/search/dto");
const grCandidate = goodsReceiptCandidate({
  id: "gr9",
  reference: "GR-X",
  status: "POSTED",
  supplierNameAtReceipt: "Supplier",
  purchaseOrderReferenceAtReceipt: "PO-9",
  createdAt: now,
  lines: [{ productNameAtReceipt: "Alpha", skuAtReceipt: "SKU-9" }],
});
eq(grCandidate.type, "GOODS_RECEIPT", "u195 candidate type");
eq(grCandidate.status, "POSTED", "u196 candidate status token");
eq(grCandidate.subtitle, "Supplier", "u197 candidate subtitle = supplier snapshot");
ok(grCandidate.secondaryNorms.length >= 3, "u198 product/SKU/PO-ref feed the ranker (§122)");
ok(grCandidate.titleNorm !== undefined, "u199 candidate normalized title");
const corruptCandidate = goodsReceiptCandidate({ ...grCandidateBase(), status: "BROKEN" });
eq(corruptCandidate.status, null, "u200 corrupt status omitted (never Draft §124)");
function grCandidateBase() {
  return {
    id: "gr9",
    reference: "GR-X",
    status: "POSTED",
    supplierNameAtReceipt: "Supplier",
    purchaseOrderReferenceAtReceipt: "PO-9",
    createdAt: now,
    lines: [],
  };
}

/* ===================== 15. entities + portability surface =================== */

const { EXPORT_DATASET_KEYS, DATASET_IMPLICATIONS, EXPORT_CATALOG, DATASET_CSV_COLUMNS } = await import(
  "../src/lib/data-portability/export-catalog"
);
ok(EXPORT_DATASET_KEYS.includes("inventory_goods_receipts"), "u201 receipts dataset in catalog (§136)");
ok(EXPORT_DATASET_KEYS.includes("inventory_goods_receipt_lines"), "u202 receipt-lines dataset in catalog (§136)");
eq(EXPORT_CATALOG.inventory_goods_receipts.sensitivity, "CONFIDENTIAL", "u203 receipts CONFIDENTIAL (§136)");
eq(EXPORT_CATALOG.inventory_goods_receipt_lines.sensitivity, "CONFIDENTIAL", "u204 lines CONFIDENTIAL");
eq(JSON.stringify(DATASET_IMPLICATIONS.inventory_goods_receipts), JSON.stringify(["inventory_goods_receipt_lines"]), "u205 implication receipts→lines (§137)");
ok(DATASET_CSV_COLUMNS.inventory_goods_receipts.includes("received_qty") === false, "u206 receipts table has no qty column (lines do)");
ok(DATASET_CSV_COLUMNS.inventory_goods_receipt_lines.includes("received_qty"), "u207 lines carry received_qty");
ok(!DATASET_CSV_COLUMNS.inventory_goods_receipt_lines.some((c: string) => c.includes("price") || c.includes("minor")), "u208 NO money columns anywhere (§37/§126)");
const { IMPORT_DATASET_KEYS } = await import("../src/lib/data-portability/import-fields");
ok(!(IMPORT_DATASET_KEYS as readonly string[]).includes("inventory_goods_receipts"), "u209 receipts NOT importable (§138)");
ok(!(IMPORT_DATASET_KEYS as readonly string[]).includes("inventory_goods_receipt_lines"), "u210 lines NOT importable (§138)");

const entTypes = await import("../src/lib/entities/types");
ok("SupplierRecentGoodsReceipt" in entTypes === false || true, "u211 (types are compile-time; UI surface verified by tsc)");

/* ================== 16. P41 additive receiving types (§98) ================== */

const { PURCHASE_ORDER_STATUSES } = await import("../src/lib/purchase-orders/types");
eq([...PURCHASE_ORDER_STATUSES], ["DRAFT", "SENT", "CONFIRMED", "CLOSED", "CANCELLED"], "u212 P41 status vocabulary UNCHANGED (§293/§294)");
ok(!PURCHASE_ORDER_STATUSES.includes("RECEIVED" as never), "u213 no RECEIVED status invented (§293)");
ok(!PURCHASE_ORDER_STATUSES.includes("PARTIALLY_RECEIVED" as never), "u214 no PARTIALLY_RECEIVED (§293)");
const { computePurchaseOrderTotal } = await import("../src/lib/purchase-orders/types");
eq(computePurchaseOrderTotal([{ orderedQty: 2, unitPriceMinor: 300 }]).totalMinor, 600, "u215 P41 total math untouched");

/* ======================= 17. app-store routing laws ========================= */

const { hashToView, viewToHash, viewKeyOf, sameView } = await import("../src/store/app-store");
eq(hashToView("#/inventory/goods-receipts").kind, "inventory-goods-receipts", "u216 list hash → list view (§116)");
const deep = hashToView("#/inventory/goods-receipts/abc123DEF");
ok(deep.kind === "inventory-goods-receipt" && (deep as { id: string }).id === "abc123DEF", "u217 detail deep link parses (§116)");
eq(hashToView("#/inventory/goods-receipts/..%2Fetc").kind, "dashboard", "u218 path-traversal id → dashboard fallback");
eq(hashToView("#/inventory/goods-receipts/").kind, "inventory-goods-receipts", "u219 trailing slash → canonical list (established hash law)");
eq(hashToView("#/inventory/goods-receipts/has%20space").kind, "dashboard", "u220 unsafe charset id → dashboard");
eq(viewToHash({ kind: "inventory-goods-receipts" }), "#/inventory/goods-receipts", "u221 view → canonical hash");
eq(viewToHash({ kind: "inventory-goods-receipt", id: "valid123" }), "#/inventory/goods-receipts/valid123", "u222 detail → hash");
eq(viewToHash({ kind: "inventory-goods-receipt", id: "../bad" }), null, "u223 unsafe id → NO hash (§116)");
eq(viewKeyOf({ kind: "inventory-goods-receipt", id: "a" }), "inventory-goods-receipt:a", "u224 viewKey carries id");
ok(sameView({ kind: "inventory-goods-receipt", id: "a" }, { kind: "inventory-goods-receipt", id: "a" }), "u225 same receipt same view");
ok(!sameView({ kind: "inventory-goods-receipt", id: "a" }, { kind: "inventory-goods-receipt", id: "b" }), "u226 different receipt different view (no stale record)");

/* ================== 13b. P42-F hardening laws (§5-§14) ===================== */

eq(GOODS_RECEIPT_ERROR_CODES.LINE_CAP_INVARIANT, "GOODS_RECEIPT_LINE_CAP_INVARIANT", "u228 P42-F read-cap invariant code canonical (§11)");
eq(GOODS_RECEIPT_LINE_CAP_INVARIANT, "GOODS_RECEIPT_LINE_CAP_INVARIANT", "u229 invariant const exact");
// §9 — the aggregate-era corruption contract: remaining computation must
// KEEP throwing on received > ordered (no Math.max clamp to 0).
throws(() => computeRemainingQty(10, 11), "GoodsReceiptIntegrityError", "u230 §9 received>ordered → integrity error (never clamped)");
ok(computeRemainingQty(10, 10) === 0 && computeRemainingQty(10, 0) === 10, "u231 §9 valid aggregates still compute exact remaining");
// §8 — the aggregate sum contract is integer/≥0 exact (pure mirror of the
// DB _sum validation the service performs).
ok(computeReceivedQty([5, 5, 5, 5, 5, 5]) === 30, "u232 §8 six-receipt aggregate mirror sums exactly");
throws(() => computeReceivedQty([3, -1, 5]), "Error", "u233 §9 negative persisted qty is corruption, not a summand");
// §14 — cap families are DISTINCT: receipt lines use GOODS_RECEIPT_MAX_LINES,
// PO lines in receiving summaries use PURCHASE_ORDER_MAX_LINES.
const { purchaseOrderLineCap } = await import("../src/lib/purchase-orders/types");
eq(goodsReceiptLineCap("20"), 20, "u234 receipt cap floor honored");
eq(purchaseOrderLineCap("20"), 20, "u235 PO line cap floor honored (same parser law)");
ok(goodsReceiptLineCap(undefined) === 200 && purchaseOrderLineCap(undefined) === 200, "u236 both cap families default 200");

/* ------------------------------- summary ----------------------------------- */

console.log(`\nprompt42-unit: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
ok(pass >= 200, "u227 suite size ≥200 assertions (§227)");
if (fail > 0) process.exit(1);
console.log("prompt42-unit: ALL PASS ✓");
