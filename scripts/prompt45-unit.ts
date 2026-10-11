/**
 * Prompt 45 — UNIT TEST SUITE. Pure domain laws + contracts.
 * Run: npx tsx scripts/prompt45-unit.ts
 *
 * Counted assertions only: every ok()/eq() call executes for real.
 * Coverage: status vocabulary + transitions + invalid persisted status,
 * quantity limits + safe integers, canonical line/subtotal/total math
 * (overflow, discount law), fulfillment law (remaining, over-dispatch,
 * no clamp), line-set completeness invariant (incl. count mismatch BELOW
 * the cap), dispatch-request gate, line cap parsing (§31), reference
 * normalization/generation, calendar-date strictness + business-timezone
 * windows, DTO allowlists (order/line/invoice/customer-360/product),
 * error-code contract (§111), lifecycle gates, zod boundary schemas
 * (create/update/line create+update/list query/linked dispatch),
 * EN/FA i18n parity, export field selection.
 */
import { readFileSync } from "node:fs";
import {
  SALES_ORDER_STATUSES,
  SALES_ORDER_TRANSITIONS,
  SALES_ORDER_ERROR_CODES,
  SALES_ORDER_LINE_CAP_DEFAULT,
  SALES_ORDER_LINE_CAP_MIN,
  SALES_ORDER_LINE_CAP_MAX,
  SALES_ORDER_QTY_MAX,
  SALES_ORDER_PRICE_MAX,
  ORDER_QTY_MIN,
  SALES_ORDER_INVALID_PERSISTED_STATUS,
  SALES_ORDER_CORRUPT_HISTORY,
  SALES_ORDER_LINE_CAP_INVARIANT,
  SALES_ORDER_TOTAL_OVERFLOW,
  SalesOrderStatusIntegrityError,
  SalesOrderIntegrityError,
  SalesOrderTotalOverflowError,
  canTransitionSalesOrder,
  isSalesOrderStatus,
  isValidOrderQty,
  isValidPersistedOrderQty,
  isValidOrderPrice,
  assertSalesOrderLineSetComplete,
  salesOrderDayWindow,
  salesOrderLineCap,
  salesOrderEditable,
  salesOrderIsReadOnly,
  normalizeSalesOrderReference,
  generateSalesOrderReference,
  parseSalesOrderStatus,
  computeOrderLineTotalMinor,
  computeOrderSubtotalMinor,
  computeOrderTotalMinor,
  computeRemainingToDispatchQty,
  exceedsRemainingToDispatch,
  validateOrderDiscount,
  isValidCalendarDate,
} from "../src/lib/sales-orders/types";
import {
  salesOrderDetailDto,
  salesOrderInvoiceDto,
  salesOrderLineDto,
  customerRecentSalesOrderDto,
  productRecentSalesOrderDto,
} from "../src/lib/sales-orders/dto";
import {
  salesOrderCreateSchema,
  salesOrderUpdateSchema,
  salesOrderLineCreateSchema,
  salesOrderLineUpdateSchema,
  salesOrderListQuerySchema,
  salesOrderDispatchCreateSchema,
} from "../src/lib/sales-orders/schema";
import { goodsDispatchLineCreateSchema } from "../src/lib/inventory/goods-dispatch/schema";

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
    const matches = errorName
      ? (e as Error).name === errorName || String((e as Error).message).includes(errorName)
      : true;
    ok(matches, name);
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}

console.log("=== Prompt 45 unit suite ===");

/* ----------------------------- lifecycle ---------------------------------- */

section("status vocabulary + transitions (§15/§16)");
eq(SALES_ORDER_STATUSES.length, 4, "four lifecycle statuses");
ok(SALES_ORDER_STATUSES.includes("DRAFT"), "DRAFT exists");
ok(SALES_ORDER_STATUSES.includes("CONFIRMED"), "CONFIRMED exists");
ok(SALES_ORDER_STATUSES.includes("COMPLETED"), "COMPLETED exists");
ok(SALES_ORDER_STATUSES.includes("CANCELLED"), "CANCELLED exists");
ok(canTransitionSalesOrder("DRAFT", "CONFIRMED"), "DRAFT → CONFIRMED");
ok(canTransitionSalesOrder("DRAFT", "CANCELLED"), "DRAFT → CANCELLED");
ok(canTransitionSalesOrder("CONFIRMED", "COMPLETED"), "CONFIRMED → COMPLETED");
ok(canTransitionSalesOrder("CONFIRMED", "CANCELLED"), "CONFIRMED → CANCELLED");
ok(!canTransitionSalesOrder("COMPLETED", "CANCELLED"), "COMPLETED is terminal");
ok(!canTransitionSalesOrder("CANCELLED", "CONFIRMED"), "CANCELLED is terminal");
ok(!canTransitionSalesOrder("CONFIRMED", "DRAFT"), "no CONFIRMED → DRAFT downgrade");
ok(!canTransitionSalesOrder("DRAFT", "COMPLETED"), "no DRAFT → COMPLETED skip");
eq(SALES_ORDER_TRANSITIONS.COMPLETED.length, 0, "COMPLETED has no outgoing transitions");
eq(SALES_ORDER_TRANSITIONS.CANCELLED.length, 0, "CANCELLED has no outgoing transitions");

section("invalid persisted status (§108)");
throws(() => parseSalesOrderStatus("BROKEN"), "unknown status throws", "SalesOrderStatusIntegrityError");
throws(() => parseSalesOrderStatus(""), "empty status throws", "SalesOrderStatusIntegrityError");
throws(() => parseSalesOrderStatus("draft"), "lowercase is not silently accepted", "SalesOrderStatusIntegrityError");
throws(() => parseSalesOrderStatus("PAID"), "Sale payment status is NOT an order status", "SalesOrderStatusIntegrityError");
eq(parseSalesOrderStatus("DRAFT"), "DRAFT", "valid DRAFT parses");
eq(parseSalesOrderStatus("COMPLETED"), "COMPLETED", "valid COMPLETED parses");
eq(SALES_ORDER_INVALID_PERSISTED_STATUS, "SALES_ORDER_INVALID_PERSISTED_STATUS", "stable integrity code");

/* ------------------------------ quantities -------------------------------- */

section("quantity laws (§18/§21/§22)");
eq(ORDER_QTY_MIN, 1, "minimum ordered qty is 1");
eq(SALES_ORDER_QTY_MAX, 1_000_000, "maximum ordered qty is 1,000,000");
ok(isValidOrderQty(1), "1 is valid");
ok(isValidOrderQty(1_000_000), "1,000,000 is valid");
ok(!isValidOrderQty(0), "0 is invalid");
ok(!isValidOrderQty(-5), "negative is invalid");
ok(!isValidOrderQty(1.5), "fraction is invalid");
ok(!isValidOrderQty(Number.NaN), "NaN is invalid");
ok(!isValidOrderQty(Number.POSITIVE_INFINITY), "Infinity is invalid");
ok(!isValidOrderQty(1_000_001), "above max is invalid");
ok(!isValidOrderQty(Number.MAX_SAFE_INTEGER + 1), "unsafe integer is invalid");
ok(isValidPersistedOrderQty(10) === isValidOrderQty(10), "persisted law mirrors the input law");
ok(isValidOrderPrice(0), "zero price allowed (free item)");
ok(isValidOrderPrice(9_000_000_000), "max price allowed");
ok(!isValidOrderPrice(-1), "negative price rejected");
ok(!isValidOrderPrice(9_000_000_001), "above max price rejected");
ok(!isValidOrderPrice(1.5), "fractional price rejected");

/* ----------------------------- totals math -------------------------------- */

section("canonical totals (§24/§107)");
eq(computeOrderLineTotalMinor(10, 250), 2500, "10 × 250 = 2500");
eq(computeOrderLineTotalMinor(1, 0), 0, "free item totals 0");
eq(computeOrderLineTotalMinor(1_000_000, 9_000_000_000), 9_000_000_000_000_000, "max line total stays safe");
throws(() => computeOrderLineTotalMinor(0, 100), "invalid qty rejected", "SalesOrderIntegrityError");
throws(() => computeOrderLineTotalMinor(10, -1), "invalid price rejected", "SalesOrderIntegrityError");

const manyMaxLines = Array.from({ length: 200 }, () => ({ orderedQty: 1_000_000, unitPriceMinor: 9_000_000_000 }));
throws(() => computeOrderSubtotalMinor(manyMaxLines), "200 max lines overflow the subtotal", "SalesOrderTotalOverflowError");
eq(
  computeOrderSubtotalMinor([
    { orderedQty: 3, unitPriceMinor: 1000 },
    { orderedQty: 2, unitPriceMinor: 500 },
  ]).subtotalMinor,
  4000,
  "subtotal sums line totals",
);

section("discount law (§23)");
eq(validateOrderDiscount(0, 4000), 0, "zero discount always valid");
eq(validateOrderDiscount(4000, 4000), 4000, "discount may equal the subtotal");
throws(() => validateOrderDiscount(4001, 4000), "discount above subtotal rejected", "SalesOrderTotalOverflowError");
throws(() => validateOrderDiscount(-1, 4000), "negative discount rejected", "SalesOrderTotalOverflowError");
throws(() => validateOrderDiscount(Number.NaN, 4000), "NaN discount rejected", "SalesOrderTotalOverflowError");

section("canonical total (§24)");
eq(computeOrderTotalMinor(4000, 500), 3500, "total = subtotal − discount");
throws(() => computeOrderTotalMinor(500, 600), "negative result rejected", "SalesOrderTotalOverflowError");
throws(() => computeOrderTotalMinor(-1, 0), "negative subtotal rejected", "SalesOrderIntegrityError");

/* ----------------------------- fulfillment -------------------------------- */

section("fulfillment law (§36/§37/§38)");
eq(computeRemainingToDispatchQty(100, 0).remainingToDispatchQty, 100, "nothing dispatched → remaining = ordered");
eq(computeRemainingToDispatchQty(100, 30).remainingToDispatchQty, 70, "partial dispatch decrements remaining");
eq(computeRemainingToDispatchQty(100, 100).remainingToDispatchQty, 0, "fully dispatched → remaining 0 (exact, not clamped)");
eq(computeRemainingToDispatchQty(100, 100).dispatchedQty, 100, "dispatched is echoed back validated");
throws(
  () => computeRemainingToDispatchQty(100, 101),
  "over-dispatch is an integrity failure (no clamp)",
  "SalesOrderIntegrityError",
);
throws(
  () => computeRemainingToDispatchQty(100, -1),
  "negative dispatched is corruption",
  "SalesOrderIntegrityError",
);
throws(
  () => computeRemainingToDispatchQty(0, 0),
  "invalid ordered qty is corruption",
  "SalesOrderIntegrityError",
);
ok(!exceedsRemainingToDispatch(70, 70), "request equal to remaining is allowed");
ok(exceedsRemainingToDispatch(70, 71), "request above remaining is rejected");
throws(() => exceedsRemainingToDispatch(-1, 1), "invalid remaining is corruption", "SalesOrderIntegrityError");
throws(() => exceedsRemainingToDispatch(70, 0), "invalid request qty is corruption", "SalesOrderIntegrityError");

/* ------------------------------ line cap ---------------------------------- */

section("line cap (§31/§106)");
eq(SALES_ORDER_LINE_CAP_DEFAULT, 200, "default cap 200");
eq(SALES_ORDER_LINE_CAP_MIN, 20, "min cap 20");
eq(SALES_ORDER_LINE_CAP_MAX, 500, "max cap 500");
eq(salesOrderLineCap(undefined), 200, "undefined env → default");
eq(salesOrderLineCap(""), 200, "empty env → default");
eq(salesOrderLineCap("garbage"), 200, "malformed env → default");
eq(salesOrderLineCap("10"), 20, "below min → clamped to 20");
eq(salesOrderLineCap("1000"), 500, "above max → clamped to 500");
eq(salesOrderLineCap("20"), 20, "min boundary accepted");
eq(salesOrderLineCap("500"), 500, "max boundary accepted");

section("line-set completeness invariant (§106)");
assertSalesOrderLineSetComplete(10, 10, 200); // valid
ok(true, "matching counts pass");
assertSalesOrderLineSetComplete(200, 200, 200); // at cap, valid
ok(true, "cap-exact counts pass");
throws(() => assertSalesOrderLineSetComplete(201, 201, 200), "fetched > cap fails", "SalesOrderIntegrityError");
throws(() => assertSalesOrderLineSetComplete(10, 201, 200), "counted > cap fails", "SalesOrderIntegrityError");
// THE mismatch arm: both below the cap but unequal → corruption.
throws(
  () => assertSalesOrderLineSetComplete(1, 2, 200),
  "count mismatch BELOW cap fails (1 vs 2)",
  "SalesOrderIntegrityError",
);
throws(
  () => assertSalesOrderLineSetComplete(199, 200, 200),
  "count mismatch at cap-1 fails",
  "SalesOrderIntegrityError",
);

/* ------------------------------ references -------------------------------- */

section("reference law (§13/§14)");
eq(normalizeSalesOrderReference("  SO-2026-001  "), "SO-2026-001", "trims whitespace");
eq(normalizeSalesOrderReference("a\nb"), null, "newline injection rejected");
eq(normalizeSalesOrderReference("a\u0000b"), null, "NUL rejected");
eq(normalizeSalesOrderReference("a"), null, "below min length rejected");
eq(normalizeSalesOrderReference("ab"), "ab", "min length accepted");
eq(normalizeSalesOrderReference("x".repeat(81)), null, "above max length rejected");
eq(normalizeSalesOrderReference("x".repeat(80)), "x".repeat(80), "max length accepted");
eq(normalizeSalesOrderReference("سفارش ۱"), "سفارش ۱", "Unicode preserved");
eq(normalizeSalesOrderReference("  "), null, "blank → null (server generates)");

const fixedRandom = (max: number) => max - 1;
const ref = generateSalesOrderReference(new Date("2026-10-11T00:00:00Z"), fixedRandom);
ok(ref.startsWith("SO-20261011-"), "generated reference carries the date stamp");
eq(ref.length, "SO-20261011-XXXXXX".length, "generated reference shape");
const token = ref.split("-")[2] ?? "";
ok(
  ![...token].some((ch) => "ILO01".includes(ch)),
  "ambiguous characters excluded from the token alphabet",
);

/* ------------------------------ date window ------------------------------- */

section("date window law (business timezone)");
ok(isValidCalendarDate("2026-02-28"), "leap-aware validation accepts 2026-02-28");
ok(!isValidCalendarDate("2026-02-29"), "2026 is not a leap year");
ok(isValidCalendarDate("2024-02-29"), "2024 leap day accepted");
ok(!isValidCalendarDate("2026-13-01"), "month 13 rejected");
ok(!isValidCalendarDate("2026-00-10"), "month 0 rejected");
ok(!isValidCalendarDate("2026-04-31"), "April 31 rejected");
ok(!isValidCalendarDate("not-a-date"), "garbage rejected");
ok(!isValidCalendarDate("2026-2-3"), "non-padded rejected");

eq(JSON.stringify(salesOrderDayWindow(undefined, undefined, "UTC")), "{}", "no bounds → empty window");
eq(salesOrderDayWindow("2026-02-30", undefined, "UTC"), null, "invalid from → null (422)");
eq(salesOrderDayWindow(undefined, "2026-13-01", "UTC"), null, "invalid to → null (422)");
const utcWin = salesOrderDayWindow("2026-10-11", "2026-10-11", "UTC");
ok(utcWin?.gte instanceof Date, "UTC window has gte");
eq(utcWin?.gte?.toISOString(), "2026-10-11T00:00:00.000Z", "from = local midnight (UTC)");
eq(utcWin?.lt?.toISOString(), "2026-10-12T00:00:00.000Z", "to = EXCLUSIVE next-day start");
const tehranWin = salesOrderDayWindow("2026-10-11", "2026-10-11", "Asia/Tehran");
eq(tehranWin?.gte?.toISOString(), "2026-10-10T20:30:00.000Z", "+03:30 window opens the UTC evening before");
const nyWin = salesOrderDayWindow("2026-10-11", "2026-10-11", "America/New_York");
eq(nyWin?.gte?.toISOString(), "2026-10-11T04:00:00.000Z", "−04:00 window opens the UTC morning after");
const lateNight = salesOrderDayWindow("2026-10-11", "2026-10-11", "Asia/Tehran");
ok(
  lateNight !== null &&
    new Date("2026-10-11T00:15:00+03:30").getTime() >= lateNight.gte!.getTime(),
  "a record at 00:15 LOCAL belongs to its local date",
);
// from > to is REJECTED at the zod boundary (see the list-query section
// below); the pure helper itself produces an empty, harmless window.
ok(salesOrderDayWindow("2026-10-12", "2026-10-11", "UTC") !== null, "from > to is a schema-level rejection, not a helper crash");

/* --------------------------------- DTOs ----------------------------------- */

section("DTO allowlists (§65/§113)");
const headerRow = {
  id: "so1",
  reference: "SO-2026-001",
  status: "CONFIRMED",
  customerId: "c1",
  customerNameAtOrder: "Acme",
  currencyCodeAtOrder: "USD",
  currencySymbolAtOrder: "$",
  decimalPrecisionAtOrder: 2,
  orderDate: new Date("2026-10-01T00:00:00Z"),
  expectedDate: new Date("2026-10-15T00:00:00Z"),
  discountMinor: 100,
  notes: null,
  createdByUserId: "u1",
  createdByName: "Sara",
  confirmedAt: new Date("2026-10-02T00:00:00Z"),
  completedAt: null,
  cancelledAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-02T00:00:00Z"),
};
const lineRow = {
  id: "l1",
  productId: "p1",
  productNameAtOrder: "Duct Tape",
  skuAtOrder: "DT-1",
  unitAtOrder: "piece",
  orderedQty: 10,
  unitPriceMinor: 250,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};
const detail = salesOrderDetailDto(headerRow, [{ row: lineRow, dispatchedQty: 4 }], {
  id: "sale1",
  number: 7,
  status: "UNPAID",
  totalMinor: 2400,
  paidMinor: 0,
});
eq(detail.order.status, "CONFIRMED", "detail status parsed");
eq(detail.lines[0].lineTotalMinor, 2500, "line total computed canonically");
eq(detail.lines[0].dispatchedQty, 4, "line dispatched echoed");
eq(detail.lines[0].remainingToDispatchQty, 6, "line remaining computed");
eq(detail.summary.lineCount, 1, "summary lineCount");
eq(detail.summary.totalQty, 10, "summary totalQty");
eq(detail.summary.subtotalMinor, 2500, "summary subtotal");
eq(detail.summary.totalMinor, 2400, "summary total after discount");
eq(detail.summary.dispatchedQty, 4, "summary dispatched");
eq(detail.summary.remainingToDispatchQty, 6, "summary remaining");
eq(detail.summary.fullyDispatched, false, "not fully dispatched");
eq(detail.invoice?.number, 7, "invoice DTO present when relation exists");
const keys = Object.keys(detail.order).sort().join(",");
ok(!keys.includes("businessId"), "businessId never exposed on the wire");
ok(!keys.includes("createdByUserId"), "createdByUserId never exposed (createdBy.name only)");
eq(detail.order.createdBy?.name, "Sara", "creator name projection");
eq(detail.order.createdBy?.id, "u1", "creator id projection");

const noInvoice = salesOrderDetailDto(headerRow, [{ row: lineRow, dispatchedQty: 10 }], null);
eq(noInvoice.invoice, null, "invoice DTO ABSENT when no relation (never inferred §91)");
eq(noInvoice.summary.fullyDispatched, true, "fully dispatched flag");

const dto = salesOrderLineDto(lineRow, 10);
ok(!("businessId" in dto) && !("salesOrderId" in dto), "line DTO allowlist");
eq(dto.remainingToDispatchQty, 0, "line DTO remaining");

throws(
  () => salesOrderLineDto({ ...lineRow, orderedQty: 0 }, 0),
  "persisted zero qty is corruption",
  "SalesOrderIntegrityError",
);
throws(
  () => salesOrderLineDto({ ...lineRow, productNameAtOrder: "" }, 0),
  "missing snapshot is corruption (§109)",
  "SalesOrderIntegrityError",
);
throws(
  () => salesOrderLineDto({ ...lineRow, orderedQty: 5 }, 6),
  "over-dispatched history is corruption",
  "SalesOrderIntegrityError",
);
throws(
  () => salesOrderDetailDto({ ...headerRow, status: "GARBAGE" }, [{ row: lineRow, dispatchedQty: 0 }], null),
  "unknown persisted status never becomes DRAFT in DTOs",
  "SalesOrderStatusIntegrityError",
);

section("linked invoice DTO (§65)");
const inv = salesOrderInvoiceDto({ id: "s1", number: 3, status: "PARTIAL", totalMinor: 1000, paidMinor: 400 });
eq(inv.status, "PARTIAL", "payment status carried through (separate authority §64)");
throws(
  () => salesOrderInvoiceDto({ id: "s1", number: 3, status: "PARTIAL", totalMinor: Number.NaN, paidMinor: 0 }),
  "unsafe money rejected",
  "SalesOrderIntegrityError",
);

section("entity-360 DTOs (§71/§72)");
const custRow = customerRecentSalesOrderDto({
  id: "so1",
  reference: "SO-1",
  status: "DRAFT",
  orderDate: new Date("2026-10-01T00:00:00Z"),
  currencyCodeAtOrder: "IRR",
  currencySymbolAtOrder: "﷼",
  decimalPrecisionAtOrder: 0,
  totalMinor: 5000,
  orderedQty: 5,
  dispatchedQty: 2,
  invoiceNumber: null,
  invoiceStatus: null,
});
eq(custRow.currencyCodeAtOrder, "IRR", "order currency snapshot carried");
eq(custRow.invoiceNumber, null, "no invoice projected when absent");
eq(custRow.dispatchedQty, 2, "dispatched progress");
const prodRow = productRecentSalesOrderDto({
  id: "so1",
  reference: "SO-1",
  customerNameAtOrder: "Acme",
  status: "CONFIRMED",
  orderDate: new Date("2026-10-01T00:00:00Z"),
  orderedQty: 5,
  dispatchedQty: 2,
});
eq(prodRow.remainingToDispatchQty, 3, "product-history remaining computed");
throws(
  () => productRecentSalesOrderDto({
    id: "so1", reference: "SO-1", customerNameAtOrder: "Acme", status: "CONFIRMED",
    orderDate: new Date("2026-10-01T00:00:00Z"), orderedQty: 5, dispatchedQty: 6,
  }),
  "product-history over-dispatch is corruption",
  "SalesOrderIntegrityError",
);

/* ----------------------------- error codes -------------------------------- */

section("error code contract (§111)");
const REQUIRED_CODES = [
  "SALES_ORDER_DUPLICATE_REFERENCE",
  "SALES_ORDER_INVALID_STATUS",
  "SALES_ORDER_EMPTY",
  "SALES_ORDER_LINE_LIMIT_REACHED",
  "SALES_ORDER_LINE_CAP_INVARIANT",
  "SALES_ORDER_DUPLICATE_PRODUCT",
  "SALES_ORDER_INVALID_TRANSITION",
  "SALES_ORDER_HAS_FULFILLMENT",
  "SALES_ORDER_NOT_FULLY_DISPATCHED",
  "SALES_ORDER_ALREADY_INVOICED",
  "SALES_ORDER_DISPATCH_EXCEEDS_REMAINING",
  "SALES_ORDER_TOTAL_OVERFLOW",
  "SALES_ORDER_INVALID_PERSISTED_STATUS",
  "SALES_ORDER_IMMUTABLE",
  "SALE_LINKED_TO_SALES_ORDER",
  "SALES_ORDER_FOREIGN_ENTITY",
];
for (const code of REQUIRED_CODES) {
  ok(Object.values(SALES_ORDER_ERROR_CODES).includes(code as never), `code present: ${code}`);
}
ok(new Set(Object.values(SALES_ORDER_ERROR_CODES)).size === Object.values(SALES_ORDER_ERROR_CODES).length,
  "no duplicate code strings in the vocabulary");

section("lifecycle gates (§26/§27)");
ok(salesOrderEditable("DRAFT"), "DRAFT editable");
ok(!salesOrderEditable("CONFIRMED"), "CONFIRMED not editable");
ok(salesOrderIsReadOnly("CONFIRMED"), "CONFIRMED read-only");
ok(salesOrderIsReadOnly("COMPLETED"), "COMPLETED read-only");
ok(salesOrderIsReadOnly("CANCELLED"), "CANCELLED read-only");
ok(!salesOrderIsReadOnly("DRAFT"), "DRAFT not read-only");

/* --------------------------------- zod ------------------------------------ */

section("zod: create schema (§112)");
const parsedCreate = salesOrderCreateSchema.parse({
  customerId: " c1 ",
  reference: "  SO-1  ",
  orderDate: "2026-10-11",
  expectedDate: "2026-10-15",
  discountMinor: 0,
  notes: "  hello  ",
});
eq(parsedCreate.customerId, "c1", "customerId trimmed");
eq(parsedCreate.reference, "SO-1", "reference normalized");
eq(parsedCreate.notes, "hello", "notes trimmed");
throws(() => salesOrderCreateSchema.parse({ status: "CONFIRMED" }), "status injection rejected (strict)");
throws(() => salesOrderCreateSchema.parse({ businessId: "b1" }), "businessId injection rejected (strict)");
throws(() => salesOrderCreateSchema.parse({ customerNameAtOrder: "Fake" }), "customer snapshot injection rejected");
throws(() => salesOrderCreateSchema.parse({ currencyCodeAtOrder: "USD" }), "currency snapshot injection rejected");
throws(() => salesOrderCreateSchema.parse({ discountMinor: -5 }), "negative discount rejected");
throws(() => salesOrderCreateSchema.parse({ orderDate: "2026-02-30" }), "invalid calendar date rejected");
throws(() => salesOrderCreateSchema.parse({ expectedDate: "2026-13-01" }), "invalid expected date rejected");
ok(salesOrderCreateSchema.safeParse({ notes: null }).success, "minimal create is valid");
throws(() => salesOrderCreateSchema.parse({ totalMinor: 500 }), "computed total injection rejected");
throws(() => salesOrderCreateSchema.parse({ dispatchedQty: 5 }), "dispatchedQty injection rejected");

section("zod: update schema (§26)");
ok(salesOrderUpdateSchema.safeParse({ discountMinor: 100 }).success, "discount-only patch valid");
ok(salesOrderUpdateSchema.safeParse({ customerId: null }).success, "explicit customer clear valid");
ok(salesOrderUpdateSchema.safeParse({ expectedDate: null }).success, "explicit expectedDate clear valid");
throws(() => salesOrderUpdateSchema.parse({}), "empty patch rejected (nothing to update)");
throws(() => salesOrderUpdateSchema.parse({ status: "CANCELLED" }), "status is never patchable");
throws(() => salesOrderUpdateSchema.parse({ confirmedAt: new Date().toISOString() }), "lifecycle timestamps never patchable");

section("zod: line schemas (§18/§20/§27)");
const parsedLine = salesOrderLineCreateSchema.parse({ productId: " p1 ", orderedQty: 5 });
eq(parsedLine.productId, "p1", "productId trimmed");
eq(parsedLine.unitPriceMinor, undefined, "price optional (defaults server-side §21)");
throws(() => salesOrderLineCreateSchema.parse({ productId: "p1", orderedQty: 0 }), "zero qty rejected");
throws(() => salesOrderLineCreateSchema.parse({ productId: "p1", orderedQty: 1.5 }), "fractional qty rejected");
throws(() => salesOrderLineCreateSchema.parse({ productId: "p1", orderedQty: 5, productNameAtOrder: "Fake" }), "snapshot injection rejected");
throws(() => salesOrderLineCreateSchema.parse({ productId: "p1", orderedQty: 5, salesOrderLineId: "x" }), "order-line injection rejected on order lines");
ok(salesOrderLineUpdateSchema.safeParse({ orderedQty: 10 }).success, "qty-only update valid");
ok(salesOrderLineUpdateSchema.safeParse({ unitPriceMinor: 300 }).success, "price-only update valid");
throws(() => salesOrderLineUpdateSchema.parse({}), "empty line update rejected");
throws(() => salesOrderLineUpdateSchema.parse({ productId: "p2" }), "product reassignment rejected");

section("zod: list query + linked dispatch (§40/§67)");
ok(salesOrderListQuerySchema.safeParse({ status: "ALL" }).success, "ALL accepted");
ok(!salesOrderListQuerySchema.safeParse({ status: "PAID" }).success, "Sale payment status rejected as order filter");
ok(!salesOrderListQuerySchema.safeParse({ from: "2026-02-30" }).success, "invalid from rejected");
ok(!salesOrderListQuerySchema.safeParse({ from: "2026-10-10", to: "2026-10-09" }).success, "from > to rejected");
ok(!salesOrderListQuerySchema.safeParse({ pageSize: "500" }).success, "pageSize above 100 rejected");
eq(salesOrderListQuerySchema.parse({ pageSize: "100" }).pageSize, 100, "pageSize 100 accepted (max bound)");
throws(() => salesOrderDispatchCreateSchema.parse({ reference: "x" }), "linked dispatch create: reference not client-authored");
ok(salesOrderDispatchCreateSchema.safeParse({ notes: "ok" }).success, "linked dispatch create accepts notes only");

section("zod: linked dispatch line create (§41)");
ok(
  goodsDispatchLineCreateSchema.safeParse({ salesOrderLineId: "sol1", qty: 4 }).success,
  "linked line accepts salesOrderLineId + qty",
);
throws(
  () => goodsDispatchLineCreateSchema.parse({ salesOrderLineId: "sol1", qty: 4, productId: "p1" }),
  "linked line rejects productId injection",
);
throws(
  () => goodsDispatchLineCreateSchema.parse({ salesOrderLineId: "sol1", qty: 4, reasonCode: "SALE" }),
  "linked line rejects reasonCode injection (server-controlled)",
);
throws(
  () => goodsDispatchLineCreateSchema.parse({ qty: 4 }),
  "line requires one source",
);
throws(
  () => goodsDispatchLineCreateSchema.parse({ productId: "p1", qty: 4 }),
  "standalone line still requires reasonCode",
);
ok(
  goodsDispatchLineCreateSchema.safeParse({ productId: "p1", qty: 4, reasonCode: "OTHER" }).success,
  "standalone contract unchanged (P44 §compatibility)",
);
throws(
  () => goodsDispatchLineCreateSchema.parse({ salesOrderLineId: "sol1", qty: 0 }),
  "zero qty rejected",
);

/* --------------------------------- i18n ----------------------------------- */

section("i18n parity (EN/FA)");
function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? flattenKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}
const repoRoot = process.cwd();
import { createRequire } from "node:module";
import path from "node:path";
const esmRequire = createRequire(path.join(repoRoot, "package.json"));
const en = esmRequire("./src/i18n/messages/en") as { default: Record<string, unknown> };
const fa = esmRequire("./src/i18n/messages/fa") as { default: Record<string, unknown> };
const enKeys = flattenKeys((en.default as Record<string, unknown>).salesOrders as Record<string, unknown>);
const faKeys = flattenKeys((fa.default as Record<string, unknown>).salesOrders as Record<string, unknown>);
ok(enKeys.length >= 100, `EN salesOrders keys present (${enKeys.length})`);
eq(enKeys.length, faKeys.length, "EN/FA key count parity");
const missingInFa = enKeys.filter((k) => !faKeys.includes(k));
eq(missingInFa.length, 0, `no EN key missing in FA${missingInFa.length ? `: ${missingInFa.slice(0, 3).join(",")}` : ""}`);
const faMessages = (fa.default as Record<string, Record<string, Record<string, string>>>).salesOrders;
const persianTerms: Array<[string, string]> = [
  ["title", "سفارش فروش"],
  ["confirmAction", "تأیید سفارش"],
  ["dispatchedLabel", "مقدار خارج‌شده"],
  ["remainingLabel", "مقدار باقی‌مانده برای خروج"],
  ["issueInvoice", "صدور فاکتور"],
  ["status_COMPLETED", "تکمیل‌شده"],
  ["status_CANCELLED", "لغوشده"],
];
for (const [key, expected] of persianTerms) {
  eq(faMessages[key], expected, `FA professional terminology: ${key}`);
}
ok(enKeys.filter((k) => k.startsWith("csv")).length >= 17, "CSV header keys present (§114)");
// Export builder uses the same keys — verify ALL csv keys exist in both.
const csvKeys = enKeys.filter((k) => k.startsWith("csv"));
const faHasAllCsv = csvKeys.every((k) => faKeys.includes(k));
ok(faHasAllCsv, "FA carries every CSV header key");

/* ------------------------------ export shape ------------------------------ */

section("export field selection (§114)");
ok(
  enKeys.includes("csvDispatchedQty") && enKeys.includes("csvRemainingQty"),
  "export carries fulfillment columns",
);
ok(
  enKeys.includes("csvInvoiceNumber") && enKeys.includes("csvInvoiceStatus"),
  "export carries invoice columns (when present)",
);
ok(enKeys.includes("csvUnitPrice") && enKeys.includes("csvLineTotal"), "export carries price columns");

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
