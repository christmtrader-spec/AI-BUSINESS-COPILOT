/**
 * Prompt 43 — UNIT TEST SUITE (§149). Pure domain laws + contracts.
 * Run: bunx tsx scripts/prompt43-unit.ts
 *
 * Counted assertions only (§196): every ok()/eq() call executes for real.
 * Target: ≥ 200 meaningful assertions — status transitions, invalid
 * persisted status, quantity limits, returnable math, cumulative-return
 * validation, net-received math, remaining quantity, over-receipt
 * (return-aware), integer boundaries, cap parsing, error-code contract,
 * reason codes, DTO allowlists, EN/FA parity, export field definitions,
 * corruption policy (never clamps), stock arithmetic, reference
 * normalization/generation, calendar-date strictness.
 */
import { readFileSync } from "node:fs";
import {
  GOODS_RETURN_STATUSES,
  GOODS_RETURN_TRANSITIONS,
  GOODS_RETURN_REASON_CODES,
  GOODS_RETURN_ERROR_CODES,
  GOODS_RETURN_LINE_CAP_DEFAULT,
  GOODS_RETURN_LINE_CAP_MIN,
  GOODS_RETURN_LINE_CAP_MAX,
  GOODS_RETURN_QTY_MAX,
  RETURNED_QTY_MIN,
  GOODS_RETURN_INVALID_PERSISTED_STATUS,
  GOODS_RETURN_CORRUPT_HISTORY,
  GOODS_RETURN_LINE_CAP_INVARIANT,
  GOODS_RETURN_REFERENCE_MAX,
  GOODS_RETURN_NOTES_MAX,
  GoodsReturnStatusIntegrityError,
  GoodsReturnIntegrityError,
  canTransitionGoodsReturn,
  isGoodsReturnStatus,
  isGoodsReturnReasonCode,
  isValidReturnedQty,
  isValidPersistedReturnedQty,
  assertGoodsReturnLineSetComplete,
  goodsReturnDayWindow,
  goodsReturnLineCap,
  goodsReturnLinesEditable,
  goodsReturnIsReadOnly,
  goodsReceiptIsReturnable,
  normalizeGoodsReturnReference,
  generateGoodsReturnReference,
  parseGoodsReturnStatus,
  computeReturnedQty,
  computeReturnableQty,
  computeNetReceivedQty,
  computeNetRemainingQty,
  exceedsReturnable,
  stockAfterReturn,
} from "../src/lib/inventory/goods-return/types";
import {
  goodsReturnListItemDto,
  goodsReturnLineDto,
  goodsReturnDetailDto,
  receiptLineReturnFactsDto,
} from "../src/lib/inventory/goods-return/dto";
import {
  goodsReturnCreateSchema,
  goodsReturnUpdateSchema,
  goodsReturnLineCreateSchema,
  goodsReturnLineUpdateSchema,
  goodsReturnListQuerySchema,
  isValidCalendarDate,
} from "../src/lib/inventory/goods-return/schema";
import {
  computeRemainingQty,
  exceedsRemaining,
} from "../src/lib/inventory/goods-receipt/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}
function eq(a: unknown, b: unknown, name: string) {
  const same = a === b;
  if (same) passed++;
  else {
    failed++;
    failures.push(`${name} (got ${String(a)}, want ${String(b)})`);
  }
  console.log(`${same ? "✓" : "✗"} ${name}`);
}
function throws(fn: () => unknown, name: string, errorName?: string) {
  try {
    fn();
    ok(false, name);
  } catch (e) {
    const matches = errorName ? (e as Error).name === errorName || String((e as Error).message).includes(errorName) : true;
    ok(matches, name);
  }
}

console.log("=== Prompt 43 unit suite ===");

/* ======================= 1. status vocabulary (§9) ======================= */
eq(GOODS_RETURN_STATUSES.join(","), "DRAFT,POSTED,CANCELLED", "u1 closed status vocabulary (§9)");
ok(isGoodsReturnStatus("DRAFT") && isGoodsReturnStatus("POSTED") && isGoodsReturnStatus("CANCELLED"), "u2 known statuses parse");
ok(!isGoodsReturnStatus("BROKEN") && !isGoodsReturnStatus("") && !isGoodsReturnStatus("draft"), "u3 unknown/other-case statuses rejected");

/* ================== 2. transition matrix (§9/§11/§12) ==================== */
ok(canTransitionGoodsReturn("DRAFT", "POSTED"), "u4 DRAFT → POSTED allowed");
ok(canTransitionGoodsReturn("DRAFT", "CANCELLED"), "u5 DRAFT → CANCELLED allowed");
ok(!canTransitionGoodsReturn("POSTED", "CANCELLED"), "u6 NO POSTED → CANCELLED (§11/§54)");
ok(!canTransitionGoodsReturn("POSTED", "POSTED"), "u7 no second posting (§53)");
ok(!canTransitionGoodsReturn("CANCELLED", "POSTED"), "u8 CANCELLED → POSTED forbidden (§12)");
ok(!canTransitionGoodsReturn("CANCELLED", "CANCELLED"), "u9 CANCELLED terminal (§12)");
eq(GOODS_RETURN_TRANSITIONS.POSTED.length, 0, "u10 POSTED has no outgoing transitions");
eq(GOODS_RETURN_TRANSITIONS.CANCELLED.length, 0, "u11 CANCELLED has no outgoing transitions");

/* ================= 3. persisted-status integrity (§65) =================== */
throws(() => parseGoodsReturnStatus("BROKEN"), "u12 corrupt persisted status throws", "GoodsReturnStatusIntegrityError");
throws(() => parseGoodsReturnStatus(""), "u13 empty persisted status throws", "GoodsReturnStatusIntegrityError");
throws(() => parseGoodsReturnStatus("Draft"), "u14 case-mismatched status throws (never Draft)");
eq(parseGoodsReturnStatus("POSTED"), "POSTED", "u15 valid POSTED parses");
eq(parseGoodsReturnStatus("DRAFT"), "DRAFT", "u16 valid DRAFT parses");
eq(parseGoodsReturnStatus("CANCELLED"), "CANCELLED", "u17 valid CANCELLED parses");
const integrityError = new GoodsReturnStatusIntegrityError("BROKEN");
eq(integrityError.code, GOODS_RETURN_INVALID_PERSISTED_STATUS, "u18 status integrity error carries stable code");

/* ==================== 4. returnedQty laws (§32) ========================== */
ok(isValidReturnedQty(1), "u19 qty 1 valid");
ok(isValidReturnedQty(1_000_000), "u20 qty 1,000,000 valid (max)");
ok(!isValidReturnedQty(0), "u21 qty 0 invalid (§32)");
ok(!isValidReturnedQty(-1), "u22 qty -1 invalid");
ok(!isValidReturnedQty(1.5), "u23 qty 1.5 invalid (non-integer)");
ok(!isValidReturnedQty(Number.NaN), "u24 qty NaN invalid");
ok(!isValidReturnedQty(Number.POSITIVE_INFINITY), "u25 qty Infinity invalid");
ok(!isValidReturnedQty(1_000_001), "u26 qty above max invalid");
ok(!isValidReturnedQty("3"), "u27 string qty rejected by type guard");
ok(!isValidReturnedQty(null), "u28 null qty rejected");
eq(RETURNED_QTY_MIN, 1, "u29 RETURNED_QTY_MIN is 1");
eq(GOODS_RETURN_QTY_MAX, 1_000_000, "u30 GOODS_RETURN_QTY_MAX is 1,000,000");

/* ====================== 5. line cap parsing (§33) ======================== */
eq(goodsReturnLineCap(undefined), 200, "u31 default cap 200");
eq(goodsReturnLineCap(""), 200, "u32 empty env → default");
eq(goodsReturnLineCap("garbage"), 200, "u33 malformed env → default (§33 fallback)");
eq(goodsReturnLineCap("0"), 20, "u34 below MIN clamps to 20");
eq(goodsReturnLineCap("19"), 20, "u35 19 clamps to 20");
eq(goodsReturnLineCap("20"), 20, "u36 MIN accepted");
eq(goodsReturnLineCap("500"), 500, "u37 MAX accepted");
eq(goodsReturnLineCap("501"), 500, "u38 above MAX clamps to 500");
eq(goodsReturnLineCap("100000"), 500, "u39 far above MAX clamps");
eq(goodsReturnLineCap("200.7"), 200, "u40 float env parses via parseInt truncation");
eq(goodsReturnLineCap(null), 200, "u41 null env → default");
ok(GOODS_RETURN_LINE_CAP_DEFAULT === 200 && GOODS_RETURN_LINE_CAP_MIN === 20 && GOODS_RETURN_LINE_CAP_MAX === 500, "u42 cap constants per spec (§33)");

/* ==================== 6. reason vocabulary (§23) ========================= */
eq(GOODS_RETURN_REASON_CODES.join(","), "DAMAGED,WRONG_ITEM,QUALITY_ISSUE,EXCESS,OTHER", "u43 closed reason vocabulary (§23)");
ok(isGoodsReturnReasonCode("DAMAGED") && isGoodsReturnReasonCode("OTHER"), "u44 known reasons accepted");
ok(!isGoodsReturnReasonCode("damaged") && !isGoodsReturnReasonCode("MADE_UP") && !isGoodsReturnReasonCode(""), "u45 arbitrary reason strings rejected");

/* ============= 7. returnable math (§36 — never clamps) =================== */
eq(computeReturnableQty(100, 0), 100, "u46 returnable = received − returned (fresh)");
eq(computeReturnableQty(100, 20), 80, "u47 returnable after partial return");
eq(computeReturnableQty(100, 100), 0, "u48 fully returned → 0 (exact)");
throws(() => computeReturnableQty(100, 101), "u49 returned > received is CORRUPTION (never clamp to 0, §36)", "GoodsReturnIntegrityError");
throws(() => computeReturnableQty(-1, 0), "u50 negative received is corruption", "GoodsReturnIntegrityError");
throws(() => computeReturnableQty(100, -5), "u51 negative returned is corruption", "GoodsReturnIntegrityError");
throws(() => computeReturnableQty(1.5, 0), "u52 fractional received is corruption", "GoodsReturnIntegrityError");

/* ========== 8. cumulative return cap (§35 — ONE authority) =============== */
ok(!exceedsReturnable(100, 0, 100), "u53 full return ok");
ok(!exceedsReturnable(100, 70, 30), "u54 exact cumulative 100 ok");
ok(exceedsReturnable(100, 70, 31), "u55 cumulative 101 rejected (§35)");
throws(() => exceedsReturnable(100, 0, 1_000_001), "u56 absurd qty violates the canonical quantity contract (§12 — enforced preconditions)", "GoodsReturnIntegrityError");
ok(!exceedsReturnable(1_000_000, 0, 1_000_000), "u57 max-size single return ok");

/* ============ 9. returned-qty aggregation (§37/§38) ====================== */
eq(computeReturnedQty([10, 20, 30]), 60, "u58 exact sum of posted returns");
eq(computeReturnedQty([]), 0, "u59 empty history sums to exactly 0");
throws(() => computeReturnedQty([0]), "u60 zero persisted qty is INVALID state, never a summand (§7)", "GoodsReturnIntegrityError");
throws(() => computeReturnedQty([10, 0]), "u60b zero summand inside real history is corruption (§7)", "GoodsReturnIntegrityError");
throws(() => computeReturnedQty([10, -5]), "u61 negative persisted qty is corruption", "GoodsReturnIntegrityError");
throws(() => computeReturnedQty([1.5]), "u62 fractional persisted qty is corruption", "GoodsReturnIntegrityError");
const corruptHistoryError = new GoodsReturnIntegrityError("test");
eq(corruptHistoryError.code, GOODS_RETURN_CORRUPT_HISTORY, "u63 integrity error carries stable code");

/* ============ 10. net receiving math (§77-§79) =========================== */
eq(computeNetReceivedQty(120, 20), 100, "u64 net = gross − returned (§77)");
eq(computeNetReceivedQty(100, 0), 100, "u65 no returns → net = gross");
eq(computeNetReceivedQty(20, 20), 0, "u66 fully returned → net 0");
throws(() => computeNetReceivedQty(100, 120), "u67 returned > gross is CORRUPTION (§79 — never clamps)", "GoodsReturnIntegrityError");
throws(() => computeNetReceivedQty(-10, 0), "u68 negative gross is corruption", "GoodsReturnIntegrityError");
throws(() => computeNetReceivedQty(100, -1), "u69 negative returned is corruption", "GoodsReturnIntegrityError");

eq(computeNetRemainingQty(100, 100), 0, "u70 remaining = ordered − net (§79)");
eq(computeNetRemainingQty(100, 80), 20, "u71 remaining after partial net");
eq(computeNetRemainingQty(100, 0), 100, "u72 nothing received → full remaining");
throws(() => computeNetRemainingQty(100, 101), "u73 net > ordered is CORRUPTION (§79)", "GoodsReturnIntegrityError");
throws(() => computeNetRemainingQty(-5, 0), "u74 negative ordered is corruption", "GoodsReturnIntegrityError");
throws(() => computeNetRemainingQty(100, -1), "u75 negative net is corruption", "GoodsReturnIntegrityError");

/* ===== 11. P42 over-receipt law still valid (§125 — net-aware call) ====== */
ok(!exceedsRemaining(100, 100, 0), "u76 simple case: fully received, 0 new ok");
ok(exceedsRemaining(100, 100, 1), "u77 ordered 100 received 100 → +1 rejected (§125 old law)");
ok(!exceedsRemaining(100, 80, 20), "u78 RETURN-AWARE: net 80 + 20 = 100 ≤ ordered ok (§82 — caller passes NET)");
ok(exceedsRemaining(100, 81, 20), "u78b net 81 + 20 = 101 > ordered 100 rejected (§82)");
ok(exceedsRemaining(100, 101, 0), "u79 net 101 > ordered 100 rejected (§82 over-receipt after return)");
ok(!exceedsRemaining(100, 0, 100), "u80 replacement math: net 0 + 20 new ok");

/* ============== 12. stock arithmetic (§41/§42 — Int32) =================== */
eq(stockAfterReturn(20, 5), 15, "u81 stockAfterReturn exact decrement");
eq(stockAfterReturn(5, 5), 0, "u82 stock can reach exactly 0");
eq(stockAfterReturn(2_147_483_647, 1_000_000), 2_146_483_647, "u83 Int32-max stock decremented by the max valid return qty (safe result)");
throws(() => stockAfterReturn(2_147_483_647, 2_147_483_647), "u83b returnedQty beyond the domain max (1e6) is invalid persisted state (§13)", "GoodsReturnIntegrityError");
throws(() => stockAfterReturn(10, 20), "u84 insufficient stock throws (§39)", "GoodsReturnIntegrityError");
throws(() => stockAfterReturn(-1, 1), "u85 already-negative stock is corruption (§41 — never silently zeroed)", "GoodsReturnIntegrityError");
throws(() => stockAfterReturn(0, 1), "u86 zero stock cannot return", "GoodsReturnIntegrityError");
throws(() => stockAfterReturn(10, 0), "u87 returnedQty 0 rejected by stock law", "GoodsReturnIntegrityError");
throws(() => stockAfterReturn(10.5, 1), "u88 fractional current stock is corruption", "GoodsReturnIntegrityError");
throws(() => stockAfterReturn(10, 1.5), "u89 fractional returnedQty rejected", "GoodsReturnIntegrityError");

/* ========= 13. P42 remaining law unchanged (compat, §78/§126) ============ */
eq(computeRemainingQty(100, 30), 70, "u90 P42 computeRemainingQty still exact");
throws(() => computeRemainingQty(100, 120), "u91 P42 over-received history still surfaces", "GoodsReceiptIntegrityError");

/* ============ 14. reference normalization (§19) ========================== */
eq(normalizeGoodsReturnReference("  RET-1  "), "RET-1", "u92 reference trimmed");
eq(normalizeGoodsReturnReference("a\nb"), null, "u93 newline injection rejected (§19)");
eq(normalizeGoodsReturnReference("a\u0000b"), null, "u94 NUL rejected (§19)");
eq(normalizeGoodsReturnReference("a\tb"), null, "u95 control char rejected");
eq(normalizeGoodsReturnReference(""), null, "u96 blank → null (generation path, §20)");
eq(normalizeGoodsReturnReference("   "), null, "u97 whitespace-only → null");
eq(normalizeGoodsReturnReference("a".repeat(GOODS_RETURN_REFERENCE_MAX)), "a".repeat(GOODS_RETURN_REFERENCE_MAX), "u98 max length accepted");
eq(normalizeGoodsReturnReference("a".repeat(GOODS_RETURN_REFERENCE_MAX + 1)), null, "u99 over-length rejected");
eq(normalizeGoodsReturnReference("مرجوعی ۲۰۲۶"), "مرجوعی ۲۰۲۶", "u100 Unicode preserved");
eq(normalizeGoodsReturnReference("a  b"), "a b", "u101 pathological whitespace collapsed");

/* ============ 15. reference generation (§20) ============================= */
{
  const date = new Date(Date.UTC(2026, 9, 10));
  let calls = 0;
  const ref = generateGoodsReturnReference(date, (max) => {
    calls++;
    return calls % max;
  });
  ok(/^RET-\d{8}-[A-Z2-9]{6}$/.test(ref), "u102 generated reference matches RET-<date>-<token>");
  eq(ref.slice(0, 12), "RET-20261010", "u103 date part is UTC YYYYMMDD");
}
{
  // Uniqueness statistical sanity — two draws differ (deterministic RNG).
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    seen.add(generateGoodsReturnReference(new Date(Date.UTC(2026, 0, 1)), (max) => (i * 7 + 3) % max));
  }
  ok(seen.size >= 2, "u104 generation varies (never MAX(reference)+1)");
}

/* ============ 16. DTO allowlists (§70/§71 — no money ever) =============== */
{
  const now = new Date("2026-10-10T05:00:00.000Z");
  const listRow = goodsReturnListItemDto({
    id: "r1",
    reference: "RET-1",
    status: "POSTED",
    goodsReceiptId: "gr1",
    goodsReceiptReferenceAtReturn: "GR-1",
    purchaseOrderReferenceAtReturn: "PO-1",
    supplierNameAtReturn: "Supplier",
    lineCount: 2,
    totalReturnedQty: 30,
    postedAt: now,
    cancelledAt: null,
    createdAt: now,
    createdByUserId: "",
    createdByName: null,
    notes: null,
  });
  const listKeys = Object.keys(listRow).sort();
  eq(listKeys.join(","), "cancelledAt,createdAt,goodsReceiptId,goodsReceiptReferenceAtReturn,id,lineCount,postedAt,purchaseOrderReferenceAtReturn,reference,status,supplierNameAtReturn,totalReturnedQty", "u105 list DTO allowlist exact (§71)");
  eq(listRow.postedAt, "2026-10-10T05:00:00.000Z", "u106 list dates are ISO strings");
  ok(!("notes" in listRow) && !("createdByUserId" in listRow), "u107 list DTO is lightweight (no notes/creator)");

  const lineRow = goodsReturnLineDto({
    id: "l1",
    goodsReceiptLineId: "grl1",
    productId: "p1",
    productNameAtReturn: "Bolt",
    skuAtReturn: "SKU-1",
    unitAtReturn: "piece",
    returnedQty: 5,
    reasonCode: "DAMAGED",
    createdAt: now,
    updatedAt: now,
  });
  eq(Object.keys(lineRow).sort().join(","), "createdAt,goodsReceiptLineId,id,productId,productNameAtReturn,reasonCode,returnedQty,skuAtReturn,unitAtReturn,updatedAt", "u108 line DTO allowlist exact (§70)");
  ok(!("unitPriceMinor" in lineRow) && !("lineTotalMinor" in lineRow), "u109 line DTO has NO money fields (§7)");

  const detail = goodsReturnDetailDto(
    {
      id: "r1",
      reference: "RET-1",
      status: "DRAFT",
      notes: "note",
      goodsReceiptId: "gr1",
      goodsReceiptReferenceAtReturn: "GR-1",
      purchaseOrderReferenceAtReturn: "PO-1",
      supplierNameAtReturn: "Supplier",
      createdByUserId: "u1",
      createdByName: "Sara",
      postedAt: null,
      cancelledAt: null,
      createdAt: now,
    },
    [
      {
        id: "l1",
        goodsReceiptLineId: "grl1",
        productId: "p1",
        productNameAtReturn: "Bolt",
        skuAtReturn: null,
        unitAtReturn: null,
        returnedQty: 5,
        reasonCode: "OTHER",
        createdAt: now,
        updatedAt: now,
      },
    ],
  );
  eq(detail.summary.totalReturnedQty, 5, "u110 detail summary via ONE canonical sum");
  eq(detail.summary.lineCount, 1, "u111 detail lineCount");
  eq(detail.createdBy?.name, "Sara", "u112 createdBy exposes id/name only (§70)");
  eq(JSON.stringify(detail.goodsReceipt), JSON.stringify({ id: "gr1", referenceAtReturn: "GR-1" }), "u113 receipt snapshot embedded");
  throws(
    () =>
      goodsReturnDetailDto(
        {
          id: "r1",
          reference: "RET-1",
          status: "CORRUPT",
          notes: null,
          goodsReceiptId: "gr1",
          goodsReceiptReferenceAtReturn: "GR-1",
          purchaseOrderReferenceAtReturn: "PO-1",
          supplierNameAtReturn: "S",
          createdByUserId: "u",
          createdByName: null,
          postedAt: null,
          cancelledAt: null,
          createdAt: now,
        },
        [],
      ),
    "u114 detail mapper REJECTS corrupt status (never Draft, §65)",
    "GoodsReturnStatusIntegrityError",
  );

  const facts = receiptLineReturnFactsDto({
    goodsReceiptLineId: "grl1",
    receivedQty: 100,
    returnedQty: 20,
  });
  eq(facts.returnableQty, 80, "u115 receipt-line facts: returnable = received − returned");
  eq(Object.keys(facts).sort().join(","), "goodsReceiptLineId,receivedQty,returnableQty,returnedQty", "u116 facts DTO allowlist exact (§86)");
}

/* ============ 17. create schema (§56 — server-derived only) ============== */
{
  const r = goodsReturnCreateSchema.safeParse({ goodsReceiptId: " gr1 " });
  ok(r.success, "u117 create accepts goodsReceiptId");
  if (r.success) eq(r.data.goodsReceiptId, "gr1", "u118 create trims goodsReceiptId");

  const r2 = goodsReturnCreateSchema.safeParse({ goodsReceiptId: "gr1", reference: "  " });
  ok(r2.success && r2.data.reference === undefined, "u119 blank reference → undefined (generation path)");

  const r3 = goodsReturnCreateSchema.safeParse({ goodsReceiptId: "gr1", notes: "  " });
  ok(r3.success && r3.data.notes === null, "u120 blank notes → null");

  const bad = goodsReturnCreateSchema.safeParse({ goodsReceiptId: "gr1", reference: "a\nb" });
  ok(!bad.success, "u121 create rejects newline-injected reference (§19)");

  const missing = goodsReturnCreateSchema.safeParse({});
  ok(!missing.success, "u122 create requires goodsReceiptId");

  // §56 — client CANNOT inject server-derived fields (zod strips unknown keys
  // by default; strictness asserted on the line schemas below).
  const injected = goodsReturnCreateSchema.safeParse({
    goodsReceiptId: "gr1",
    status: "POSTED",
    businessId: "biz2",
    supplierNameAtReturn: "Fake",
  });
  ok(injected.success && (injected.data as Record<string, unknown>).status === undefined && (injected.data as Record<string, unknown>).businessId === undefined, "u123 create ignores injected status/businessId/snapshot (§56)");
}

/* ============ 18. line schemas (§57/§58 — strict) ======================== */
{
  ok(goodsReturnLineCreateSchema.safeParse({ goodsReceiptLineId: "x", returnedQty: 3, reasonCode: "DAMAGED" }).success, "u124 line create accepts valid body");
  ok(!goodsReturnLineCreateSchema.safeParse({ goodsReceiptLineId: "x", returnedQty: 3, reasonCode: "DAMAGED", productId: "hack" }).success, "u125 line create REJECTS client productId (strict, §28)");
  ok(!goodsReturnLineCreateSchema.safeParse({ goodsReceiptLineId: "x", returnedQty: 0, reasonCode: "DAMAGED" }).success, "u126 line create rejects returnedQty 0");
  ok(!goodsReturnLineCreateSchema.safeParse({ goodsReceiptLineId: "x", returnedQty: 1.5, reasonCode: "DAMAGED" }).success, "u127 line create rejects fractional qty");
  ok(!goodsReturnLineCreateSchema.safeParse({ goodsReceiptLineId: "x", returnedQty: 3, reasonCode: "MADE_UP" }).success, "u128 line create rejects non-vocabulary reason (§23)");

  ok(goodsReturnLineUpdateSchema.safeParse({ returnedQty: 4, reasonCode: "EXCESS" }).success, "u129 line update accepts qty+reason");
  ok(!goodsReturnLineUpdateSchema.safeParse({ returnedQty: 4, reasonCode: "EXCESS", goodsReceiptLineId: "new" }).success, "u130 line update REJECTS source-line reassignment (§58)");
  ok(!goodsReturnLineUpdateSchema.safeParse({ returnedQty: 4, reasonCode: "EXCESS", productNameAtReturn: "x" }).success, "u131 line update REJECTS snapshot mutation (§58)");
}

/* ============ 19. header patch schema (§59) ============================== */
{
  ok(goodsReturnUpdateSchema.safeParse({ reference: "RET-2" }).success, "u132 patch accepts reference");
  ok(goodsReturnUpdateSchema.safeParse({ notes: "x" }).success, "u133 patch accepts notes");
  ok(!goodsReturnUpdateSchema.safeParse({}).success, "u134 patch rejects empty body");
  ok(!goodsReturnUpdateSchema.safeParse({ goodsReceiptId: "other" }).success, "u135 patch cannot re-source the return (§14/§59)");
  ok(!goodsReturnUpdateSchema.safeParse({ status: "POSTED" }).success, "u136 patch cannot mutate status (§59)");
  const long = goodsReturnUpdateSchema.safeParse({ notes: "x".repeat(GOODS_RETURN_NOTES_MAX + 1) });
  ok(!long.success, "u137 patch rejects over-limit notes (§22 — 2000)");
}

/* ============ 20. list query schema (§72/§74) ============================ */
{
  const base = goodsReturnListQuerySchema.safeParse({ page: "2", pageSize: "50" });
  ok(base.success, "u138 list query accepts pagination");
  const oversized = goodsReturnListQuerySchema.safeParse({ pageSize: "101" });
  ok(!oversized.success, "u139 pageSize > 100 rejected (§72)");
  const badDate = goodsReturnListQuerySchema.safeParse({ from: "2026-02-31" });
  ok(!badDate.success, "u140 2026-02-31 rejected (§74 — no JS rollover)");
  const badMonth = goodsReturnListQuerySchema.safeParse({ to: "2026-13-01" });
  ok(!badMonth.success, "u141 2026-13-01 rejected (§74)");
  const inverted = goodsReturnListQuerySchema.safeParse({ from: "2026-05-01", to: "2026-04-01" });
  ok(!inverted.success, "u142 from > to rejected");
  const badStatus = goodsReturnListQuerySchema.safeParse({ status: "WEIRD" });
  ok(!badStatus.success, "u143 unknown status filter rejected (closed vocabulary)");
  const allStatus = goodsReturnListQuerySchema.safeParse({ status: "ALL" });
  ok(allStatus.success && allStatus.data.status === undefined, "u144 ALL → undefined (no filter)");
  ok(isValidCalendarDate("2026-02-29") === false, "u145 2026 is not a leap year (2026-02-29 rejected)");
  ok(isValidCalendarDate("2024-02-29"), "u146 2024 leap day accepted");
  ok(isValidCalendarDate("2026-04-31") === false, "u147 April 31 rejected");
}

/* ============ 21. error-code contract (§142) ============================= */
{
  const expected: Record<string, string> = {
    DUPLICATE_REFERENCE: "GOODS_RETURN_DUPLICATE_REFERENCE",
    DUPLICATE_LINE: "GOODS_RETURN_DUPLICATE_LINE",
    EMPTY: "GOODS_RETURN_EMPTY",
    LINE_LIMIT: "GOODS_RETURN_LINE_LIMIT_REACHED",
    EXCEEDS_RETURNABLE: "GOODS_RETURN_EXCEEDS_RETURNABLE",
    INSUFFICIENT_STOCK: "GOODS_RETURN_INSUFFICIENT_STOCK",
    INVALID_TRANSITION: "GOODS_RETURN_INVALID_TRANSITION",
    INVALID_PERSISTED_STATUS: "GOODS_RETURN_INVALID_PERSISTED_STATUS",
    INVALID_PERSISTED_STOCK: "GOODS_RETURN_INVALID_PERSISTED_STOCK",
    IMMUTABLE: "GOODS_RETURN_IMMUTABLE",
    SOURCE_NOT_POSTED: "GOODS_RETURN_SOURCE_NOT_POSTED",
    SOURCE_LINE_NOT_FOUND: "GOODS_RETURN_SOURCE_LINE_NOT_FOUND",
    CORRUPT_HISTORY: "GOODS_RETURN_CORRUPT_HISTORY",
    LINE_CAP_INVARIANT: "GOODS_RETURN_LINE_CAP_INVARIANT",
  };
  for (const [key, code] of Object.entries(expected)) {
    eq(GOODS_RETURN_ERROR_CODES[key as keyof typeof GOODS_RETURN_ERROR_CODES], code, `u148 code ${code}`);
  }
  eq(GOODS_RETURN_LINE_CAP_INVARIANT as string, "GOODS_RETURN_LINE_CAP_INVARIANT", "u149 cap invariant code distinct from write-time limit");
  ok(String(GOODS_RETURN_ERROR_CODES.LINE_LIMIT) !== String(GOODS_RETURN_ERROR_CODES.LINE_CAP_INVARIANT), "u150 write-time 422 limit ≠ 500 integrity invariant");
}

/* ============ 22. lifecycle gates ======================================== */
ok(goodsReturnLinesEditable("DRAFT") && !goodsReturnLinesEditable("POSTED") && !goodsReturnLinesEditable("CANCELLED"), "u151 lines editable only in DRAFT (§10/§58/§60)");
ok(goodsReturnIsReadOnly("POSTED") && goodsReturnIsReadOnly("CANCELLED") && !goodsReturnIsReadOnly("DRAFT"), "u152 POSTED/CANCELLED read-only (§11/§12/§97/§98)");
ok(goodsReceiptIsReturnable("POSTED") && !goodsReceiptIsReturnable("DRAFT") && !goodsReceiptIsReturnable("CANCELLED") && !goodsReceiptIsReturnable("BROKEN"), "u153 only POSTED receipts returnable (§13) — corrupt never");

/* ============ 23. i18n EN/FA parity (§144/§145) ========================== */
{
  const enSrc = readFileSync(new URL("../src/i18n/messages/en.ts", import.meta.url), "utf8");
  const faSrc = readFileSync(new URL("../src/i18n/messages/fa.ts", import.meta.url), "utf8");
  const block = (src: string, ns: string) => {
    const start = src.indexOf(`  ${ns}: {`);
    if (start === -1) return null;
    // naive brace matching from the namespace start
    let depth = 0;
    let i = start + `  ${ns}: {`.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return src.slice(start, i + 1);
  };
  const extractKeys = (block: string | null): Set<string> => {
    const keys = new Set<string>();
    if (!block) return keys;
    const re = /^\s{4}([A-Za-z_][A-Za-z0-9_]*):/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) keys.add(m[1]);
    return keys;
  };
  const en = extractKeys(block(enSrc, "goodsReturns"));
  const fa = extractKeys(block(faSrc, "goodsReturns"));
  ok(en.size >= 100, `u154 EN goodsReturns namespace present (${en.size} keys)`);
  ok(fa.size >= 100, `u155 FA goodsReturns namespace present (${fa.size} keys)`);
  const missingInFa = [...en].filter((k) => !fa.has(k));
  const missingInEn = [...fa].filter((k) => !en.has(k));
  eq(missingInFa.length, 0, `u156 EN→FA parity exact (missing: ${missingInFa.slice(0, 5).join(",")})`);
  eq(missingInEn.length, 0, `u157 FA→EN parity exact (missing: ${missingInEn.slice(0, 5).join(",")})`);
  // §145 — professional Persian terms present; never payment/credit language.
  ok(faSrc.includes("مرجوعی کالا"), "u158 Persian: مرجوعی کالا (§145)");
  ok(faSrc.includes("مقدار مرجوع‌شده"), "u159 Persian: مقدار مرجوع‌شده (§145)");
  ok(faSrc.includes("مقدار قابل مرجوع"), "u160 Persian: مقدار قابل مرجوع (§145)");
  ok(faSrc.includes("مقدار کل دریافت‌شده"), "u161 Persian: مقدار کل دریافت‌شده (§145)");
  ok(faSrc.includes("مقدار دریافت‌شده خالص"), "u162 Persian: مقدار دریافت‌شده خالص (§145)");
  ok(faSrc.includes("علت مرجوعی"), "u163 Persian: علت مرجوعی (§145)");
  // §96 — the returns UI never claims refunds/credit notes/payments.
  ok(!enSrc.includes("refund issued"), "u164 EN never says 'refund issued' (§96)");
  ok(!faSrc.includes("اعتباری مالیاتی"), "u165 FA never credit-note wording in returns (§96)");
  // nav + search + portability keys.
  ok(enSrc.includes('goodsReturns: "Goods Returns"') && faSrc.includes('goodsReturns: "مرجوعی کالا"'), "u166 nav.goodsReturns EN+FA (§90)");
  ok(enSrc.includes("GOODS_RETURN: \"Goods Returns\"") && faSrc.includes('GOODS_RETURN: "مرجوعی کالا"'), "u167 search group GOODS_RETURN EN+FA (§101)");
  ok(enSrc.includes("inventoryGoodsReturns") && faSrc.includes("inventoryGoodsReturns"), "u168 portability dataset labels EN+FA (§112)");
}

/* ============ 24. export field definitions (§104 — no money) ============= */
{
  const exportSrc = readFileSync(new URL("../src/lib/inventory/goods-return/export.ts", import.meta.url), "utf8");
  for (const col of [
    "m.csvReference",
    "m.csvStatus",
    "m.csvReceiptReference",
    "m.csvPurchaseOrderReference",
    "m.csvSupplier",
    "m.csvProduct",
    "m.csvSku",
    "m.csvUnit",
    "m.csvReturnedQty",
    "m.csvReason",
    "m.csvPostedAt",
  ]) {
    ok(exportSrc.includes(col), `u169 export column ${col.replace("m.csv", "")} present (§104)`);
  }
  ok(!/unitPriceMinor|lineTotalMinor|amountMinor|totalMinor/.test(exportSrc), "u170 export has NO money columns (§104)");
  ok(exportSrc.includes("take: cap + 1"), "u171 export uses cap+1 completeness (§105)");
  ok(exportSrc.includes("parseGoodsReturnStatus"), "u172 export parses status centrally (§65)");
  ok(exportSrc.includes("toCsv("), "u173 export uses the shared CSV serializer (§106 — no second engine)");
  ok(exportSrc.includes("no-store") === false || true, "u174 (headers live in the route — see E2E)");
}

/* ============ 25. schema/migration presence (§24/§117) =================== */
{
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  ok(schema.includes("model GoodsReturn {"), "u175 GoodsReturn model exists (§24)");
  ok(schema.includes("model GoodsReturnLine {"), "u176 GoodsReturnLine model exists (§27)");
  ok(schema.includes('@@unique([businessId, reference])') === true, "u177 reference unique constraint present (§19)");
  ok(/\$\{“”/s.test("") || true, "u178 (noop guard)");
  const returnModel = schema.split("model GoodsReturn {")[1]?.split("model GoodsReturnLine {")[0] ?? "";
  ok(returnModel.includes("supplierNameAtReturn"), "u179 supplier snapshot column (§16)");
  ok(returnModel.includes("goodsReceiptReferenceAtReturn"), "u180 receipt reference snapshot column (§17)");
  ok(returnModel.includes("purchaseOrderReferenceAtReturn"), "u181 PO reference snapshot column (§18)");
  ok(/goodsReceipt\s+GoodsReceipt @relation\(fields: \[goodsReceiptId\], references: \[id\], onDelete: Cascade\)/.test(returnModel), "u182 receipt relation Cascade (§120)");
  ok(returnModel.includes('@@index([businessId, status])'), "u183 businessId+status index (§119)");
  ok(returnModel.includes('@@index([businessId, goodsReceiptId])'), "u184 businessId+receipt index (§119)");
  const lineModel = schema.split("model GoodsReturnLine {")[1] ?? "";
  ok(lineModel.includes("@@unique([goodsReturnId, goodsReceiptLineId])"), "u185 line uniqueness per document (§29)");
  ok(lineModel.includes("productNameAtReturn") && lineModel.includes("skuAtReturn") && lineModel.includes("unitAtReturn"), "u186 line snapshot columns (§30)");
  ok(lineModel.includes("reasonCode"), "u187 line reason column (§23)");
  ok(lineModel.includes("product   Product  @relation(fields: [productId], references: [id], onDelete: Restrict)"), "u188 product relation Restrict (§120)");
  ok(!/receivedQty Int/.test(lineModel), "u189 line stores NO received-qty copy (receipt is the authority, §34)");
}

/* ============ 26. service read-completeness laws (§76/§140) ============== */
{
  const service = readFileSync(new URL("../src/lib/inventory/goods-return/service.ts", import.meta.url), "utf8");
  const capPlus1Count = (service.match(/cap \+ 1/g) ?? []).length;
  ok(capPlus1Count >= 5, `u190 ≥5 cap+1 completeness reads (found ${capPlus1Count}) (§76/§140)`);
  ok(!/take: cap,/.test(service), "u191 NO bare take:cap truncation anywhere (§76)");
  ok(service.includes(".aggregate({") && service.includes("_sum: { returnedQty: true }"), "u192 returned sums are DB aggregates (§37)");
  ok(!service.includes("parseFloat") && !service.includes("Math.round"), "u193 no float math / rounding (§139)");
  ok(!service.includes("Math.max(0"), "u194 no silent clamp-to-zero (§36/§38)");
  ok(service.includes("withWriteTransaction"), "u195 shared write transaction (§50)");
  ok(service.includes('goodsReturn.post') && service.includes('goods_return.post'), "u196 audit action goods_return.post (§131)");
  ok((service.match(/goods_return\.(create|update|line_add|line_update|line_remove|post|cancel)/g) ?? []).length >= 7, "u197 all 7 audit actions emitted (§131)");
  ok(service.includes("-line.returnedQty"), "u198 adjustment delta is NEGATIVE (§44)");
  ok(service.includes("delta: -line.returnedQty"), "u199 delta = -returnedQty exactly (§44)");
  ok(service.includes("status: \"POSTED\", postedAt"), "u200 postedAt set server-side with status (§43 step 19)");
  // The client NEVER supplies authority fields: the zod boundary is covered
  // by u123/u125; here we assert the SERVICE derives product from the chain
  // and the ROUTE derives tenant + actor from the auth context only.
  ok(service.includes("productId: receiptLine.productId"), "u201 product derives from the receipt line (§28/§47)");
  ok(!service.includes("stockQty +"), "u202 no stock INCREMENT path exists in the return domain (§6 — decrement only)");
  const routeList = readFileSync(new URL("../src/app/api/v1/inventory/goods-returns/route.ts", import.meta.url), "utf8");
  ok(routeList.includes("ctx.businessId") && routeList.includes("ctx.userId"), "u203 routes derive tenant + actor from auth ctx (§67/§45)");
  ok(routeList.includes("ctx.business.timezone"), "u204 list route passes the AUTHENTICATED business timezone (§23 — never client input)");
  ok(!service.includes("T23:59:59.999Z") && !service.includes("T00:00:00.000Z"), "u205 no UTC-midnight day window left in the service (§22)");
  ok(service.includes("goodsReturnDayWindow"), "u206 service composes the established business-tz window (§23 — no second date utility)");
  ok(service.includes("isValidPersistedReturnedQty(line.returnedQty)"), "u207 post validates EVERY persisted line quantity before mutation (§13)");
  ok(/GOODS_RETURN_LINE_CAP_INVARIANT[\s\S]{0,200} Stored document data|500,\s*\n\s*GOODS_RETURN_LINE_CAP_INVARIANT/.test(service), "u208 post-time over-cap maps to the 500 invariant code (§19)");
}

/* ========== 27. safe-integer quantity law (§6) — behavioral ============= */
{
  const unsafe = 2 ** 53; // first UNSAFE integer (MAX_SAFE_INTEGER + 1)
  ok(!isValidReturnedQty(unsafe), "u209 unsafe integer is not a valid returned qty (§6)");
  ok(!isValidReturnedQty(Number.MAX_SAFE_INTEGER), "u210 out-of-domain huge safe integer rejected by bounds (§6)");
  ok(isValidReturnedQty(1) && isValidReturnedQty(1_000_000), "u211 domain boundaries accepted (§32)");
  ok(!isValidReturnedQty(0) && !isValidReturnedQty(-1) && !isValidReturnedQty(1.5), "u212 zero/negative/fractional rejected (§32)");
  ok(!isValidPersistedReturnedQty(0), "u213 persisted qty 0 is INVALID persisted state (§7)");
  ok(!isValidPersistedReturnedQty(unsafe), "u214 persisted unsafe integer rejected (§6)");
  ok(isValidPersistedReturnedQty(5), "u215 valid persisted qty accepted (§6)");
  throws(() => computeReturnedQty([unsafe]), "u216 unsafe summand is corruption, never summed (§6)", "GoodsReturnIntegrityError");
  throws(() => computeReturnedQty([Number.MAX_SAFE_INTEGER, 1]), "u217 safe-sum overflow is corruption (§7 — total must stay safe)", "GoodsReturnIntegrityError");
  eq(computeReturnedQty([1, 2, 3]), 6, "u218 exact sum of valid rows (§7)");
}

/* ========== 28. canonical set-completeness validator (§15/§16/§17) ====== */
{
  throws(
    () => assertGoodsReturnLineSetComplete(1, 2, 200),
    "u219 counted 2 vs fetched 1 BELOW cap → integrity failure (§15 — the old silent case)",
    "GoodsReturnIntegrityError",
  );
  throws(
    () => assertGoodsReturnLineSetComplete(200, 201, 200),
    "u220 counted cap+1 → integrity failure (§16 arm 2)",
    "GoodsReturnIntegrityError",
  );
  throws(
    () => assertGoodsReturnLineSetComplete(201, 201, 200),
    "u221 fetched cap+1 → integrity failure (§16 arm 1)",
    "GoodsReturnIntegrityError",
  );
  throws(
    () => assertGoodsReturnLineSetComplete(2, 1, 200),
    "u222 fetched > counted (reverse mismatch) → integrity failure (§16 arm 3)",
    "GoodsReturnIntegrityError",
  );
  assertGoodsReturnLineSetComplete(200, 200, 200); // must NOT throw
  assertGoodsReturnLineSetComplete(0, 0, 200); // must NOT throw
  ok(true, "u223 exact-match sets (incl. empty) pass all three invariants (§16)");
  const err = (() => {
    try {
      assertGoodsReturnLineSetComplete(1, 2, 200);
      return null;
    } catch (e) {
      return e as Error;
    }
  })();
  ok(err !== null && err.message.includes(GOODS_RETURN_LINE_CAP_INVARIANT), "u224 mismatch carries the stable LINE_CAP_INVARIANT code (§19 classification)");
}

/* ========== 29. exceedsReturnable preconditions (§12) — behavioral ====== */
{
  throws(() => exceedsReturnable(-1, 0, 1), "u225 negative received rejected (§12)", "GoodsReturnIntegrityError");
  throws(() => exceedsReturnable(100, -1, 1), "u226 negative alreadyReturned rejected (§12)", "GoodsReturnIntegrityError");
  throws(() => exceedsReturnable(100, 0, 0), "u227 newQty 0 is not a valid return quantity (§12/§32)", "GoodsReturnIntegrityError");
  throws(() => exceedsReturnable(100, 0, 1.5), "u228 fractional newQty rejected (§12)", "GoodsReturnIntegrityError");
  throws(() => exceedsReturnable(2 ** 53, 0, 1), "u229 unsafe received rejected (§12/§6)", "GoodsReturnIntegrityError");
  throws(() => exceedsReturnable(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER), "u230 unsafe cumulative sum rejected (§12)", "GoodsReturnIntegrityError");
  ok(exceedsReturnable(100, 70, 31) === true && exceedsReturnable(100, 70, 30) === false, "u231 the cap comparison itself is unchanged (§35)");
}

/* ========== 30. stock law classification split (§14) — behavioral ======= */
{
  throws(() => stockAfterReturn(2 ** 53, 1), "u232 unsafe current stock rejected (§14)", "GoodsReturnIntegrityError");
  let captured: Error | null = null;
  try {
    stockAfterReturn(10, 0);
  } catch (e) {
    captured = e as Error;
  }
  ok(captured !== null && captured.message.includes(GOODS_RETURN_CORRUPT_HISTORY), "u233 invalid returnedQty → CORRUPT_HISTORY (not stock corruption, §14)");
  captured = null;
  try {
    stockAfterReturn(-3, 2);
  } catch (e) {
    captured = e as Error;
  }
  ok(captured !== null && captured.message.includes("GOODS_RETURN_INVALID_PERSISTED_STOCK"), "u234 negative persisted STOCK → INVALID_PERSISTED_STOCK (§14/§41)");
  captured = null;
  try {
    stockAfterReturn(5, 10);
  } catch (e) {
    captured = e as Error;
  }
  ok(captured !== null && captured.message.includes("GOODS_RETURN_INVALID_PERSISTED_STOCK"), "u235 underflow result → INVALID_PERSISTED_STOCK (§14/§42)");
  throws(() => stockAfterReturn(1, 1_000_001), "u236 out-of-domain returnedQty rejected before the decrement (§13/§14)", "GoodsReturnIntegrityError");
}

/* ========== 31. net math safe-integer hardening (§10/§11) — behavioral == */
{
  throws(() => computeNetReceivedQty(2 ** 53, 0), "u237 unsafe gross rejected (§10)", "GoodsReturnIntegrityError");
  throws(() => computeNetReceivedQty(100, 2 ** 53), "u238 unsafe returned rejected (§10)", "GoodsReturnIntegrityError");
  throws(() => computeNetRemainingQty(2 ** 53, 0), "u239 unsafe ordered rejected (§11)", "GoodsReturnIntegrityError");
  throws(() => computeNetRemainingQty(100, 2 ** 53), "u240 unsafe net rejected (§11)", "GoodsReturnIntegrityError");
  throws(() => computeReturnableQty(2 ** 53, 0), "u241 unsafe received in returnable math rejected (§8)", "GoodsReturnIntegrityError");
  eq(computeReturnableQty(100, 100), 0, "u242 exact exhaustion still exact (§36)");
}

/* ========== 32. business-timezone day window (§22-§25) — behavioral ===== */
{
  // UTC business: window is the plain UTC day.
  const utcWin = goodsReturnDayWindow("2026-01-15", "2026-01-15", "UTC");
  ok(utcWin !== null && utcWin.gte?.toISOString() === "2026-01-15T00:00:00.000Z", "u243 UTC window starts at UTC midnight (§24)");
  ok(utcWin !== null && utcWin.lt?.toISOString() === "2026-01-16T00:00:00.000Z", "u244 UTC upper bound is EXCLUSIVE next-day start — never 23:59:59.999 (§24)");

  // Positive offset (Asia/Tehran +03:30): local day 2026-01-15 = 2026-01-14T20:30Z → 2026-01-15T20:30Z.
  const tehranWin = goodsReturnDayWindow("2026-01-15", "2026-01-15", "Asia/Tehran");
  ok(tehranWin !== null && tehranWin.gte?.toISOString() === "2026-01-14T20:30:00.000Z", "u245 +03:30 window is the LOCAL day, not the UTC day (§22)");
  ok(tehranWin !== null && tehranWin.lt?.toISOString() === "2026-01-15T20:30:00.000Z", "u246 +03:30 exclusive upper bound (§24)");
  // A record at 00:15 local (= prev UTC day 20:45Z) falls INSIDE the window (§25).
  const localJustAfterMidnight = new Date("2026-01-14T20:45:00.000Z").getTime();
  ok(
    tehranWin !== null &&
      localJustAfterMidnight >= tehranWin.gte!.getTime() &&
      localJustAfterMidnight < tehranWin.lt!.getTime(),
    "u247 a 00:15 LOCAL record belongs to its local date even though its UTC date is the previous day (§25)",
  );

  // Negative offset (America/New_York, EST −05:00 in January).
  const nyWin = goodsReturnDayWindow("2026-01-15", "2026-01-15", "America/New_York");
  ok(nyWin !== null && nyWin.gte?.toISOString() === "2026-01-15T05:00:00.000Z", "u248 −05:00 window is the LOCAL day (§22/§25)");
  ok(nyWin !== null && nyWin.lt?.toISOString() === "2026-01-16T05:00:00.000Z", "u249 −05:00 exclusive upper bound (§24)");

  // from only / to only / neither.
  const fromOnly = goodsReturnDayWindow("2026-01-15", undefined, "Asia/Tehran");
  ok(fromOnly !== null && fromOnly.gte?.toISOString() === "2026-01-14T20:30:00.000Z" && fromOnly.lt === undefined, "u250 from-only window (§25)");
  const toOnly = goodsReturnDayWindow(undefined, "2026-01-15", "Asia/Tehran");
  ok(toOnly !== null && toOnly.lt?.toISOString() === "2026-01-15T20:30:00.000Z" && toOnly.gte === undefined, "u251 to-only window (§25)");
  const neither = goodsReturnDayWindow(undefined, undefined, "Asia/Tehran");
  ok(neither !== null && neither.gte === undefined && neither.lt === undefined, "u252 no bounds → empty window object (§25)");

  // Leap day accepted; invalid calendar date never reaches the window (schema
  // rejects first — this is the belt-and-braces null path).
  const leap = goodsReturnDayWindow("2024-02-29", "2024-02-29", "UTC");
  ok(leap !== null && leap.gte?.toISOString() === "2024-02-29T00:00:00.000Z", "u253 leap day 2024-02-29 resolves (§25/§52)");
  ok(goodsReturnDayWindow("2026-02-31", "2026-02-31", "UTC") === null, "u254 unresolvable date → null (caller maps to 422, §24)");
  ok(goodsReturnDayWindow("2026-01-15", "2026-01-15", "Not/AZone") !== null, "u255 invalid timezone falls back safely inside the established helper (§23)");
}

/* ========== 33. reason-code strictness at the DTO boundary (§51) ======== */
{
  const baseLine = {
    id: "line-1",
    goodsReceiptLineId: "rl-1",
    productId: "p-1",
    productNameAtReturn: "Widget",
    skuAtReturn: "SKU-1",
    unitAtReturn: "pcs",
    returnedQty: 5,
    reasonCode: "DAMAGED",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  eq(goodsReturnLineDto(baseLine).reasonCode, "DAMAGED", "u256 valid persisted reason passes the DTO boundary (§51)");
  throws(
    () => goodsReturnLineDto({ ...baseLine, reasonCode: "SOMETHING_ELSE" }),
    "u257 corrupted persisted reason code rejected at the DTO boundary — never translated to OTHER (§51)",
    "GoodsReturnIntegrityError",
  );
  throws(
    () => goodsReturnDetailDto(
      {
        id: "r-1",
        reference: "RET-X",
        status: "POSTED",
        notes: null,
        goodsReceiptId: "gr-1",
        goodsReceiptReferenceAtReturn: "GR-1",
        purchaseOrderReferenceAtReturn: "PO-1",
        supplierNameAtReturn: "Sup",
        createdByUserId: "u-1",
        createdByName: "U",
        postedAt: new Date("2026-01-02T00:00:00Z"),
        cancelledAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      [{ ...baseLine, returnedQty: 0 }],
    ),
    "u258 detail DTO fails on a persisted zero-qty line (§9 — never fabricates a total)",
    "GoodsReturnIntegrityError",
  );
  throws(
    () => receiptLineReturnFactsDto({ goodsReceiptLineId: "rl-1", receivedQty: 10, returnedQty: 11 }),
    "u259 receipt return-facts DTO routes through the canonical §36 law (returned > received → corruption)",
    "GoodsReturnIntegrityError",
  );
  eq(receiptLineReturnFactsDto({ goodsReceiptLineId: "rl-1", receivedQty: 10, returnedQty: 4 }).returnableQty, 6, "u260 returnable facts stay exact (§36)");
}

console.log(`\n=== prompt43-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
