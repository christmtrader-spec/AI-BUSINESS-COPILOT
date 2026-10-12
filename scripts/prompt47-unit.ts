/**
 * Prompt 47 — UNIT TEST SUITE. Pure domain laws + contracts (NO server,
 * NO database — runs with `bun` directly; types/schema/dto are client-safe
 * pure modules, so the server-only shim is NOT required — verified).
 *
 * Run: bun scripts/prompt47-unit.ts
 *
 * Counted assertions only: every ok()/eq()/throws() call executes for real.
 * Coverage: closed 7-status vocabulary + parseSalesQuotationStatus (INVALID
 * ≠ DRAFT §8) + FULL transition matrix (every (from,to) pair; terminals
 * reject all) · effective-vs-persisted status law (§9) · inclusive-until
 * expiration boundary in Asia/Tehran (UTC+3:30) · businessLocalCalendarDate
 * + unknown-tz fallback · validity ordering + strict calendar dates ·
 * qty/price safe-integer laws (§6) · line cap parsing (§11) · line-set
 * completeness invariant (over-cap + mismatch BELOW cap) · canonical
 * line/subtotal/total math (overflow, discount law, corrupt operands) ·
 * reference normalization/generation (QT- prefix, unambiguous alphabet) ·
 * business-timezone day windows · DTO allowlists (line/detail/print/
 * customer-360/product) with corrupted-status + missing-snapshot integrity
 * · error-code contract (§22) · EN/FA i18n parity for the salesQuotations
 * namespace · zod boundary schemas (.strict() authority-field rejection,
 * qty/price bounds, validUntilDate required, list query bounds).
 */
import {
  SALES_QUOTATION_STATUSES,
  SALES_QUOTATION_TRANSITIONS,
  SALES_QUOTATION_ERROR_CODES,
  SALES_QUOTATION_LINE_CAP_DEFAULT,
  SALES_QUOTATION_LINE_CAP_MIN,
  SALES_QUOTATION_LINE_CAP_MAX,
  SALES_QUOTATION_QTY_MAX,
  SALES_QUOTATION_PRICE_MAX,
  QUOTATION_QTY_MIN,
  SALES_QUOTATION_INVALID_PERSISTED_STATUS,
  SALES_QUOTATION_CORRUPT_HISTORY,
  SALES_QUOTATION_LINE_CAP_INVARIANT,
  SALES_QUOTATION_TOTAL_OVERFLOW,
  SalesQuotationStatusIntegrityError,
  SalesQuotationIntegrityError,
  SalesQuotationTotalOverflowError,
  isSalesQuotationStatus,
  canTransitionSalesQuotation,
  isValidQuotationQty,
  isValidPersistedQuotationQty,
  isValidQuotationPrice,
  assertSalesQuotationLineSetComplete,
  salesQuotationLineCap,
  salesQuotationEditable,
  salesQuotationIsReadOnly,
  normalizeSalesQuotationReference,
  generateSalesQuotationReference,
  parseSalesQuotationStatus,
  computeQuotationLineTotalMinor,
  computeQuotationSubtotalMinor,
  computeQuotationTotalMinor,
  validateQuotationDiscount,
  isValidCalendarDate,
  salesQuotationDayWindow,
  businessLocalCalendarDate,
  isQuotationExpiredInBusinessTz,
  effectiveQuotationStatus,
  midnoonDateToCalendarDate,
  isQuotationDateRangeValid,
} from "../src/lib/sales-quotations/types";
import {
  salesQuotationDetailDto,
  salesQuotationLineDto,
  salesQuotationPrintDto,
  customerRecentSalesQuotationDto,
  productRecentSalesQuotationDto,
  statusOf,
} from "../src/lib/sales-quotations/dto";
import {
  salesQuotationCreateSchema,
  salesQuotationUpdateSchema,
  salesQuotationLineCreateSchema,
  salesQuotationLineUpdateSchema,
  salesQuotationListQuerySchema,
  salesQuotationExportQuerySchema,
} from "../src/lib/sales-quotations/schema";

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

console.log("=== Prompt 47 unit suite (sales quotations) ===");

/* ----------------------------- lifecycle ---------------------------------- */

section("closed status vocabulary (§8)");
eq(SALES_QUOTATION_STATUSES.length, 7, "seven lifecycle statuses");
ok(SALES_QUOTATION_STATUSES.includes("DRAFT"), "DRAFT exists");
ok(SALES_QUOTATION_STATUSES.includes("SENT"), "SENT exists");
ok(SALES_QUOTATION_STATUSES.includes("ACCEPTED"), "ACCEPTED exists");
ok(SALES_QUOTATION_STATUSES.includes("REJECTED"), "REJECTED exists");
ok(SALES_QUOTATION_STATUSES.includes("EXPIRED"), "EXPIRED exists");
ok(SALES_QUOTATION_STATUSES.includes("CANCELLED"), "CANCELLED exists");
ok(SALES_QUOTATION_STATUSES.includes("CONVERTED"), "CONVERTED exists");
ok(isSalesQuotationStatus("DRAFT"), "isSalesQuotationStatus accepts DRAFT");
ok(isSalesQuotationStatus("CONVERTED"), "isSalesQuotationStatus accepts CONVERTED");
ok(!isSalesQuotationStatus("PAID"), "Sale payment status is NOT a quotation status");
ok(!isSalesQuotationStatus("draft"), "lowercase is not a status");
ok(!isSalesQuotationStatus(""), "empty string is not a status");
eq(salesQuotationEditable("DRAFT"), true, "DRAFT editable");
eq(salesQuotationEditable("SENT"), false, "SENT not editable");
eq(salesQuotationIsReadOnly("SENT"), true, "SENT read-only");
eq(salesQuotationIsReadOnly("ACCEPTED"), true, "ACCEPTED read-only");
eq(salesQuotationIsReadOnly("CONVERTED"), true, "CONVERTED read-only");
eq(salesQuotationIsReadOnly("DRAFT"), false, "DRAFT not read-only");

section("parseSalesQuotationStatus — INVALID PERSISTED STATUS ≠ DRAFT (§8)");
throws(() => parseSalesQuotationStatus("BROKEN"), "unknown status throws", "SalesQuotationStatusIntegrityError");
throws(() => parseSalesQuotationStatus(""), "empty status throws", "SalesQuotationStatusIntegrityError");
throws(() => parseSalesQuotationStatus("draft"), "lowercase never silently accepted", "SalesQuotationStatusIntegrityError");
throws(() => parseSalesQuotationStatus("CONFIRMED"), "SalesOrder status is NOT a quotation status", "SalesQuotationStatusIntegrityError");
eq(parseSalesQuotationStatus("DRAFT"), "DRAFT", "valid DRAFT parses");
eq(parseSalesQuotationStatus("EXPIRED"), "EXPIRED", "valid EXPIRED parses");
eq(parseSalesQuotationStatus("CONVERTED"), "CONVERTED", "valid CONVERTED parses");
eq(SALES_QUOTATION_INVALID_PERSISTED_STATUS, "SALES_QUOTATION_INVALID_PERSISTED_STATUS", "stable integrity code");
throws(() => statusOf("GARBAGE"), "DTO statusOf rethrows corrupted statuses", "SalesQuotationStatusIntegrityError");
eq(statusOf("SENT"), "SENT", "DTO statusOf passes valid statuses");

/* -------------------------- FULL transition matrix ------------------------ */

section("FULL transition matrix (§8) — every (from,to) pair");
const ALL_STATUSES = [...SALES_QUOTATION_STATUSES];
const LEGAL: Array<[string, string]> = [
  ["DRAFT", "SENT"],
  ["DRAFT", "CANCELLED"],
  ["SENT", "ACCEPTED"],
  ["SENT", "REJECTED"],
  ["SENT", "CANCELLED"],
  ["SENT", "EXPIRED"],
  ["ACCEPTED", "CONVERTED"],
  ["ACCEPTED", "CANCELLED"],
];
for (const from of ALL_STATUSES) {
  for (const to of ALL_STATUSES) {
    const isLegalPair = LEGAL.some(([f, t]) => f === from && t === to);
    eq(
      canTransitionSalesQuotation(from as never, to as never),
      isLegalPair,
      `${from} → ${to} ${isLegalPair ? "allowed" : "rejected"}`,
    );
  }
}
for (const terminal of ["REJECTED", "EXPIRED", "CANCELLED", "CONVERTED"] as const) {
  eq(SALES_QUOTATION_TRANSITIONS[terminal].length, 0, `${terminal} has no outgoing transitions`);
}
eq(Object.keys(SALES_QUOTATION_TRANSITIONS).length, 7, "matrix covers all 7 statuses");

/* --------------------------- effective status ----------------------------- */

section("effective status law (§9) — SENT past validity displays EXPIRED");
const until = new Date("2026-03-10T12:00:00.000Z"); // stored midnoon-UTC rule
const nowSameDay = new Date("2026-03-09T12:00:00.000Z");
eq(
  effectiveQuotationStatus("SENT", until, nowSameDay, "Asia/Tehran"),
  "SENT",
  "SENT within validity stays SENT",
);
const nowPast = new Date("2026-03-15T12:00:00.000Z");
eq(
  effectiveQuotationStatus("SENT", until, nowPast, "Asia/Tehran"),
  "EXPIRED",
  "SENT + past validity → EXPIRED (display only)",
);
eq(
  effectiveQuotationStatus("ACCEPTED", until, nowPast, "Asia/Tehran"),
  "ACCEPTED",
  "ACCEPTED NEVER expires (§9)",
);
eq(
  effectiveQuotationStatus("DRAFT", until, nowPast, "Asia/Tehran"),
  "DRAFT",
  "DRAFT unaffected by validity display law",
);
eq(
  effectiveQuotationStatus("CONVERTED", until, nowPast, "Asia/Tehran"),
  "CONVERTED",
  "CONVERTED unaffected",
);
eq(
  effectiveQuotationStatus("REJECTED", until, nowPast, "Asia/Tehran"),
  "REJECTED",
  "REJECTED unaffected",
);

/* --------------------- expiration boundary (Tehran) ----------------------- */

section("isQuotationExpiredInBusinessTz — inclusive-until boundary (Asia/Tehran +03:30)");
const validUntilMar10 = new Date("2026-03-10T12:00:00.000Z");
// Tehran is UTC+03:30 (no DST in March 2026): 2026-03-10T20:00Z = 23:30 local SAME day.
eq(
  isQuotationExpiredInBusinessTz(validUntilMar10, new Date("2026-03-10T20:00:00Z"), "Asia/Tehran"),
  false,
  "today == validUntil (23:30 local on the 10th) → NOT expired (inclusive-until)",
);
// 2026-03-10T20:31Z = 00:01 local on the 11th → the day AFTER validUntil.
eq(
  isQuotationExpiredInBusinessTz(validUntilMar10, new Date("2026-03-10T20:31:00Z"), "Asia/Tehran"),
  true,
  "today > validUntil (00:01 local on the 11th) → expired",
);
eq(
  isQuotationExpiredInBusinessTz(validUntilMar10, new Date("2026-03-10T12:00:00Z"), "Asia/Tehran"),
  false,
  "midday of the validity day → NOT expired",
);
eq(
  isQuotationExpiredInBusinessTz(validUntilMar10, new Date("2026-03-09T20:00:00Z"), "Asia/Tehran"),
  false,
  "the day before validity ends → NOT expired",
);
eq(
  isQuotationExpiredInBusinessTz(validUntilMar10, new Date("2026-03-10T23:00:00Z"), "UTC"),
  false,
  "UTC rendering of the same instant: 23:00 UTC is still the 10th → NOT expired",
);
eq(
  isQuotationExpiredInBusinessTz(validUntilMar10, new Date("2026-03-11T00:30:00Z"), "UTC"),
  true,
  "UTC next-day boundary → expired",
);

section("businessLocalCalendarDate — known instants + unknown-tz fallback");
eq(
  businessLocalCalendarDate(new Date("2026-03-10T20:00:00Z"), "Asia/Tehran"),
  "2026-03-10",
  "20:00Z is 2026-03-10 in Tehran (+03:30)",
);
eq(
  businessLocalCalendarDate(new Date("2026-03-10T20:31:00Z"), "Asia/Tehran"),
  "2026-03-11",
  "20:31Z is already 2026-03-11 in Tehran",
);
eq(
  businessLocalCalendarDate(new Date("2026-03-10T00:30:00Z"), "America/New_York"),
  "2026-03-09",
  "00:30Z is still 2026-03-09 in New York (−05:00)",
);
eq(
  businessLocalCalendarDate(new Date("2026-03-10T12:00:00Z"), "Not/AZone"),
  "2026-03-10",
  "unknown IANA zone falls back to UTC (never throws)",
);
eq(
  businessLocalCalendarDate(new Date("2026-03-10T12:00:00Z"), null),
  "2026-03-10",
  "null timezone → UTC",
);

/* ------------------------------ date laws --------------------------------- */

section("validity ordering + strict calendar dates (§9/§dates)");
ok(isQuotationDateRangeValid("2026-03-01", "2026-03-10"), "validUntil after quotationDate valid");
ok(isQuotationDateRangeValid("2026-03-10", "2026-03-10"), "validUntil == quotationDate valid (same-day offer)");
ok(!isQuotationDateRangeValid("2026-03-11", "2026-03-10"), "validUntil before quotationDate rejected");
ok(!isQuotationDateRangeValid("2026-02-30", "2026-03-10"), "invalid quotationDate rejected");
ok(!isQuotationDateRangeValid("2026-03-01", "2026-13-01"), "invalid validUntil rejected");
ok(!isQuotationDateRangeValid("garbage", "2026-03-10"), "garbage date rejected");
ok(isValidCalendarDate("2026-02-28"), "2026-02-28 accepted");
ok(!isValidCalendarDate("2026-02-30"), "2026-02-30 rejected (strict, no rollover)");
ok(!isValidCalendarDate("2026-13-01"), "month 13 rejected");
ok(!isValidCalendarDate("2026-04-31"), "April 31 rejected");
ok(!isValidCalendarDate("2026-2-3"), "non-padded rejected");
ok(!isValidCalendarDate("not-a-date"), "garbage rejected");
eq(midnoonDateToCalendarDate(new Date("2026-03-10T12:00:00.000Z")), "2026-03-10", "midnoon rule → stored calendar date");

/* ------------------------------ quantities -------------------------------- */

section("quantity + price laws (§6)");
eq(QUOTATION_QTY_MIN, 1, "minimum quotation qty is 1");
eq(SALES_QUOTATION_QTY_MAX, 1_000_000, "maximum quotation qty is 1,000,000");
ok(isValidQuotationQty(1), "1 is valid");
ok(isValidQuotationQty(1_000_000), "1,000,000 is valid");
ok(!isValidQuotationQty(0), "0 is invalid");
ok(!isValidQuotationQty(-1), "negative is invalid");
ok(!isValidQuotationQty(1.5), "fraction is invalid");
ok(!isValidQuotationQty(Number.NaN), "NaN is invalid");
ok(!isValidQuotationQty(Number.POSITIVE_INFINITY), "Infinity is invalid");
ok(!isValidQuotationQty(1_000_001), "above max is invalid");
ok(!isValidQuotationQty(Number.MAX_SAFE_INTEGER + 1), "unsafe integer is invalid");
ok(isValidPersistedQuotationQty(10) === isValidQuotationQty(10), "persisted law mirrors the input law");
ok(!isValidPersistedQuotationQty(0), "persisted zero qty is corruption");
ok(isValidQuotationPrice(0), "zero price allowed (free item)");
ok(isValidQuotationPrice(9_000_000_000), "max price allowed");
eq(SALES_QUOTATION_PRICE_MAX, 9_000_000_000, "price max constant");
ok(!isValidQuotationPrice(-1), "negative price rejected");
ok(!isValidQuotationPrice(9_000_000_001), "above max price rejected");
ok(!isValidQuotationPrice(1.5), "fractional price rejected");

/* ------------------------------- line cap --------------------------------- */

section("line cap parsing (§11)");
eq(SALES_QUOTATION_LINE_CAP_DEFAULT, 200, "default cap 200");
eq(SALES_QUOTATION_LINE_CAP_MIN, 20, "min cap 20");
eq(SALES_QUOTATION_LINE_CAP_MAX, 500, "max cap 500");
eq(salesQuotationLineCap(undefined), 200, "undefined env → default");
eq(salesQuotationLineCap(null), 200, "null env → default");
eq(salesQuotationLineCap(""), 200, "empty env → default");
eq(salesQuotationLineCap("garbage"), 200, "malformed env → default");
eq(salesQuotationLineCap("19"), 20, "below min → clamped to 20");
eq(salesQuotationLineCap("10"), 20, "far below min → clamped to 20");
eq(salesQuotationLineCap("501"), 500, "above max → clamped to 500");
eq(salesQuotationLineCap("20"), 20, "min boundary accepted");
eq(salesQuotationLineCap("500"), 500, "max boundary accepted");
eq(salesQuotationLineCap("200"), 200, "mid value accepted");

section("line-set completeness invariant (§11)");
assertSalesQuotationLineSetComplete(10, 10, 200); // valid
ok(true, "matching counts pass");
assertSalesQuotationLineSetComplete(20, 20, 20); // at cap, valid
ok(true, "cap-exact counts pass");
throws(() => assertSalesQuotationLineSetComplete(21, 21, 20), "fetched > cap fails", "SalesQuotationIntegrityError");
throws(() => assertSalesQuotationLineSetComplete(10, 21, 20), "counted > cap fails", "SalesQuotationIntegrityError");
// THE mismatch arm: both below the cap but unequal → corruption.
throws(
  () => assertSalesQuotationLineSetComplete(1, 2, 200),
  "count mismatch BELOW cap fails (1 vs 2)",
  "SalesQuotationIntegrityError",
);
throws(
  () => assertSalesQuotationLineSetComplete(19, 20, 20),
  "count mismatch at cap-1 fails",
  "SalesQuotationIntegrityError",
);
eq(SALES_QUOTATION_LINE_CAP_INVARIANT, "SALES_QUOTATION_LINE_CAP_INVARIANT", "stable invariant code");

/* ------------------------------ totals math ------------------------------- */

section("canonical quotation math (§11)");
eq(computeQuotationLineTotalMinor(10, 250), 2500, "10 × 250 = 2500");
eq(computeQuotationLineTotalMinor(1, 0), 0, "free item totals 0");
eq(computeQuotationLineTotalMinor(1_000_000, 9_000_000_000), 9_000_000_000_000_000, "max line total stays safe");
throws(() => computeQuotationLineTotalMinor(0, 100), "invalid qty rejected", "SalesQuotationIntegrityError");
throws(() => computeQuotationLineTotalMinor(1.5, 100), "fractional qty rejected", "SalesQuotationIntegrityError");
throws(() => computeQuotationLineTotalMinor(10, -1), "invalid price rejected", "SalesQuotationIntegrityError");
throws(() => computeQuotationLineTotalMinor(10, 9_000_000_001), "above-max price rejected", "SalesQuotationIntegrityError");
throws(
  () => computeQuotationLineTotalMinor(Number.MAX_SAFE_INTEGER, 1),
  "unsafe-range qty rejected before the product is even computed",
  "SalesQuotationIntegrityError",
);

const manyMaxLines = Array.from({ length: 200 }, () => ({ qty: 1_000_000, unitPriceMinor: 9_000_000_000 }));
throws(() => computeQuotationSubtotalMinor(manyMaxLines), "200 max lines overflow the subtotal", "SalesQuotationTotalOverflowError");
eq(
  computeQuotationSubtotalMinor([
    { qty: 3, unitPriceMinor: 1000 },
    { qty: 2, unitPriceMinor: 500 },
  ]).subtotalMinor,
  4000,
  "subtotal sums line totals",
);
eq(
  computeQuotationSubtotalMinor([
    { qty: 3, unitPriceMinor: 1000 },
    { qty: 2, unitPriceMinor: 500 },
  ]).lineTotalsMinor.join(","),
  "3000,1000",
  "per-line totals returned",
);
eq(
  computeQuotationSubtotalMinor([{ qty: 1_000_000, unitPriceMinor: 9_000_000_000 }]).subtotalMinor,
  9_000_000_000_000_000,
  "single max line subtotal is exactly safe",
);

section("discount law (§11)");
eq(validateQuotationDiscount(0, 4000), 0, "zero discount always valid");
eq(validateQuotationDiscount(4000, 4000), 4000, "discount may equal the subtotal");
throws(() => validateQuotationDiscount(4001, 4000), "discount above subtotal rejected", "SalesQuotationTotalOverflowError");
throws(() => validateQuotationDiscount(-1, 4000), "negative discount rejected", "SalesQuotationTotalOverflowError");
throws(() => validateQuotationDiscount(Number.NaN, 4000), "NaN discount rejected", "SalesQuotationTotalOverflowError");

section("canonical total (§11)");
eq(computeQuotationTotalMinor(4000, 500), 3500, "total = subtotal − discount");
throws(() => computeQuotationTotalMinor(500, 600), "negative result rejected", "SalesQuotationTotalOverflowError");
throws(() => computeQuotationTotalMinor(-1, 0), "negative subtotal rejected", "SalesQuotationIntegrityError");
throws(() => computeQuotationTotalMinor(Number.NaN, 0), "NaN subtotal rejected", "SalesQuotationIntegrityError");
eq(SALES_QUOTATION_TOTAL_OVERFLOW, "SALES_QUOTATION_TOTAL_OVERFLOW", "stable overflow code");
eq(SALES_QUOTATION_CORRUPT_HISTORY, "SALES_QUOTATION_CORRUPT_HISTORY", "stable corrupt-history code");

/* ------------------------------ references -------------------------------- */

section("reference law (§10)");
eq(normalizeSalesQuotationReference("  QT-2026-001  "), "QT-2026-001", "trims whitespace");
eq(normalizeSalesQuotationReference("a  b"), "a b", "pathological whitespace collapsed");
eq(normalizeSalesQuotationReference("a\nb"), null, "newline injection rejected");
eq(normalizeSalesQuotationReference("a\u0000b"), null, "NUL rejected");
eq(normalizeSalesQuotationReference("a"), null, "below min length rejected");
eq(normalizeSalesQuotationReference("ab"), "ab", "min length accepted");
eq(normalizeSalesQuotationReference("x".repeat(81)), null, "above max length rejected");
eq(normalizeSalesQuotationReference("x".repeat(80)), "x".repeat(80), "max length accepted");
eq(normalizeSalesQuotationReference("استعلام ۱"), "استعلام ۱", "Unicode preserved");
eq(normalizeSalesQuotationReference("  "), null, "blank → null (server generates)");

let rngCalls = 0;
const fixedRandom = (max: number) => {
  rngCalls += 1;
  return max - 1;
};
const ref = generateSalesQuotationReference(new Date("2026-10-11T00:00:00Z"), fixedRandom);
ok(ref.startsWith("QT-"), "generated reference carries the QT- quotation prefix");
ok(ref.includes("20261011"), "generated reference carries the UTC date stamp");
eq(ref.length, "QT-20261011-XXXXXX".length, "generated reference shape (QT-<date>-<6>)");
eq(rngCalls, 6, "exactly 6 random draws");
const token = ref.split("-")[2] ?? "";
eq(token.length, 6, "6-character token");
ok(
  ![...token].some((ch) => "ILO01ilo".includes(ch)),
  "ambiguous characters (I/L/O/0/1) excluded from the token alphabet",
);
eq(
  generateSalesQuotationReference(new Date("2026-10-11T00:00:00Z"), fixedRandom),
  ref,
  "deterministic with an injected random source",
);
const ref2 = generateSalesQuotationReference(new Date("2026-10-11T00:00:00Z"), () => 0);
ok(ref2.startsWith("QT-20261011-AAAAAA"), "zero random → first alphabet char repeated");

/* ------------------------------ date window ------------------------------- */

section("date window law (business timezone)");
eq(JSON.stringify(salesQuotationDayWindow(undefined, undefined, "UTC")), "{}", "no bounds → empty window");
eq(salesQuotationDayWindow("2026-02-30", undefined, "UTC"), null, "invalid from → null (422)");
eq(salesQuotationDayWindow(undefined, "2026-13-01", "UTC"), null, "invalid to → null (422)");
const utcWin = salesQuotationDayWindow("2026-10-11", "2026-10-11", "UTC");
ok(utcWin?.gte instanceof Date, "UTC window has gte");
eq(utcWin?.gte?.toISOString(), "2026-10-11T00:00:00.000Z", "from = local midnight (UTC)");
eq(utcWin?.lt?.toISOString(), "2026-10-12T00:00:00.000Z", "to = EXCLUSIVE next-day start (never 23:59:59.999)");
const tehranWin = salesQuotationDayWindow("2026-10-11", "2026-10-11", "Asia/Tehran");
eq(tehranWin?.gte?.toISOString(), "2026-10-10T20:30:00.000Z", "+03:30 window opens the UTC evening before");
eq(tehranWin?.lt?.toISOString(), "2026-10-11T20:30:00.000Z", "+03:30 window closes the UTC evening of the same local day");
const nyWin = salesQuotationDayWindow("2026-10-11", "2026-10-11", "America/New_York");
eq(nyWin?.gte?.toISOString(), "2026-10-11T04:00:00.000Z", "−04:00 window opens the UTC morning after");
ok(
  tehranWin !== null &&
    new Date("2026-10-11T00:15:00+03:30").getTime() >= tehranWin.gte!.getTime(),
  "a record at 00:15 LOCAL belongs to its local date",
);
ok(
  tehranWin !== null &&
    new Date("2026-10-11T00:15:00+03:30").getTime() < tehranWin.lt!.getTime(),
  "00:15 LOCAL is inside the exclusive upper bound",
);
ok(salesQuotationDayWindow("2026-10-12", "2026-10-11", "UTC") !== null, "from > to is a schema-level rejection, not a helper crash");

/* --------------------------------- DTOs ----------------------------------- */

section("DTO laws — line + detail (§16)");
const headerRow = {
  id: "q1",
  reference: "QT-2026-001",
  persistedStatus: "DRAFT" as const,
  effectiveStatus: "DRAFT" as const,
  validUntilCalendarDate: "2026-10-31",
  isExpired: false,
  customerId: "c1",
  customerNameAtQuotation: "Acme",
  currencyCodeAtQuotation: "USD",
  currencySymbolAtQuotation: "$",
  decimalPrecisionAtQuotation: 2,
  quotationDate: new Date("2026-10-01T12:00:00Z"),
  validUntilDate: new Date("2026-10-31T12:00:00Z"),
  expectedDeliveryDate: new Date("2026-11-15T12:00:00Z"),
  discountMinor: 100,
  customerNotes: "Thank you",
  internalNotes: "cost 300",
  createdBy: { id: "u1", name: "Sara" },
  sentAt: null,
  acceptedAt: null,
  rejectedAt: null,
  cancelledAt: null,
  convertedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-02T00:00:00Z"),
};
const lineRow = {
  id: "l1",
  productId: "p1",
  productNameAtQuotation: "Duct Tape",
  skuAtQuotation: "DT-1",
  unitAtQuotation: "piece",
  qty: 10,
  unitPriceMinor: 250,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};
const lineDto = salesQuotationLineDto(lineRow);
eq(lineDto.lineTotalMinor, 2500, "line DTO computes lineTotal canonically");
eq(lineDto.qty, 10, "line DTO qty echoed");
eq(lineDto.productNameAtQuotation, "Duct Tape", "snapshot name projected");
ok(!("businessId" in lineDto) && !("salesQuotationId" in lineDto), "line DTO allowlist (no tenant/internal ids)");

const detail = salesQuotationDetailDto(
  headerRow,
  { lineCount: 1, totalQty: 10, subtotalMinor: 2500, discountMinor: 100, totalMinor: 2400 },
  [lineDto],
  null,
);
eq(detail.quotation.persistedStatus, "DRAFT", "detail persistedStatus explicit");
eq(detail.quotation.effectiveStatus, "DRAFT", "detail effectiveStatus explicit");
eq(detail.summary.totalMinor, 2400, "summary total re-checked = subtotal − discount");
eq(detail.summary.lineCount, 1, "summary lineCount");
eq(detail.convertedOrder, null, "converted order ABSENT when no relation (§7 — never inferred)");
throws(
  () =>
    salesQuotationDetailDto(
      headerRow,
      { lineCount: 1, totalQty: 10, subtotalMinor: 500, discountMinor: 600, totalMinor: -100 },
      [lineDto],
      null,
    ),
  "summary discount > subtotal is rejected by the total re-check",
  "SalesQuotationTotalOverflowError",
);
const detailWithOrder = salesQuotationDetailDto(
  headerRow,
  { lineCount: 1, totalQty: 10, subtotalMinor: 2500, discountMinor: 100, totalMinor: 2400 },
  [lineDto],
  { id: "so1", reference: "SO-1", status: "CONFIRMED" },
);
eq(detailWithOrder.convertedOrder?.reference, "SO-1", "converted order DTO present when the relation exists");
const qKeys = Object.keys(detail.quotation).sort().join(",");
ok(!qKeys.includes("businessId"), "businessId never exposed on the wire");
ok(!qKeys.includes("createdByUserId"), "createdByUserId never exposed (createdBy projection only)");
eq(detail.quotation.createdBy?.name, "Sara", "creator name projection");
ok(detail.quotation.internalNotes === "cost 300", "detail exposes internalNotes to authorized STAFF views only");

section("DTO integrity: corrupted status + missing snapshots (§8/§12)");
throws(
  () => salesQuotationLineDto({ ...lineRow, qty: 0 }),
  "persisted zero qty is corruption in the DTO",
  "SalesQuotationIntegrityError",
);
throws(
  () => salesQuotationLineDto({ ...lineRow, productNameAtQuotation: "" }),
  "missing product snapshot is corruption (§12)",
  "SalesQuotationIntegrityError",
);
throws(
  () =>
    salesQuotationDetailDto(
      { ...headerRow, customerId: "c1", customerNameAtQuotation: "" },
      { lineCount: 1, totalQty: 10, subtotalMinor: 2500, discountMinor: 100, totalMinor: 2400 },
      [lineDto],
      null,
    ),
  "missing customer snapshot (linked customer) is corruption",
  "SalesQuotationIntegrityError",
);
const anonymous = salesQuotationDetailDto(
  { ...headerRow, customerId: null, customerNameAtQuotation: "" },
  { lineCount: 1, totalQty: 10, subtotalMinor: 2500, discountMinor: 0, totalMinor: 2500 },
  [lineDto],
  null,
);
eq(anonymous.quotation.customerNameAtQuotation, "", "anonymous quotation legitimately carries ''");

section("print DTO — reduced customer-facing projection (§16)");
const print = salesQuotationPrintDto({
  reference: headerRow.reference,
  quotationDate: headerRow.quotationDate,
  validUntilDate: headerRow.validUntilDate,
  customerNameAtQuotation: headerRow.customerNameAtQuotation,
  currencyCodeAtQuotation: headerRow.currencyCodeAtQuotation,
  currencySymbolAtQuotation: headerRow.currencySymbolAtQuotation,
  decimalPrecisionAtQuotation: headerRow.decimalPrecisionAtQuotation,
  expectedDeliveryDate: headerRow.expectedDeliveryDate,
  customerNotes: headerRow.customerNotes,
  lines: [
    {
      productNameAtQuotation: "Duct Tape",
      skuAtQuotation: "DT-1",
      unitAtQuotation: "piece",
      qty: 10,
      unitPriceMinor: 250,
      lineTotalMinor: 2500,
    },
  ],
  subtotalMinor: 2500,
  discountMinor: 100,
  totalMinor: 2400,
});
const printKeys = Object.keys(print);
ok(!printKeys.includes("internalNotes"), "print DTO omits internalNotes (no key at all)");
ok(!printKeys.includes("id"), "print DTO omits database ids");
ok(!printKeys.includes("persistedStatus") && !printKeys.includes("effectiveStatus"), "print DTO omits raw technical statuses");
eq(print.customerNotes, "Thank you", "customerNotes present when set");
eq(print.lines[0].lineTotalMinor, 2500, "print line totals carried");
eq(print.totalMinor, 2400, "print total carried");

section("entity-360 DTOs (§19)");
const custRow = customerRecentSalesQuotationDto({
  id: "q1",
  reference: "QT-1",
  persistedStatus: "SENT",
  effectiveStatus: "EXPIRED",
  quotationDate: new Date("2026-10-01T12:00:00Z"),
  currencyCodeAtQuotation: "IRR",
  currencySymbolAtQuotation: "﷼",
  decimalPrecisionAtQuotation: 0,
  totalMinor: 5000,
  totalQty: 5,
  convertedOrderReference: null,
});
eq(custRow.currencyCodeAtQuotation, "IRR", "quotation currency snapshot carried");
eq(custRow.effectiveStatus, "EXPIRED", "effective status explicit on the 360 row");
eq(custRow.convertedOrderReference, null, "no converted order projected when absent");
const custConverted = customerRecentSalesQuotationDto({
  id: "q2",
  reference: "QT-2",
  persistedStatus: "CONVERTED",
  effectiveStatus: "CONVERTED",
  quotationDate: new Date("2026-10-01T12:00:00Z"),
  currencyCodeAtQuotation: "USD",
  currencySymbolAtQuotation: "$",
  decimalPrecisionAtQuotation: 2,
  totalMinor: 100,
  totalQty: 1,
  convertedOrderReference: "SO-9",
});
eq(custConverted.convertedOrderReference, "SO-9", "converted order reference projected when present");
const prodRow = productRecentSalesQuotationDto({
  id: "q1",
  reference: "QT-1",
  customerNameAtQuotation: "Acme",
  persistedStatus: "ACCEPTED",
  effectiveStatus: "ACCEPTED",
  quotationDate: new Date("2026-10-01T12:00:00Z"),
  qty: 5,
});
const prodKeys = Object.keys(prodRow);
eq(prodRow.qty, 5, "product-history qty carried");
ok(
  !prodKeys.some((k) => k.toLowerCase().includes("minor") || k.toLowerCase().includes("price") || k.toLowerCase().includes("total")),
  "product quotation history is MONEY-FREE (§72/§19 quantities only)",
);

/* ----------------------------- error codes -------------------------------- */

section("error code contract (§22)");
const REQUIRED_CODES = [
  "SALES_QUOTATION_NOT_FOUND",
  "SALES_QUOTATION_DUPLICATE_REFERENCE",
  "SALES_QUOTATION_INVALID_STATUS",
  "SALES_QUOTATION_INVALID_PERSISTED_STATUS",
  "SALES_QUOTATION_INVALID_TRANSITION",
  "SALES_QUOTATION_EMPTY",
  "SALES_QUOTATION_LINE_LIMIT_REACHED",
  "SALES_QUOTATION_LINE_CAP_INVARIANT",
  "SALES_QUOTATION_DUPLICATE_PRODUCT",
  "SALES_QUOTATION_EXPIRED",
  "SALES_QUOTATION_NOT_EXPIRED",
  "SALES_QUOTATION_INVALID_DATE_RANGE",
  "SALES_QUOTATION_TOTAL_OVERFLOW",
  "SALES_QUOTATION_IMMUTABLE",
  "SALES_QUOTATION_ALREADY_CONVERTED",
  "SALES_QUOTATION_NOT_ACCEPTED",
  "SALES_QUOTATION_CORRUPT_HISTORY",
  "SALES_QUOTATION_FOREIGN_ENTITY",
  "SALES_QUOTATION_CUSTOMER_NOT_FOUND",
  "SALES_QUOTATION_PRODUCT_NOT_FOUND",
  "SALES_QUOTATION_LINE_NOT_FOUND",
  "INVALID_DISCOUNT",
];
for (const code of REQUIRED_CODES) {
  ok(Object.values(SALES_QUOTATION_ERROR_CODES).includes(code as never), `code present: ${code}`);
}
ok(
  new Set(Object.values(SALES_QUOTATION_ERROR_CODES)).size === Object.values(SALES_QUOTATION_ERROR_CODES).length,
  "no duplicate code strings in the vocabulary",
);

/* --------------------------------- zod ------------------------------------ */

section("zod: create schema — authority fields rejected (§15/§112)");
const parsedCreate = salesQuotationCreateSchema.parse({
  customerId: " c1 ",
  reference: "  QT-1  ",
  validUntilDate: "2026-10-31",
  quotationDate: "2026-10-11",
  discountMinor: 0,
  customerNotes: "  hello  ",
});
eq(parsedCreate.customerId, "c1", "customerId trimmed");
eq(parsedCreate.reference, "QT-1", "reference normalized");
eq(parsedCreate.customerNotes, "hello", "customerNotes trimmed");
ok(salesQuotationCreateSchema.safeParse({ validUntilDate: "2026-10-31", internalNotes: "cost" }).success, "minimal create is valid (no quotationDate → server default)");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", status: "SENT" }), "status injection rejected (strict)");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", businessId: "b1" }), "businessId injection rejected (strict)");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", createdByUserId: "u1" }), "createdByUserId injection rejected (strict)");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", currencyCodeAtQuotation: "EUR" }), "currency snapshot injection rejected (strict)");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", convertedAt: "2026-01-01T00:00:00Z" }), "convertedAt injection rejected (strict)");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", customerNameAtQuotation: "Fake" }), "customer snapshot injection rejected");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", subtotalMinor: 500 }), "computed subtotal injection rejected");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", totalMinor: 500 }), "computed total injection rejected");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", sentAt: "2026-01-01T00:00:00Z" }), "lifecycle timestamp injection rejected");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", sourceQuotationId: "x" }), "order-link injection rejected");
throws(() => salesQuotationCreateSchema.parse({ quotationDate: "2026-10-11" }), "validUntilDate is REQUIRED");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-02-30" }), "invalid calendar validUntil rejected");
throws(() => salesQuotationCreateSchema.parse({ validUntilDate: "2026-10-31", discountMinor: -5 }), "negative discount rejected");

section("zod: update schema (§10)");
ok(salesQuotationUpdateSchema.safeParse({ discountMinor: 100 }).success, "discount-only patch valid");
ok(salesQuotationUpdateSchema.safeParse({ customerId: null }).success, "explicit customer clear valid");
ok(salesQuotationUpdateSchema.safeParse({ internalNotes: "hint" }).success, "internal notes patch valid");
throws(() => salesQuotationUpdateSchema.parse({}), "empty patch rejected (nothing to update)");
throws(() => salesQuotationUpdateSchema.parse({ status: "CANCELLED" }), "status is never patchable");
throws(() => salesQuotationUpdateSchema.parse({ acceptedAt: new Date().toISOString() }), "lifecycle timestamps never patchable");
throws(() => salesQuotationUpdateSchema.parse({ convertedSalesOrderId: "x" }), "order link never patchable");

section("zod: line schemas (§6/§11)");
const parsedLine = salesQuotationLineCreateSchema.parse({ productId: " p1 ", qty: 5 });
eq(parsedLine.productId, "p1", "productId trimmed");
eq(parsedLine.unitPriceMinor, undefined, "price optional (defaults server-side §6)");
throws(() => salesQuotationLineCreateSchema.parse({ productId: "p1", qty: 0 }), "zero qty rejected");
throws(() => salesQuotationLineCreateSchema.parse({ productId: "p1", qty: 1.5 }), "fractional qty rejected");
throws(() => salesQuotationLineCreateSchema.parse({ productId: "p1", qty: -1 }), "negative qty rejected");
throws(() => salesQuotationLineCreateSchema.parse({ productId: "p1", qty: 1_000_001 }), "above-max qty rejected");
throws(() => salesQuotationLineCreateSchema.parse({ productId: "p1", qty: 5, unitPriceMinor: -1 }), "negative price rejected");
throws(() => salesQuotationLineCreateSchema.parse({ productId: "p1", qty: 5, unitPriceMinor: 9_000_000_001 }), "above-max price rejected");
throws(() => salesQuotationLineCreateSchema.parse({ productId: "p1", qty: 5, productNameAtQuotation: "Fake" }), "snapshot injection rejected");
throws(() => salesQuotationLineCreateSchema.parse({ qty: 5 }), "productId required");
ok(salesQuotationLineUpdateSchema.safeParse({ qty: 10 }).success, "qty-only update valid");
ok(salesQuotationLineUpdateSchema.safeParse({ unitPriceMinor: 300 }).success, "price-only update valid");
throws(() => salesQuotationLineUpdateSchema.parse({}), "empty line update rejected");
throws(() => salesQuotationLineUpdateSchema.parse({ productId: "p2" }), "product reassignment rejected");

section("zod: list query + export locale (§15)");
ok(salesQuotationListQuerySchema.safeParse({ status: "ALL" }).success, "ALL accepted");
ok(!salesQuotationListQuerySchema.safeParse({ status: "PAID" }).success, "Sale payment status rejected as quotation filter");
ok(!salesQuotationListQuerySchema.safeParse({ status: "CONFIRMED" }).success, "SalesOrder status rejected as quotation filter");
ok(salesQuotationListQuerySchema.safeParse({ status: "EXPIRED" }).success, "EXPIRED accepted (closed vocabulary)");
ok(!salesQuotationListQuerySchema.safeParse({ from: "2026-02-30" }).success, "invalid from rejected");
ok(!salesQuotationListQuerySchema.safeParse({ from: "2026-10-10", to: "2026-10-09" }).success, "from > to rejected");
ok(!salesQuotationListQuerySchema.safeParse({ pageSize: "500" }).success, "pageSize above 100 rejected");
eq(salesQuotationListQuerySchema.parse({ pageSize: "100" }).pageSize, 100, "pageSize 100 accepted (max bound)");
ok(!salesQuotationListQuerySchema.safeParse({ page: "0" }).success, "page 0 rejected");
eq(salesQuotationListQuerySchema.parse({ page: "3" }).page, 3, "page coerced");
ok(salesQuotationExportQuerySchema.safeParse({ locale: "fa" }).success, "export locale fa accepted");
ok(!salesQuotationExportQuerySchema.safeParse({ locale: "fr" }).success, "export locale fr rejected (strict)");

/* --------------------------------- i18n ----------------------------------- */

section("i18n parity (EN/FA) for the salesQuotations namespace");
function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? flattenKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}
import { createRequire } from "node:module";
import path from "node:path";
const esmRequire = createRequire(path.join(process.cwd(), "package.json"));
const en = esmRequire("./src/i18n/messages/en") as { default: Record<string, unknown> };
const fa = esmRequire("./src/i18n/messages/fa") as { default: Record<string, unknown> };
const enKeys = flattenKeys((en.default as Record<string, unknown>).salesQuotations as Record<string, unknown>);
const faKeys = flattenKeys((fa.default as Record<string, unknown>).salesQuotations as Record<string, unknown>);
ok(enKeys.length >= 100, `EN salesQuotations keys present (${enKeys.length})`);
eq(enKeys.length, faKeys.length, "EN/FA key count parity");
const missingInFa = enKeys.filter((k) => !faKeys.includes(k));
eq(missingInFa.length, 0, `no EN key missing in FA${missingInFa.length ? `: ${missingInFa.slice(0, 3).join(",")}` : ""}`);
const missingInEn = faKeys.filter((k) => !enKeys.includes(k));
eq(missingInEn.length, 0, `no FA key missing in EN${missingInEn.length ? `: ${missingInEn.slice(0, 3).join(",")}` : ""}`);
const faMessages = (fa.default as Record<string, Record<string, Record<string, string>>>).salesQuotations;
const persianTerms: Array<[string, string]> = [
  ["title", "استعلام قیمت"],
  ["status_DRAFT", "پیش‌نویس"],
  ["status_SENT", "ارسال‌شده"],
  ["status_ACCEPTED", "پذیرفته‌شده"],
  ["status_REJECTED", "ردشده"],
  ["status_EXPIRED", "منقضی‌شده"],
  ["status_CANCELLED", "لغوشده"],
  ["status_CONVERTED", "تبدیل‌شده"],
  ["convertAction", "تبدیل به سفارش فروش"],
];
for (const [key, expected] of persianTerms) {
  eq(faMessages[key], expected, `FA professional terminology: ${key}`);
}
for (const status of SALES_QUOTATION_STATUSES) {
  ok(enKeys.includes(`status_${status}`), `EN status label present: status_${status}`);
  ok(faKeys.includes(`status_${status}`), `FA status label present: status_${status}`);
}
const csvKeys = enKeys.filter((k) => k.startsWith("csv"));
ok(csvKeys.length >= 14, `CSV header keys present (${csvKeys.length})`);
ok(csvKeys.every((k) => faKeys.includes(k)), "FA carries every CSV header key");

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
