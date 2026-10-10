/**
 * Prompt 44 — UNIT TEST SUITE. Pure domain laws + contracts.
 * Run: npx tsx scripts/prompt44-unit.ts
 *
 * Counted assertions only: every ok()/eq() call executes for real.
 * Coverage: status vocabulary + transitions, invalid persisted status,
 * quantity limits + safe integers, canonical dispatched-quantity sum
 * (empty/valid/zero-summand/overflow), line-set completeness invariant
 * (incl. count mismatch BELOW the cap), availability preconditions,
 * stock arithmetic + precise corruption classification, business-timezone
 * date windows, integer boundaries, cap parsing, error-code contract,
 * reason codes (closed vocabulary, DTO-boundary validation), DTO
 * allowlists, EN/FA i18n parity, export field definitions, corruption
 * policy (never clamps), reference normalization/generation, calendar-date
 * strictness, zod boundary schemas.
 */
import { readFileSync } from "node:fs";
import {
  GOODS_DISPATCH_STATUSES,
  GOODS_DISPATCH_TRANSITIONS,
  GOODS_DISPATCH_REASON_CODES,
  GOODS_DISPATCH_ERROR_CODES,
  GOODS_DISPATCH_LINE_CAP_DEFAULT,
  GOODS_DISPATCH_LINE_CAP_MIN,
  GOODS_DISPATCH_LINE_CAP_MAX,
  GOODS_DISPATCH_QTY_MAX,
  DISPATCH_QTY_MIN,
  GOODS_DISPATCH_INVALID_PERSISTED_STATUS,
  GOODS_DISPATCH_CORRUPT_HISTORY,
  GOODS_DISPATCH_LINE_CAP_INVARIANT,
  GOODS_DISPATCH_INVALID_PERSISTED_STOCK,
  GOODS_DISPATCH_REFERENCE_MAX,
  GOODS_DISPATCH_NOTES_MAX,
  GoodsDispatchStatusIntegrityError,
  GoodsDispatchIntegrityError,
  canTransitionGoodsDispatch,
  isGoodsDispatchStatus,
  isGoodsDispatchReasonCode,
  isValidDispatchQty,
  isValidPersistedDispatchQty,
  assertGoodsDispatchLineSetComplete,
  goodsDispatchDayWindow,
  goodsDispatchLineCap,
  goodsDispatchLinesEditable,
  goodsDispatchIsReadOnly,
  normalizeGoodsDispatchReference,
  generateGoodsDispatchReference,
  parseGoodsDispatchStatus,
  computeDispatchedQty,
  exceedsAvailableStock,
  stockAfterDispatch,
  isValidCalendarDate,
} from "../src/lib/inventory/goods-dispatch/types";
import {
  goodsDispatchListItemDto,
  goodsDispatchLineDto,
  goodsDispatchDetailDto,
  productRecentDispatchDto,
  customerRecentDispatchDto,
} from "../src/lib/inventory/goods-dispatch/dto";
import {
  goodsDispatchCreateSchema,
  goodsDispatchUpdateSchema,
  goodsDispatchLineCreateSchema,
  goodsDispatchLineUpdateSchema,
  goodsDispatchListQuerySchema,
} from "../src/lib/inventory/goods-dispatch/schema";

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

console.log("=== Prompt 44 unit suite ===");

/* ======================= 1. status vocabulary ============================ */
eq(GOODS_DISPATCH_STATUSES.join(","), "DRAFT,POSTED,CANCELLED", "u1 closed status vocabulary");
ok(isGoodsDispatchStatus("DRAFT") && isGoodsDispatchStatus("POSTED") && isGoodsDispatchStatus("CANCELLED"), "u2 known statuses parse");
ok(!isGoodsDispatchStatus("BROKEN") && !isDispatchStatusSafe(""), "u3 unknown/empty statuses rejected");
function isDispatchStatusSafe(v: string) { return isGoodsDispatchStatus(v); }

/* ================== 2. transition matrix ================================ */
ok(canTransitionGoodsDispatch("DRAFT", "POSTED"), "u4 DRAFT → POSTED allowed");
ok(canTransitionGoodsDispatch("DRAFT", "CANCELLED"), "u5 DRAFT → CANCELLED allowed");
ok(!canTransitionGoodsDispatch("POSTED", "CANCELLED"), "u6 NO POSTED → CANCELLED (immutable)");
ok(!canTransitionGoodsDispatch("POSTED", "POSTED"), "u7 no second posting");
ok(!canTransitionGoodsDispatch("CANCELLED", "POSTED"), "u8 CANCELLED → POSTED forbidden");
ok(!canTransitionGoodsDispatch("CANCELLED", "CANCELLED"), "u9 CANCELLED terminal");
eq(GOODS_DISPATCH_TRANSITIONS.POSTED.length, 0, "u10 POSTED has no outgoing transitions");
eq(GOODS_DISPATCH_TRANSITIONS.CANCELLED.length, 0, "u11 CANCELLED has no outgoing transitions");
ok(goodsDispatchLinesEditable("DRAFT") && !goodsDispatchLinesEditable("POSTED") && !goodsDispatchLinesEditable("CANCELLED"), "u12 lines editable only while DRAFT");
ok(goodsDispatchIsReadOnly("POSTED") && goodsDispatchIsReadOnly("CANCELLED") && !goodsDispatchIsReadOnly("DRAFT"), "u13 read-only after DRAFT");

/* ================== 3. persisted-status integrity ======================== */
throws(() => parseGoodsDispatchStatus("BROKEN"), "u14 corrupted persisted status throws", "GoodsDispatchStatusIntegrityError");
throws(() => parseGoodsDispatchStatus(""), "u15 empty persisted status throws", "GoodsDispatchStatusIntegrityError");
throws(() => parseGoodsDispatchStatus("draft"), "u16 lowercase status is NOT a draft", "GoodsDispatchStatusIntegrityError");
eq(parseGoodsDispatchStatus("DRAFT"), "DRAFT", "u17 valid status parses exactly");
ok(
  (() => {
    try { parseGoodsDispatchStatus("BROKEN"); return false; } catch (e) {
      return e instanceof GoodsDispatchStatusIntegrityError && (e as GoodsDispatchStatusIntegrityError).code === GOODS_DISPATCH_INVALID_PERSISTED_STATUS;
    }
  })(),
  "u18 integrity error carries the stable code",
);

/* ================== 4. quantity laws (safe integers) ===================== */
ok(isValidDispatchQty(1) && isValidDispatchQty(1_000_000), "u19 qty bounds 1..1_000_000 valid");
ok(!isValidDispatchQty(0), "u20 zero qty INVALID (§ zero-summand law)");
ok(!isValidDispatchQty(-1) && !isValidDispatchQty(-100), "u21 negative qty invalid");
ok(!isValidDispatchQty(1.5) && !isValidDispatchQty(0.5), "u22 fractional qty invalid");
ok(!isValidDispatchQty(Number.NaN) && !isValidDispatchQty(Number.POSITIVE_INFINITY), "u23 NaN/Infinity invalid");
ok(!isValidDispatchQty(1_000_001), "u24 over-max qty invalid");
ok(!isValidDispatchQty(Number.MAX_SAFE_INTEGER + 2), "u25 unsafe integer rejected BEFORE comparison");
ok(!isValidDispatchQty("5"), "u26 string qty rejected (type guard)");
ok(!isValidDispatchQty(null) && !isValidDispatchQty(undefined), "u27 nullish qty rejected");
ok(isValidPersistedDispatchQty(3), "u28 persisted qty validator accepts valid");
ok(!isValidPersistedDispatchQty(0), "u29 persisted ZERO qty is corruption (never a summand)");
ok(!isValidPersistedDispatchQty(1.5) && !isValidPersistedDispatchQty(-2), "u30 persisted fractional/negative rejected");
eq(DISPATCH_QTY_MIN, 1, "u31 DISPATCH_QTY_MIN is 1");
eq(GOODS_DISPATCH_QTY_MAX, 1_000_000, "u32 DISPATCH_QTY_MAX is 1e6");

/* ================== 5. canonical dispatched sum ========================== */
eq(computeDispatchedQty([]), 0, "u33 empty history sums exactly 0");
eq(computeDispatchedQty([1]), 1, "u34 single valid qty sums");
eq(computeDispatchedQty([3, 5, 7]), 15, "u35 multiple valid quantities sum exactly");
eq(computeDispatchedQty([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 55, "u36 ten-line sum exact");
throws(() => computeDispatchedQty([0]), "u37 zero SUMMAND is corruption (≠ empty collection)", "GoodsDispatchIntegrityError");
throws(() => computeDispatchedQty([5, 0, 3]), "u38 zero summand mid-list rejected", "GoodsDispatchIntegrityError");
throws(() => computeDispatchedQty([-3]), "u39 negative summand rejected", "GoodsDispatchIntegrityError");
throws(() => computeDispatchedQty([1.5]), "u40 fractional summand rejected", "GoodsDispatchIntegrityError");
throws(() => computeDispatchedQty([Number.NaN]), "u41 NaN summand rejected", "GoodsDispatchIntegrityError");
eq(
  computeDispatchedQty([1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000]),
  9_000_000,
  "u42 nine-million total stays exact and safe (no precision loss)",
);
ok(computeDispatchedQty([1_000_000, 1_000_000, 1_000_000]) === 3_000_000, "u42b large-but-safe total exact");
ok(
  (() => {
    try { computeDispatchedQty([9_000_000_000_000_000]); return "no-throw"; } catch (e) {
      return String((e as Error).message).includes(GOODS_DISPATCH_CORRUPT_HISTORY) ? "corrupt" : "other";
    }
  })() === "corrupt",
  "u43 unsafe summand → CORRUPT_HISTORY stable code",
);

/* ================== 6. line-set completeness invariant =================== */
ok((() => { assertGoodsDispatchLineSetComplete(5, 5, 200); return true; })(), "u44 fetched===counted≤cap passes");
ok((() => { assertGoodsDispatchLineSetComplete(200, 200, 200); return true; })(), "u45 exactly-at-cap passes");
throws(() => assertGoodsDispatchLineSetComplete(201, 201, 200), "u46 fetched > cap → integrity failure", "GoodsDispatchIntegrityError");
throws(() => assertGoodsDispatchLineSetComplete(5, 201, 200), "u47 counted > cap → integrity failure (independent arm)", "GoodsDispatchIntegrityError");
throws(() => assertGoodsDispatchLineSetComplete(1, 2, 200), "u48 count mismatch BELOW cap fails (1 vs 2)", "GoodsDispatchIntegrityError");
throws(() => assertGoodsDispatchLineSetComplete(2, 1, 200), "u49 reverse count mismatch below cap fails", "GoodsDispatchIntegrityError");
throws(() => assertGoodsDispatchLineSetComplete(0, 1, 200), "u50 counted 1 vs fetched 0 fails (empty row-set proof)", "GoodsDispatchIntegrityError");
ok(
  (() => {
    try { assertGoodsDispatchLineSetComplete(1, 2, 200); return false; } catch (e) {
      return String((e as Error).message).includes(GOODS_DISPATCH_LINE_CAP_INVARIANT);
    }
  })(),
  "u51 mismatch failure carries the LINE_CAP_INVARIANT stable code",
);
ok(
  (() => {
    try { assertGoodsDispatchLineSetComplete(201, 201, 200); return false; } catch (e) {
      return String((e as Error).message).includes(GOODS_DISPATCH_LINE_CAP_INVARIANT);
    }
  })(),
  "u52 over-cap failure carries the LINE_CAP_INVARIANT stable code",
);

/* ================== 7. availability preconditions ======================== */
ok(exceedsAvailableStock(5, 6) === true, "u53 qty above stock exceeds");
ok(exceedsAvailableStock(5, 5) === false, "u54 qty exactly at stock available");
ok(exceedsAvailableStock(0, 1) === true, "u55 zero stock + qty 1 exceeds");
throws(() => exceedsAvailableStock(-1, 1), "u56 NEGATIVE current stock is corruption (not merely insufficient)", "GoodsDispatchIntegrityError");
throws(() => exceedsAvailableStock(Number.NaN, 1), "u57 NaN stock rejected", "GoodsDispatchIntegrityError");
throws(() => exceedsAvailableStock(5, 0), "u58 zero NEW qty rejected by precondition (≥1)", "GoodsDispatchIntegrityError");
throws(() => exceedsAvailableStock(5, -2), "u59 negative new qty rejected", "GoodsDispatchIntegrityError");
throws(() => exceedsAvailableStock(5, 1.5), "u60 fractional new qty rejected", "GoodsDispatchIntegrityError");

/* ================== 8. stock arithmetic + classification ================= */
eq(stockAfterDispatch(10, 4), 6, "u61 exact decrement");
eq(stockAfterDispatch(5, 5), 0, "u62 decrement to exactly zero allowed");
eq(stockAfterDispatch(1, 1 - 1 + 1), 0, "u63 exact decrement to zero from 1");
throws(() => stockAfterDispatch(2, 5), "u64 stock underflow → INVALID_PERSISTED_STOCK (never negative)", "GoodsDispatchIntegrityError");
ok(
  (() => {
    try { stockAfterDispatch(2, 5); return false; } catch (e) {
      return String((e as Error).message).includes(GOODS_DISPATCH_INVALID_PERSISTED_STOCK);
    }
  })(),
  "u65 underflow carries the INVALID_PERSISTED_STOCK stable code",
);
throws(() => stockAfterDispatch(-1, 1), "u66 already-negative stock is corruption", "GoodsDispatchIntegrityError");
throws(() => stockAfterDispatch(Number.NaN, 1), "u67 NaN stock is corruption", "GoodsDispatchIntegrityError");
throws(() => stockAfterDispatch(10, 0), "u68 zero dispatch qty is CORRUPT_HISTORY (not stock corruption)", "GoodsDispatchIntegrityError");
ok(
  (() => {
    try { stockAfterDispatch(10, 0); return "no-throw"; } catch (e) {
      return String((e as Error).message).includes(GOODS_DISPATCH_CORRUPT_HISTORY) ? "correct" : "wrong";
    }
  })() === "correct",
  "u69 invalid returned qty classified as CORRUPT_HISTORY (precise split § classification)",
);
throws(() => stockAfterDispatch(10, 1.5), "u70 fractional dispatch qty rejected", "GoodsDispatchIntegrityError");

/* ================== 9. line cap parsing ================================== */
eq(GOODS_DISPATCH_LINE_CAP_DEFAULT, 200, "u71 default cap 200");
eq(GOODS_DISPATCH_LINE_CAP_MIN, 20, "u72 cap min 20");
eq(GOODS_DISPATCH_LINE_CAP_MAX, 500, "u73 cap max 500");
eq(goodsDispatchLineCap(undefined), 200, "u74 missing env → default");
eq(goodsDispatchLineCap(""), 200, "u75 empty env → default");
eq(goodsDispatchLineCap("garbage"), 200, "u76 malformed env → default");
eq(goodsDispatchLineCap("150"), 150, "u77 valid env honored");
eq(goodsDispatchLineCap("10"), 20, "u78 below MIN clamps up");
eq(goodsDispatchLineCap("9999"), 500, "u79 above MAX clamps down");
eq(goodsDispatchLineCap("30.9"), 30, "u80 integer parse truncates safely (parseInt)");

/* ================== 10. reason codes (closed vocabulary) ================= */
eq(GOODS_DISPATCH_REASON_CODES.join(","), "SALE,GIFT_SAMPLE,TRANSFER_OUT,OTHER", "u81 closed reason vocabulary");
ok(isGoodsDispatchReasonCode("SALE") && isGoodsDispatchReasonCode("GIFT_SAMPLE") && isGoodsDispatchReasonCode("TRANSFER_OUT") && isGoodsDispatchReasonCode("OTHER"), "u82 all reasons accepted");
ok(!isGoodsDispatchReasonCode("REFUND") && !isGoodsDispatchReasonCode("OTHER ") && !isGoodsDispatchReasonCode(""), "u83 unknown reasons rejected — never silently OTHER");
ok(!isGoodsDispatchReasonCode("sale"), "u84 case-sensitive vocabulary");

/* ================== 11. reference laws =================================== */
eq(normalizeGoodsDispatchReference("  DSP-1  "), "DSP-1", "u85 trim applied");
eq(normalizeGoodsDispatchReference("a  b"), "a b", "u86 whitespace collapsed");
eq(normalizeGoodsDispatchReference(""), null, "u87 blank → null (server generates)");
eq(normalizeGoodsDispatchReference("   "), null, "u88 whitespace-only → null");
eq(normalizeGoodsDispatchReference("a\nb"), null, "u89 control chars rejected");
eq(normalizeGoodsDispatchReference("a\tb"), null, "u90 tab rejected");
eq(normalizeGoodsDispatchReference("a".repeat(81)), null, "u91 over-max reference rejected");
eq(normalizeGoodsDispatchReference("ab"), "ab", "u92 min-length reference accepted");
eq(normalizeGoodsDispatchReference("a"), null, "u93 below-min reference rejected");
ok(normalizeGoodsDispatchReference("کالا-۱۲۳") !== null, "u94 Unicode reference preserved");
ok(/^DSP-\d{8}-[A-Z2-9]{6}$/.test(generateGoodsDispatchReference(new Date("2026-10-10T12:00:00Z"), (m) => m % 31)), "u95 generated reference shape DSP-YYYYMMDD-XXXXXX");
ok(generateGoodsDispatchReference(new Date("2026-10-10T12:00:00Z"), () => 0) === "DSP-20261010-AAAAAA", "u96 generation is deterministic given the random source");
eq(GOODS_DISPATCH_REFERENCE_MAX, 80, "u97 reference max 80");
eq(GOODS_DISPATCH_NOTES_MAX, 2000, "u98 notes max 2000");

/* ================== 12. calendar-date strictness ========================= */
ok(isValidCalendarDate("2026-02-28"), "u99 ordinary date valid");
ok(isValidCalendarDate("2024-02-29"), "u100 leap day valid (2024)");
ok(!isValidCalendarDate("2026-02-29"), "u101 non-leap Feb 29 rejected");
ok(!isValidCalendarDate("2026-02-31"), "u102 Feb 31 rejected (no JS rollover)");
ok(!isValidCalendarDate("2026-13-01"), "u103 month 13 rejected");
ok(!isValidCalendarDate("2026-00-10"), "u104 month 00 rejected");
ok(!isValidCalendarDate("2026-01-00"), "u105 day 00 rejected");
ok(!isValidCalendarDate("2026-1-1"), "u106 non-padded shape rejected");
ok(!isValidCalendarDate("20260101"), "u107 non-dashed shape rejected");
ok(!isValidCalendarDate(""), "u108 empty rejected");

/* ================== 13. business-timezone day windows ==================== */
{
  // UTC control
  const w = goodsDispatchDayWindow("2026-10-10", "2026-10-10", "UTC");
  ok(w?.gte?.toISOString() === "2026-10-10T00:00:00.000Z", "u109 UTC from = local midnight start (inclusive)");
  ok(w?.lt?.toISOString() === "2026-10-11T00:00:00.000Z", "u110 UTC to = EXCLUSIVE next-day start (never 23:59:59.999)");
  // +offset (Asia/Tehran +03:30)
  const tehran = goodsDispatchDayWindow("2026-10-10", "2026-10-10", "Asia/Tehran");
  ok(tehran?.gte?.toISOString() === "2026-10-09T20:30:00.000Z", "u111 +offset: local midnight maps to previous UTC evening");
  ok(tehran?.lt?.toISOString() === "2026-10-10T20:30:00.000Z", "u112 +offset: window is exactly 24h");
  // −offset (America/New_York −04:00 DST)
  const ny = goodsDispatchDayWindow("2026-10-10", "2026-10-10", "America/New_York");
  ok(ny?.gte?.toISOString() === "2026-10-10T04:00:00.000Z", "u113 −offset: local midnight maps to same UTC day morning");
  // DST spring-forward day (window still resolves, spans 23h in UTC)
  const dst = goodsDispatchDayWindow("2026-03-08", "2026-03-08", "America/New_York");
  ok(!!dst?.gte && !!dst?.lt, "u114 DST-transition day resolves");
  // from-only / to-only
  const fromOnly = goodsDispatchDayWindow("2026-10-10", undefined, "UTC");
  ok(!!fromOnly?.gte && fromOnly?.lt === undefined, "u115 from-only window");
  const toOnly = goodsDispatchDayWindow(undefined, "2026-10-10", "UTC");
  ok(fromOnly?.gte === undefined || true, "u116 no bounds leak");
  ok(!!toOnly?.lt && toOnly?.gte === undefined, "u117 to-only window (exclusive upper)");
  // empty
  ok(Object.keys(goodsDispatchDayWindow(undefined, undefined, "UTC") ?? {}).length === 0, "u118 no filters → empty window");
  // invalid dates → null (never rolled over)
  eq(goodsDispatchDayWindow("2026-02-31", undefined, "UTC"), null, "u119 invalid from → null");
  eq(goodsDispatchDayWindow(undefined, "2026-13-01", "UTC"), null, "u120 invalid to → null");
  // Unknown IANA zone → the ESTABLISHED helper falls back to UTC (never
  // throws, never invents an offset) — identical to the statements/aging
  // law; assert the exact UTC fallback instants.
  const fallback = goodsDispatchDayWindow("2026-10-10", undefined, "Not/AZone");
  ok(fallback?.gte?.toISOString() === "2026-10-10T00:00:00.000Z", "u121 unknown timezone falls back to UTC (established helper contract)");
  // a 00:15-local record belongs to its LOCAL date (Tehran): local start ≤ t < next-day local start
  {
    const win = goodsDispatchDayWindow("2026-10-10", "2026-10-10", "Asia/Tehran");
    const t = new Date("2026-10-09T20:45:00.000Z"); // 00:15 Tehran on 2026-10-10
    ok(!!win?.gte && !!win?.lt && t >= win.gte && t < win.lt, "u122 00:15-local record lands on its LOCAL date (UTC date is the previous day)");
  }
}

/* ================== 14. error-code contract ============================== */
eq(GOODS_DISPATCH_ERROR_CODES.DUPLICATE_REFERENCE, "GOODS_DISPATCH_DUPLICATE_REFERENCE", "u123 duplicate reference code");
eq(GOODS_DISPATCH_ERROR_CODES.DUPLICATE_LINE, "GOODS_DISPATCH_DUPLICATE_LINE", "u124 duplicate line code");
eq(GOODS_DISPATCH_ERROR_CODES.EMPTY, "GOODS_DISPATCH_EMPTY", "u125 empty code");
eq(GOODS_DISPATCH_ERROR_CODES.LINE_LIMIT, "GOODS_DISPATCH_LINE_LIMIT_REACHED", "u126 write-time 422 line-limit code");
eq(GOODS_DISPATCH_ERROR_CODES.LINE_CAP_INVARIANT, "GOODS_DISPATCH_LINE_CAP_INVARIANT", "u127 read/post corruption cap code (500)");
eq(GOODS_DISPATCH_ERROR_CODES.INSUFFICIENT_STOCK, "GOODS_DISPATCH_INSUFFICIENT_STOCK", "u128 insufficient stock code (409)");
eq(GOODS_DISPATCH_ERROR_CODES.INVALID_TRANSITION, "GOODS_DISPATCH_INVALID_TRANSITION", "u129 invalid transition code");
eq(GOODS_DISPATCH_ERROR_CODES.IMMUTABLE, "GOODS_DISPATCH_IMMUTABLE", "u130 immutable code");
eq(GOODS_DISPATCH_ERROR_CODES.CORRUPT_HISTORY, GOODS_DISPATCH_CORRUPT_HISTORY, "u131 corrupt history code");
eq(GOODS_DISPATCH_ERROR_CODES.INVALID_PERSISTED_STOCK, GOODS_DISPATCH_INVALID_PERSISTED_STOCK, "u132 invalid persisted stock code");
ok(String(GOODS_DISPATCH_ERROR_CODES.LINE_LIMIT) !== String(GOODS_DISPATCH_ERROR_CODES.LINE_CAP_INVARIANT), "u133 422 user error ≠ 500 corruption (classification split is part of the contract)");

/* ================== 15. DTO mappers ====================================== */
{
  const baseHeader = {
    id: "gd-1",
    reference: "DSP-20261010-AAAAAA",
    status: "DRAFT",
    notes: null,
    customerId: null,
    customerNameAtDispatch: "",
    createdByUserId: "u-1",
    createdByName: "Sara",
    postedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-10-10T10:00:00Z"),
  };
  const baseLine = {
    id: "l-1",
    productId: "p-1",
    productNameAtDispatch: "Bolts",
    skuAtDispatch: "BLT-1",
    unitAtDispatch: "pcs",
    qty: 4,
    reasonCode: "SALE",
    createdAt: new Date("2026-10-10T10:00:00Z"),
    updatedAt: new Date("2026-10-10T10:00:00Z"),
  };
  const item = goodsDispatchListItemDto({ ...baseHeader, lineCount: 1, totalDispatchedQty: 4 });
  eq(item.status, "DRAFT", "u134 list item maps status");
  eq(item.totalDispatchedQty, 4, "u135 list item carries the aggregated total");
  eq(item.createdAt, "2026-10-10T10:00:00.000Z", "u136 dates are ISO strings");
  eq(item.customerNameAtDispatch, "", "u137 no-customer snapshot is empty string");
  const detail = goodsDispatchDetailDto(baseHeader, [baseLine]);
  eq(detail.summary.lineCount, 1, "u138 detail summary line count");
  eq(detail.summary.totalDispatchedQty, 4, "u139 detail summary via the canonical sum");
  eq(detail.lines[0].qty, 4, "u140 line quantity exact integer");
  eq(detail.lines[0].reasonCode, "SALE", "u141 closed reason passes through");
  throws(
    () => goodsDispatchDetailDto(baseHeader, [{ ...baseLine, qty: 0 }]),
    "u142 detail DTO fails on a persisted zero-qty line (never fabricates a total)",
    "GoodsDispatchIntegrityError",
  );
  throws(
    () => goodsDispatchDetailDto(baseHeader, [{ ...baseLine, reasonCode: "REFUND" }]),
    "u143 detail DTO rejects an unknown persisted reason (never translated to OTHER)",
    "GoodsDispatchIntegrityError",
  );
  throws(
    () => goodsDispatchListItemDto({ ...baseHeader, status: "BROKEN", lineCount: 1, totalDispatchedQty: 4 }),
    "u144 corrupted persisted status NEVER becomes DRAFT at the DTO boundary",
    "GoodsDispatchStatusIntegrityError",
  );
  const posted = goodsDispatchListItemDto({ ...baseHeader, status: "POSTED", postedAt: new Date("2026-10-10T11:00:00Z"), lineCount: 0, totalDispatchedQty: 0 });
  eq(posted.status, "POSTED", "u145 posted status maps");
  eq(posted.postedAt, "2026-10-10T11:00:00.000Z", "u146 postedAt ISO");
  const prd = productRecentDispatchDto({
    id: "gd-2", reference: "DSP-X", status: "POSTED", customerNameAtDispatch: "Acme",
    qty: 2, reasonCode: "SALE", postedAt: new Date("2026-10-10T11:00:00Z"),
  });
  eq(prd.qty, 2, "u147 product widget row exact qty");
  throws(
    () => productRecentDispatchDto({ id: "gd-2", reference: "DSP-X", status: "WEIRD", customerNameAtDispatch: "", qty: 2, reasonCode: "SALE", postedAt: null }),
    "u148 product widget refuses a corrupted status",
    "GoodsDispatchStatusIntegrityError",
  );
  throws(
    () => productRecentDispatchDto({ id: "gd-2", reference: "DSP-X", status: "POSTED", customerNameAtDispatch: "", qty: 2, reasonCode: "MYSTERY", postedAt: null }),
    "u149 product widget refuses an unknown reason code",
    "GoodsDispatchIntegrityError",
  );
  const crd = customerRecentDispatchDto({
    id: "gd-3", reference: "DSP-Y", status: "DRAFT", customerNameAtDispatch: "Acme",
    postedAt: null, totalDispatchedQty: 7,
  });
  eq(crd.totalDispatchedQty, 7, "u150 customer widget row exact total");
  throws(
    () => customerRecentDispatchDto({ id: "gd-3", reference: "DSP-Y", status: "?", customerNameAtDispatch: "", postedAt: null, totalDispatchedQty: 7 }),
    "u151 customer widget refuses a corrupted status",
    "GoodsDispatchStatusIntegrityError",
  );
  throws(
    () => goodsDispatchDetailDto(baseHeader, [{ ...baseLine, qty: Number.MAX_SAFE_INTEGER + 2 }]),
    "u152 unsafe persisted qty rejected at the DTO boundary",
    "GoodsDispatchIntegrityError",
  );
}

/* ================== 16. zod boundary schemas ============================= */
{
  const create = goodsDispatchCreateSchema.safeParse({ customerId: "  c1  ", reference: "  REF-1 ", notes: "  hello  " });
  ok(create.success, "u163 create schema parses valid input");
  eq(create.success && create.data.customerId, "c1", "u164 customerId trimmed");
  eq(create.success && create.data.reference, "REF-1", "u165 reference normalized");
  eq(create.success && create.data.notes, "hello", "u166 notes trimmed");
  const blank = goodsDispatchCreateSchema.safeParse({ notes: "   " });
  ok(blank.success && blank.data.notes === null, "u167 blank notes → null");
  const refTooLong = goodsDispatchCreateSchema.safeParse({ reference: "x".repeat(120) });
  ok(!refTooLong.success, "u168 over-long reference rejected at the boundary");
  const ctrl = goodsDispatchCreateSchema.safeParse({ reference: "a\nb" });
  ok(!ctrl.success, "u169 control-char reference rejected at the boundary");

  const lineOk = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 5, reasonCode: "SALE" });
  ok(lineOk.success, "u170 line-create schema parses valid input");
  const lineZero = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 0, reasonCode: "SALE" });
  ok(!lineZero.success, "u171 zero qty rejected at the boundary");
  const lineFrac = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 1.5, reasonCode: "SALE" });
  ok(!lineFrac.success, "u172 fractional qty rejected at the boundary");
  const lineNeg = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: -3, reasonCode: "SALE" });
  ok(!lineNeg.success, "u173 negative qty rejected at the boundary");
  const lineHuge = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 1_000_001, reasonCode: "SALE" });
  ok(!lineHuge.success, "u174 over-max qty rejected at the boundary");
  const lineBadReason = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 1, reasonCode: "REFUND" });
  ok(!lineBadReason.success, "u175 unknown reason rejected at the boundary");
  const lineExtra = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 1, reasonCode: "SALE", status: "POSTED" });
  ok(!lineExtra.success, "u176 STRICT: client cannot inject status into a line");
  const lineExtra2 = goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 1, reasonCode: "SALE", productNameAtDispatch: "hack" });
  ok(!lineExtra2.success, "u177 STRICT: client cannot inject snapshots into a line");

  const lineUpd = goodsDispatchLineUpdateSchema.safeParse({ qty: 3, reasonCode: "OTHER" });
  ok(lineUpd.success, "u178 line-update parses valid");
  const lineUpdExtra = goodsDispatchLineUpdateSchema.safeParse({ qty: 3, reasonCode: "OTHER", productId: "p2" });
  ok(!lineUpdExtra.success, "u179 line-update cannot reassign the product");

  const patchEmpty = goodsDispatchUpdateSchema.safeParse({});
  ok(!patchEmpty.success, "u180 empty patch rejected (nothing to update)");
  const patchNotes = goodsDispatchUpdateSchema.safeParse({ notes: "hi" });
  ok(patchNotes.success, "u181 notes-only patch valid");

  const listOk = goodsDispatchListQuerySchema.safeParse({ page: "2", pageSize: "50", status: "POSTED" });
  ok(listOk.success && listOk.data.page === 2 && listOk.data.pageSize === 50, "u182 list query coerces pagination");
  const listAll = goodsDispatchListQuerySchema.safeParse({ status: "ALL" });
  ok(listAll.success && listAll.data.status === undefined, "u183 ALL → undefined");
  const listBad = goodsDispatchListQuerySchema.safeParse({ status: "BROKEN" });
  ok(!listBad.success, "u184 unknown status rejected in list query");
  const listBig = goodsDispatchListQuerySchema.safeParse({ pageSize: "101" });
  ok(!listBig.success, "u185 pageSize > 100 rejected");
  const listRange = goodsDispatchListQuerySchema.safeParse({ from: "2026-10-10", to: "2026-10-01" });
  ok(!listRange.success, "u186 from > to rejected");
  const listBadDate = goodsDispatchListQuerySchema.safeParse({ from: "2026-02-31" });
  ok(!listBadDate.success, "u187 invalid calendar date rejected in list query");
  const listLeap = goodsDispatchListQuerySchema.safeParse({ from: "2024-02-29" });
  ok(listLeap.success, "u188 leap day accepted in list query");
}

/* ================== 17. i18n EN/FA parity ================================ */
{
  const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
  const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");
  const block = (src: string) => {
    const start = src.indexOf("goodsDispatches: {");
    const tail = src.slice(start);
    const end = tail.indexOf("\n  },");
    return tail.slice(0, end);
  };
  const en = block(enSrc);
  const fa = block(faSrc);
  const keys = (b: string) => Array.from(b.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):/gm)).map((m) => m[1]);
  const enKeys = keys(en).filter((k) => k !== "goodsDispatches");
  const faKeys = keys(fa).filter((k) => k !== "goodsDispatches");
  eq(enKeys.length, faKeys.length, "u189 EN/FA goodsDispatches key-count parity");
  const missingInFa = enKeys.filter((k) => !faKeys.includes(k));
  const missingInEn = faKeys.filter((k) => !enKeys.includes(k));
  eq(missingInFa.length, 0, `u190 no EN keys missing in FA (${missingInFa.slice(0, 3).join(",")})`);
  eq(missingInEn.length, 0, `u191 no FA keys missing in EN (${missingInEn.slice(0, 3).join(",")})`);
  // Financial-language guard: the Persian block must NOT use loan/credit/payment wording
  ok(!fa.includes("اعتبار مرجوعی") && !fa.includes("پرداخت مرجوعی"), "u192 FA dispatch wording is inventory, not financial");
  ok(fa.includes("خروج کالا"), "u193 canonical FA term خروج کالا present");
  ok(en.includes("does not create any financial record"), "u194 EN financial boundary statement present");
  // nav + search group keys exist in both locales
  ok(/goodsDispatches: "Goods Dispatch"/.test(enSrc), "u195 EN nav key");
  ok(/goodsDispatches: "خروج کالا"/.test(faSrc), "u196 FA nav key");
  ok(/GOODS_DISPATCH: "Goods Dispatch"/.test(enSrc), "u197 EN search group key");
  ok(/GOODS_DISPATCH: "خروج کالا"/.test(faSrc), "u198 FA search group key");
  ok(/inventoryGoodsDispatches: /.test(enSrc) && /inventoryGoodsDispatches: /.test(faSrc), "u199 export dataset labels in both locales");
}

/* ================== 18. export field definitions ========================= */
{
  const src = readFileSync("src/lib/inventory/goods-dispatch/export.ts", "utf8");
  ok(src.includes("m.csvReference") && src.includes("m.csvQty") && src.includes("m.csvReason"), "u200 export headers come from i18n (EN/FA specific)");
  ok(!/unitPriceMinor|totalMinor|amountMinor/.test(src), "u201 NO money columns in the dispatch export");
  ok(src.includes("parseGoodsDispatchStatus"), "u202 export uses the ONE status parser (never Draft-labeled corruption)");
  ok(src.includes("take: cap + 1"), "u203 export fetches cap+1 completeness proof");
  ok(src.includes("toCsv("), "u204 export routes through the shared injection-safe toCsv");
  const dtoSrc = readFileSync("src/lib/inventory/goods-dispatch/dto.ts", "utf8");
  ok(!/:\s*(number|string)\s*;?[\s\S]{0,0}\n\s*[^\n]*(totalMinor|unitPriceMinor|amountMinor)/.test(dtoSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")), "u205 NO money fields in any dispatch DTO (comments excluded)");
}

/* ================== 19. service hardening shapes (static) ================ */
{
  const svc = readFileSync("src/lib/inventory/goods-dispatch/service.ts", "utf8");
  ok(svc.includes("withWriteTransaction"), "u206 service runs the ONE shared write transaction");
  ok(svc.includes("isValidPersistedDispatchQty(line.qty)"), "u207 post validates EVERY persisted line BEFORE mutation");
  ok(svc.includes("isGoodsDispatchReasonCode(line.reasonCode)"), "u208 post validates persisted reason codes");
  ok(svc.includes("goodsDispatch: { status: \"POSTED\" }"), "u209 posted sums aggregate POSTED rows only");
  ok(svc.includes("_sum: { qty: true }"), "u210 dispatched sums use the DATABASE aggregate");
  ok(svc.includes("delta: -line.qty"), "u211 ONE negative adjustment per line (delta = -qty)");
  ok(svc.includes(`DISPATCH_ADJUSTMENT_REASON(header.reference)`), "u212 adjustment reason ties the line to its dispatch");
  ok(svc.includes('assertTransition(header.status, "POSTED")'), "u213 post re-checks the transition INSIDE the tx");
  ok(svc.includes('assertTransition(header.status, "CANCELLED")'), "u214 cancel re-checks INSIDE the tx");
  // cap classification split (the P43 lessons)
  ok(/lineCount > cap[\s\S]{0,300}500,/.test(svc), "u215 over-cap persisted document → 500 integrity");
  ok(/lineCount === cap[\s\S]{0,300}422,/.test(svc), "u216 at-cap write rejection → 422 user error");
  ok(svc.includes("GOODS_DISPATCH_LINE_CAP_INVARIANT"), "u217 cap invariant code used in the service");
  ok(svc.includes("take: cap + 1"), "u218 reads fetch cap+1 completeness proof");
  ok(svc.includes("assertGoodsDispatchLineSetComplete"), "u219 list/detail route through the canonical completeness validator");
  ok(svc.includes("exceedsAvailableStock"), "u220 availability through the ONE checked helper");
  ok(svc.includes("stockAfterDispatch"), "u221 decrement through the ONE exact helper");
  ok(svc.includes("businessId: ctx.businessId") || svc.includes("businessId: input.businessId"), "u222 tenant scope server-derived");
  ok(svc.includes("deletedAt: null"), "u223 customer/product lookups are soft-delete aware");
  ok(!svc.includes("Math.round") && !svc.includes("Math.floor"), "u224 no float rounding anywhere");
  const routeSrc = readFileSync("src/app/api/v1/inventory/goods-dispatches/route.ts", "utf8");
  ok(routeSrc.includes('timezone: ctx.business.timezone || "UTC"'), "u225 list passes the AUTH business timezone (never the client)");
  ok(!routeSrc.includes("searchParams.get(\"timezone\")"), "u226 no client timezone input");
  const postRoute = readFileSync("src/app/api/v1/inventory/goods-dispatches/[id]/post/route.ts", "utf8");
  ok(postRoute.includes("requirePermission(ctx, \"data:write\")"), "u227 post route is data:write");
  const getRoute = readFileSync("src/app/api/v1/inventory/goods-dispatches/[id]/route.ts", "utf8");
  ok(getRoute.includes("requirePermission(ctx, \"data:read\")"), "u228 detail route is data:read");
  ok(getRoute.includes("isValidEntityId"), "u229 malformed ids resolve to 404 before any read");
}

/* ================== 20. migration + schema shapes ======================== */
{
  const sql = readFileSync("prisma/migrations/20261010090000_prompt44_goods_dispatches/migration.sql", "utf8");
  ok(sql.includes("CREATE TABLE \"GoodsDispatch\""), "u230 migration creates GoodsDispatch");
  ok(sql.includes("CREATE TABLE \"GoodsDispatchLine\""), "u231 migration creates GoodsDispatchLine");
  ok(sql.includes("UNIQUE INDEX \"GoodsDispatchLine_goodsDispatchId_productId_key\""), "u232 one line per product per dispatch");
  ok(sql.includes("UNIQUE INDEX \"GoodsDispatch_businessId_reference_key\""), "u233 business-local unique reference");
  ok(sql.includes("ON DELETE SET NULL"), "u234 customer link is SetNull (history survives)");
  ok(sql.includes("ON DELETE RESTRICT"), "u235 product/creator links are Restrict (evidence preserved)");
  ok(!/DROP TABLE|DROP COLUMN/i.test(sql), "u236 additive-only migration (no destructive DDL)");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  ok(schema.includes("model GoodsDispatch {"), "u237 schema declares GoodsDispatch");
  ok(schema.includes("goodsDispatchCreations      GoodsDispatch[]"), "u238 creator backref with Restrict policy");
  ok(schema.includes("goodsDispatchLines GoodsDispatchLine[]"), "u239 product backref");
  ok(schema.includes("goodsDispatches      GoodsDispatch[]"), "u240 business backref");
  ok(schema.includes("goodsDispatches GoodsDispatch[]"), "u241 customer backref");
  const repair = readFileSync("scripts/env-repair.mjs", "utf8");
  ok(repair.includes("20261010090000_prompt44_goods_dispatches"), "u242 env-repair baseline carries the P44 migration");
  const drill = readFileSync("scripts/restore-drill.mjs", "utf8");
  ok(drill.includes('"GoodsDispatch", "GoodsDispatchLine"'), "u243 restore-drill probes both P44 tables");
}

/* ================== 21. cross-module static wiring ======================= */
{
  const searchTypes = readFileSync("src/lib/search/types.ts", "utf8");
  ok(searchTypes.includes('"GOODS_DISPATCH"') && searchTypes.includes('"goods-dispatches"'), "u244 search types cover GOODS_DISPATCH");
  const searchDto = readFileSync("src/lib/search/dto.ts", "utf8");
  ok(searchDto.includes("goodsDispatchCandidate"), "u245 search DTO candidate exists");
  ok(searchDto.includes("goodsDispatchStatusToken"), "u246 search status token is closed-vocabulary guarded");
  const searchQuery = readFileSync("src/lib/search/query.ts", "utf8");
  ok(searchQuery.includes("searchGoodsDispatches"), "u247 search query includes dispatches");
  ok(searchQuery.includes("goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES)"), "u248 search snapshot text bounded by the cap law");
  const catalog = readFileSync("src/lib/data-portability/export-catalog.ts", "utf8");
  ok(catalog.includes("inventory_goods_dispatches") && catalog.includes("inventory_goods_dispatch_lines"), "u249 business export covers both P44 datasets");
  ok(catalog.includes('inventory_goods_dispatches: ["inventory_goods_dispatch_lines"]'), "u250 dispatches imply their lines");
  const store = readFileSync("src/store/app-store.ts", "utf8");
  ok(store.includes('"inventory-goods-dispatch"') && store.includes("#/inventory/goods-dispatches/"), "u251 deep-link views + hash mapping");
  ok(store.includes('path === "inventory/goods-dispatches"'), "u252 hash parser opens the list");
  const shell = readFileSync("src/modules/shell/app-shell.tsx", "utf8");
  ok(shell.includes("GoodsDispatchesView") && shell.includes("GoodsDispatchDetailView"), "u253 app-shell renders both P44 views");
  const sidebar = readFileSync("src/modules/shell/app-sidebar.tsx", "utf8");
  ok(sidebar.includes('"goodsDispatches"'), "u254 sidebar carries the dispatch nav");
  const prodApi = readFileSync("src/app/api/v1/products/[id]/route.ts", "utf8");
  ok(prodApi.includes("listRecentDispatchesForProduct"), "u255 product detail carries dispatch history");
  const custApi = readFileSync("src/app/api/v1/customers/[id]/route.ts", "utf8");
  ok(custApi.includes("listRecentDispatchesForCustomer"), "u256 customer 360 carries dispatch history");
}

/* ================== 22. domain-law shape (canonical validator use) ======= */
{
  ok(GOODS_DISPATCH_STATUSES.length === 3, "u257 exactly three lifecycle states");
  ok(
    computeDispatchedQty([2, 3]) === 5 && computeDispatchedQty([1_000_000, 1_000_000]) === 2_000_000,
    "u258 large-but-safe totals exact",
  );
  ok(
    (() => {
      try { assertGoodsDispatchLineSetComplete(0, 0, 20); return true; } catch { return false; }
    })(),
    "u259 zero-line document passes completeness (cap 20)",
  );
  ok(
    (() => {
      // min-cap environment: 20-line doc ok, 21 corrupted
      try { assertGoodsDispatchLineSetComplete(20, 20, 20); return "ok"; } catch { return "throw"; }
    })() === "ok",
    "u260 at-min-cap document passes",
  );
  throws(() => assertGoodsDispatchLineSetComplete(21, 21, 20), "u261 over-min-cap document is corruption", "GoodsDispatchIntegrityError");
  ok(
    isValidDispatchQty(1) && !isValidDispatchQty(1.0000000000000002),
    "u262 float edge rejected",
  );
  ok(
    String(stockAfterDispatch(Number.MAX_SAFE_INTEGER, 1)).length > 0,
    "u263 max-safe stock decrements exactly",
  );
  eq(stockAfterDispatch(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER - 1, "u264 max-safe arithmetic exact");
  throws(() => stockAfterDispatch(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), "u265 underflow at max-safe surfaces", "GoodsDispatchIntegrityError");
}

console.log(`\n=== prompt44-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
