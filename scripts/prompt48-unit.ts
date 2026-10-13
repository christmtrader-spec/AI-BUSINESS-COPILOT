/**
 * Prompt 48 — UNIT TEST SUITE. Pure domain laws + contracts (NO server,
 * NO database — runs with `bun` directly; types/schema/dto are client-safe
 * pure modules, so the server-only shim is NOT required — verified).
 *
 * Run: bun scripts/prompt48-unit.ts
 *
 * Counted assertions only: every ok()/eq()/throws() call executes for real.
 * Coverage: closed 3-status vocabulary + parseSupplierBillStatus (INVALID
 * PERSISTED STATUS ≠ DRAFT §10) · FULL transition matrix (every (from,to)
 * pair; POSTED/CANCELLED reject all) · billedQty bounds 1..1_000_000 (§6) ·
 * unitPriceMinor bounds 0..1_000_000_000 with zero allowed (§8, P41 §29) ·
 * exact integer line math (BigInt intermediate, safe-integer result law) ·
 * canonical totals math (subtotal = Σ lineTotalMinor, discount ≤ subtotal,
 * PRICE/TOTAL_OVERFLOW, INVALID_DISCOUNT) · THE ONE three-way matching law
 * available = received − returned − previouslyBilled with CORRUPT_HISTORY
 * never clamped (§7) · line cap env parsing 20..500 default 200 (§11) ·
 * reference normalization + SB-<date>-<token> generation (§12/§13) ·
 * strict calendar dates + UTC-midnoon law (Prompt-35 §84) · PO billing gate
 * (§17) · lifecycle editability gates (§10) · error-code contract (§21) ·
 * zod boundary schemas (.strict() authority-field rejection, qty/price
 * bounds, preserving-law line patch, immutable relation keys) · DTO
 * allowlist mappers (payable only when linked, corrupted-status integrity,
 * lineCount law) · EN/FA i18n parity for the supplierBills namespace.
 */
import {
  SUPPLIER_BILL_STATUSES,
  SUPPLIER_BILL_TRANSITIONS,
  SUPPLIER_BILL_ERROR_CODES,
  SUPPLIER_BILL_LINE_CAP_DEFAULT,
  SUPPLIER_BILL_LINE_CAP_MIN,
  SUPPLIER_BILL_LINE_CAP_MAX,
  BILLED_QTY_MIN,
  BILLED_QTY_MAX,
  BILL_UNIT_PRICE_MINOR_MIN,
  BILL_UNIT_PRICE_MINOR_MAX,
  SUPPLIER_BILL_INVALID_PERSISTED_STATUS,
  SUPPLIER_BILL_CORRUPT_HISTORY,
  SupplierBillStatusIntegrityError,
  SupplierBillMatchingIntegrityError,
  isSupplierBillStatus,
  parseSupplierBillStatus,
  canTransitionSupplierBill,
  isValidBilledQty,
  isValidBillUnitPriceMinor,
  computeBillLineTotalMinor,
  computeSupplierBillTotals,
  computeAvailableBillableQty,
  quantityFitsAvailable,
  priceVarianceMinor,
  supplierBillLineCap,
  normalizeSupplierBillReference,
  normalizeSupplierInvoiceReference,
  generateSupplierBillReference,
  isValidCalendarDate,
  calendarDateToUtcMidnoon,
  utcMidnoonToCalendarDate,
  purchaseOrderIsBillable,
  supplierBillLinesEditable,
  supplierBillIsReadOnly,
} from "../src/lib/supplier-bills/types";
import {
  mapSupplierBillListItem,
  mapSupplierBillLine,
  mapSupplierBillDetail,
} from "../src/lib/supplier-bills/dto";
import {
  supplierBillCreateSchema,
  supplierBillUpdateSchema,
  supplierBillLineAddSchema,
  supplierBillLineUpdateSchema,
} from "../src/lib/supplier-bills/schema";

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

console.log("=== Prompt 48 unit suite (supplier bills & accounts payable) ===");

/* ----------------------------- lifecycle ---------------------------------- */

section("closed status vocabulary (§10)");
eq(SUPPLIER_BILL_STATUSES.length, 3, "three lifecycle statuses");
eq(SUPPLIER_BILL_STATUSES.join(","), "DRAFT,POSTED,CANCELLED", "vocabulary is exactly DRAFT,POSTED,CANCELLED (closed set)");
ok(isSupplierBillStatus("DRAFT"), "isSupplierBillStatus accepts DRAFT");
ok(isSupplierBillStatus("POSTED"), "isSupplierBillStatus accepts POSTED");
ok(isSupplierBillStatus("CANCELLED"), "isSupplierBillStatus accepts CANCELLED");
ok(!isSupplierBillStatus("OPEN"), "OPEN is NOT a supplier-bill status");
ok(!isSupplierBillStatus("PAID"), "PAID is NOT a supplier-bill status");
ok(!isSupplierBillStatus("draft"), "lowercase is not a status");
ok(!isSupplierBillStatus("posted"), "lowercase POSTED is not a status");
ok(!isSupplierBillStatus(""), "empty string is not a status");
ok(!isSupplierBillStatus("DRAFT "), "trailing-space value is not a status");
ok(!isSupplierBillStatus(null as unknown as string), "null is not a status");
ok(!isSupplierBillStatus(undefined as unknown as string), "undefined is not a status");
ok(!isSupplierBillStatus(5 as unknown as string), "a number is not a status");

section("parseSupplierBillStatus — INVALID PERSISTED STATUS ≠ DRAFT (§10)");
eq(parseSupplierBillStatus("DRAFT"), "DRAFT", "valid DRAFT parses to the exact token");
eq(parseSupplierBillStatus("POSTED"), "POSTED", "valid POSTED parses to the exact token");
eq(parseSupplierBillStatus("CANCELLED"), "CANCELLED", "valid CANCELLED parses to the exact token");
throws(() => parseSupplierBillStatus("OPEN"), "persisted OPEN throws (never a silent DRAFT)", "SupplierBillStatusIntegrityError");
throws(() => parseSupplierBillStatus("PAID"), "persisted PAID throws", "SupplierBillStatusIntegrityError");
throws(() => parseSupplierBillStatus(""), "persisted empty string throws", "SupplierBillStatusIntegrityError");
throws(() => parseSupplierBillStatus("draft"), "lowercase persisted value never silently accepted", "SupplierBillStatusIntegrityError");
let statusErr: SupplierBillStatusIntegrityError | null = null;
try {
  parseSupplierBillStatus("OPEN");
} catch (e) {
  statusErr = e as SupplierBillStatusIntegrityError;
}
ok(statusErr instanceof SupplierBillStatusIntegrityError, "OPEN throws the exact integrity class");
if (statusErr) {
  eq(statusErr.code, SUPPLIER_BILL_INVALID_PERSISTED_STATUS, "integrity error code is SUPPLIER_BILL_INVALID_PERSISTED_STATUS");
  eq(statusErr.name, "SupplierBillStatusIntegrityError", "integrity error carries its class name");
  eq(statusErr.value, "OPEN", "integrity error records the offending value");
} else {
  ok(false, "integrity error code check ran (no error thrown)");
  ok(false, "integrity error name check ran (no error thrown)");
  ok(false, "integrity error value check ran (no error thrown)");
}
eq(SUPPLIER_BILL_INVALID_PERSISTED_STATUS, "SUPPLIER_BILL_INVALID_PERSISTED_STATUS", "stable integrity code constant");

/* -------------------------- FULL transition matrix ------------------------ */

section("FULL transition matrix (§10) — every (from,to) pair");
const ALL_BILL_STATUSES = [...SUPPLIER_BILL_STATUSES];
const BILL_LEGAL: Array<[string, string]> = [
  ["DRAFT", "POSTED"],
  ["DRAFT", "CANCELLED"],
];
for (const from of ALL_BILL_STATUSES) {
  for (const to of ALL_BILL_STATUSES) {
    const isLegalPair = BILL_LEGAL.some(([f, t]) => f === from && t === to);
    eq(
      canTransitionSupplierBill(from as never, to as never),
      isLegalPair,
      `${from} → ${to} ${isLegalPair ? "allowed" : "rejected"}`,
    );
  }
}
eq(SUPPLIER_BILL_TRANSITIONS.DRAFT.join(","), "POSTED,CANCELLED", "DRAFT transitions: POSTED, CANCELLED");
eq(SUPPLIER_BILL_TRANSITIONS.POSTED.length, 0, "POSTED is immutable — no outgoing transitions (§10)");
eq(SUPPLIER_BILL_TRANSITIONS.CANCELLED.length, 0, "CANCELLED is terminal — no outgoing transitions");

/* ------------------------------ quantities -------------------------------- */

section("billedQty bounds — integer 1..1_000_000 (§6)");
eq(BILLED_QTY_MIN, 1, "BILLED_QTY_MIN is 1");
eq(BILLED_QTY_MAX, 1_000_000, "BILLED_QTY_MAX is 1_000_000");
ok(isValidBilledQty(1), "billedQty 1 valid (lower bound)");
ok(isValidBilledQty(7), "billedQty 7 valid");
ok(isValidBilledQty(1_000_000), "billedQty 1_000_000 valid (upper bound)");
ok(!isValidBilledQty(0), "billedQty 0 invalid");
ok(!isValidBilledQty(-1), "billedQty −1 invalid");
ok(!isValidBilledQty(1.5), "fractional billedQty invalid");
ok(!isValidBilledQty(NaN), "NaN billedQty invalid");
ok(!isValidBilledQty(Infinity), "Infinity billedQty invalid");
ok(!isValidBilledQty(1_000_001), "billedQty above max invalid");
ok(!isValidBilledQty("5" as unknown as number), "string billedQty invalid (typeof number law)");
ok(!isValidBilledQty(null as unknown as number), "null billedQty invalid");

section("unitPriceMinor bounds — integer 0..1_000_000_000, zero ALLOWED (§8, P41 §29)");
eq(BILL_UNIT_PRICE_MINOR_MIN, 0, "BILL_UNIT_PRICE_MINOR_MIN is 0 (zero allowed)");
eq(BILL_UNIT_PRICE_MINOR_MAX, 1_000_000_000, "BILL_UNIT_PRICE_MINOR_MAX is 1_000_000_000");
ok(isValidBillUnitPriceMinor(0), "unitPriceMinor 0 valid (free-item line law)");
ok(isValidBillUnitPriceMinor(1_000_000_000), "unitPriceMinor 1_000_000_000 valid (upper bound)");
ok(!isValidBillUnitPriceMinor(-1), "unitPriceMinor −1 invalid (a line never acts as a discount)");
ok(!isValidBillUnitPriceMinor(1.5), "fractional unitPriceMinor invalid");
ok(!isValidBillUnitPriceMinor(1_000_000_001), "unitPriceMinor above max invalid");
ok(!isValidBillUnitPriceMinor(NaN), "NaN unitPriceMinor invalid");
ok(!isValidBillUnitPriceMinor(Infinity), "Infinity unitPriceMinor invalid");

/* --------------------------- exact money math ----------------------------- */

section("§8 exact integer line math — BigInt intermediate, safe-integer result");
eq(computeBillLineTotalMinor(3, 2500), 7500, "3 × 2500 = 7500 exact");
eq(computeBillLineTotalMinor(0, 500), 0, "0 × 500 = 0 — zero line total is NOT thrown by this function (zero-total is a POSTING policy)");
eq(computeBillLineTotalMinor(1_000_000, 1_000_000_000), 1_000_000_000_000_000, "max-bounds product 10^15 stays EXACT via BigInt (still a safe integer — no false overflow)");
throws(() => computeBillLineTotalMinor(10_000_000, 1_000_000_000), "product beyond MAX_SAFE_INTEGER throws", "SUPPLIER_BILL_PRICE_OVERFLOW");
throws(() => computeBillLineTotalMinor(1_000_000, 9_100_000_000), "10^15 × 9.1 beyond MAX_SAFE_INTEGER throws", "SUPPLIER_BILL_PRICE_OVERFLOW");

section("§9 canonical totals — subtotal = Σ lineTotalMinor, total = subtotal − discount");
const happy = computeSupplierBillTotals(
  [{ lineTotalMinor: 1000 }, { lineTotalMinor: 2000 }, { lineTotalMinor: 300 }],
  0,
);
eq(happy.lineCount, 3, "lineCount equals the number of lines");
eq(happy.subtotalMinor, 3300, "subtotal = Σ lineTotalMinor");
eq(happy.totalMinor, 3300, "discount 0 ok: total = subtotal − 0");
eq(computeSupplierBillTotals([{ lineTotalMinor: 1000 }, { lineTotalMinor: 2000 }, { lineTotalMinor: 300 }], 300).totalMinor, 3000, "discount applied: total = 3300 − 300");
eq(computeSupplierBillTotals([{ lineTotalMinor: 2500 }], 2500).totalMinor, 0, "discount === subtotal → total 0 (ZERO_TOTAL is caller policy, math allows it)");
throws(() => computeSupplierBillTotals([{ lineTotalMinor: 2500 }], 2501), "discount > subtotal throws", "SUPPLIER_BILL_INVALID_DISCOUNT");
throws(() => computeSupplierBillTotals([{ lineTotalMinor: 2500 }], -1), "negative discount throws", "SUPPLIER_BILL_INVALID_DISCOUNT");
throws(() => computeSupplierBillTotals([{ lineTotalMinor: 2500 }], 1.5), "fractional discount throws", "SUPPLIER_BILL_INVALID_DISCOUNT");
throws(() => computeSupplierBillTotals([{ lineTotalMinor: -1 }], 0), "negative lineTotal throws", "SUPPLIER_BILL_PRICE_OVERFLOW");
throws(() => computeSupplierBillTotals([{ lineTotalMinor: 1.5 }], 0), "non-safe-integer lineTotal throws", "SUPPLIER_BILL_PRICE_OVERFLOW");
throws(() => computeSupplierBillTotals([{ lineTotalMinor: NaN }], 0), "NaN lineTotal throws", "SUPPLIER_BILL_PRICE_OVERFLOW");
throws(
  () => computeSupplierBillTotals([{ lineTotalMinor: Number.MAX_SAFE_INTEGER }, { lineTotalMinor: 1 }], 0),
  "subtotal overflow beyond MAX_SAFE_INTEGER throws (MAX_SAFE + 1)",
  "SUPPLIER_BILL_TOTAL_OVERFLOW",
);

/* --------------------- §7 three-way quantity matching --------------------- */

section("§7 THE ONE three-way matching law — available = received − returned − billed");
eq(
  computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: 10, previouslyBilledQty: 20 }),
  30,
  "ordered 100 / received 60 / returned 10 / billed 20 → available 30",
);
eq(
  computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: 60, previouslyBilledQty: 0 }),
  0,
  "returned === received → 0 left to bill",
);
eq(
  computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: 10, previouslyBilledQty: 50 }),
  0,
  "billed === net received → exactly 0 available (exact fit is legal)",
);
eq(
  computeAvailableBillableQty({ orderedQty: 0, receivedQty: 0, returnedQty: 0, previouslyBilledQty: 0 }),
  0,
  "all-zero aggregates → 0 available",
);

section("§7 corruption policy — integrity errors, NEVER clamped");
let corruptErr: SupplierBillMatchingIntegrityError | null = null;
try {
  computeAvailableBillableQty({ orderedQty: 100, receivedQty: 120, returnedQty: 0, previouslyBilledQty: 0 });
} catch (e) {
  corruptErr = e as SupplierBillMatchingIntegrityError;
}
ok(corruptErr instanceof SupplierBillMatchingIntegrityError, "received > ordered THROWS (no 0/negative result is ever returned)");
if (corruptErr) {
  eq(corruptErr.code, SUPPLIER_BILL_CORRUPT_HISTORY, "corrupt-history code for received > ordered");
} else {
  ok(false, "corrupt-history code check ran (no error thrown)");
}
corruptErr = null;
try {
  computeAvailableBillableQty({ orderedQty: 100, receivedQty: 50, returnedQty: 60, previouslyBilledQty: 0 });
} catch (e) {
  corruptErr = e as SupplierBillMatchingIntegrityError;
}
ok(corruptErr instanceof SupplierBillMatchingIntegrityError, "returned > received THROWS (never clamped)");
if (corruptErr) {
  eq(corruptErr.code, SUPPLIER_BILL_CORRUPT_HISTORY, "corrupt-history code for returned > received");
} else {
  ok(false, "corrupt-history code check ran (no error thrown)");
}
corruptErr = null;
try {
  computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: 10, previouslyBilledQty: 55 });
} catch (e) {
  corruptErr = e as SupplierBillMatchingIntegrityError;
}
ok(corruptErr instanceof SupplierBillMatchingIntegrityError, "previouslyBilled > net received THROWS (never clamped)");
if (corruptErr) {
  eq(corruptErr.code, SUPPLIER_BILL_CORRUPT_HISTORY, "corrupt-history code for billed > net received");
} else {
  ok(false, "corrupt-history code check ran (no error thrown)");
}
eq(SUPPLIER_BILL_CORRUPT_HISTORY, "SUPPLIER_BILL_CORRUPT_HISTORY", "stable corrupt-history code constant");

section("§7 input validation — negative and non-integer aggregates are corruption");
throws(() => computeAvailableBillableQty({ orderedQty: -1, receivedQty: 0, returnedQty: 0, previouslyBilledQty: 0 }), "negative orderedQty throws", "SupplierBillMatchingIntegrityError");
throws(() => computeAvailableBillableQty({ orderedQty: 100, receivedQty: -1, returnedQty: 0, previouslyBilledQty: 0 }), "negative receivedQty throws", "SupplierBillMatchingIntegrityError");
throws(() => computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: -1, previouslyBilledQty: 0 }), "negative returnedQty throws", "SupplierBillMatchingIntegrityError");
throws(() => computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: 10, previouslyBilledQty: -1 }), "negative previouslyBilledQty throws", "SupplierBillMatchingIntegrityError");
throws(() => computeAvailableBillableQty({ orderedQty: 1.5, receivedQty: 0, returnedQty: 0, previouslyBilledQty: 0 }), "non-integer orderedQty throws", "SupplierBillMatchingIntegrityError");
throws(() => computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60.5, returnedQty: 0, previouslyBilledQty: 0 }), "non-integer receivedQty throws", "SupplierBillMatchingIntegrityError");
throws(() => computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: 0.5, previouslyBilledQty: 0 }), "non-integer returnedQty throws", "SupplierBillMatchingIntegrityError");
throws(() => computeAvailableBillableQty({ orderedQty: 100, receivedQty: 60, returnedQty: 10, previouslyBilledQty: 1.5 }), "non-integer previouslyBilledQty throws", "SupplierBillMatchingIntegrityError");

section("§7 quantity fits the available remainder");
ok(quantityFitsAvailable(30, 30), "30 fits 30 available (exact fit)");
ok(!quantityFitsAvailable(31, 30), "31 does NOT fit 30 available (over-bill)");
ok(quantityFitsAvailable(0, 0), "0 fits 0 available");

/* ------------------------------- variance --------------------------------- */

section("§8 price variance — signed, never normalized");
eq(priceVarianceMinor(2500, 2000), 500, "invoiced above PO → +500 variance");
eq(priceVarianceMinor(2000, 2500), -500, "invoiced below PO → NEGATIVE variance is preserved (signed: 2000 − 2500 = −500)");
eq(priceVarianceMinor(500, 2500), -2000, "a larger below-PO gap stays signed (500 − 2500 = −2000, never normalized)");
eq(priceVarianceMinor(2500, 2500), 0, "equal prices → 0 variance");

/* ------------------------------- line cap --------------------------------- */

section("§11 SUPPLIER_BILL_MAX_LINES env parsing — default safely, clamp, never unbounded");
eq(SUPPLIER_BILL_LINE_CAP_DEFAULT, 200, "default cap is 200");
eq(SUPPLIER_BILL_LINE_CAP_MIN, 20, "cap floor is 20");
eq(SUPPLIER_BILL_LINE_CAP_MAX, 500, "cap ceiling is 500");
eq(supplierBillLineCap(undefined), 200, "undefined env → default 200");
eq(supplierBillLineCap(null), 200, "null env → default 200");
eq(supplierBillLineCap("abc"), 200, "malformed env → default 200");
eq(supplierBillLineCap("5"), 20, "5 clamped up to floor 20");
eq(supplierBillLineCap("0"), 20, "0 clamped up to floor 20");
eq(supplierBillLineCap("-10"), 20, "negative clamped up to floor 20");
eq(supplierBillLineCap("99999"), 500, "99999 clamped down to ceiling 500");
eq(supplierBillLineCap("50"), 50, "in-range 50 passes through");

/* ------------------------------ references -------------------------------- */

section("§12 bill reference normalization — trim/collapse/control-char rejection");
eq(normalizeSupplierBillReference("  AB-12  "), "AB-12", "surrounding whitespace trimmed");
eq(normalizeSupplierBillReference("AB    12"), "AB 12", "pathological whitespace runs collapsed to one space");
eq(normalizeSupplierBillReference("AB\n12"), null, "newline control char rejected");
eq(normalizeSupplierBillReference("AB\t12"), null, "tab control char rejected");
eq(normalizeSupplierBillReference("AB\u000012"), null, "NUL control char rejected");
eq(normalizeSupplierBillReference("A"), null, "1 visible char below MIN(2) rejected");
eq(normalizeSupplierBillReference("A".repeat(81)), null, "81 visible chars above MAX(80) rejected");
eq(normalizeSupplierBillReference("A".repeat(80)), "A".repeat(80), "80 visible chars accepted");
eq(normalizeSupplierBillReference(""), null, "empty → null (caller generates SB-…)");
eq(normalizeSupplierBillReference("   "), null, "whitespace-only → null");

section("§12 supplier invoice reference normalization — separate 1..80 length law");
eq(normalizeSupplierInvoiceReference("A"), "A", "invoice ref: 1 char OK (an invoice number may be a single token)");
eq(normalizeSupplierInvoiceReference("I".repeat(80)), "I".repeat(80), "invoice ref: 80 chars OK");
eq(normalizeSupplierInvoiceReference("I".repeat(81)), null, "invoice ref: 81 chars rejected");
eq(normalizeSupplierInvoiceReference("IN\n9"), null, "invoice ref: control char rejected");
eq(normalizeSupplierInvoiceReference(""), null, "invoice ref: empty → null");
eq(normalizeSupplierInvoiceReference("  INV   9  "), "INV 9", "invoice ref: trim + collapse");

section("§13 server-generated reference SB-<YYYYMMDD>-<6 unambiguous base32>");
const FIXED_DATE = new Date("2026-10-13T12:00:00.000Z");
eq(generateSupplierBillReference(FIXED_DATE, () => 0), "SB-20261013-AAAAAA", "seeded random 0 → alphabet[0] ×6 (A) with the fixed UTC date");
eq(generateSupplierBillReference(FIXED_DATE, (max) => max - 1), "SB-20261013-999999", "seeded random max−1 → alphabet tail ×6 (9)");
ok(/^SB-\d{8}-[A-HJ-NP-Z2-9]{6}$/.test(generateSupplierBillReference(FIXED_DATE, () => 0)), "generated reference matches /^SB-\\d{8}-[A-HJ-NP-Z2-9]{6}$/");
ok(/^SB-\d{8}-[A-HJ-NP-Z2-9]{6}$/.test(generateSupplierBillReference(FIXED_DATE, (max) => max - 1)), "last-char reference also matches the format law");
let allTokens = "";
let allSeedsMatch = true;
for (let i = 0; i < 31; i += 1) {
  const ref = generateSupplierBillReference(FIXED_DATE, () => i);
  allTokens += ref.slice(-6);
  if (!/^SB-\d{8}-[A-HJ-NP-Z2-9]{6}$/.test(ref)) allSeedsMatch = false;
}
ok(allSeedsMatch, "every alphabet index produces a format-valid reference (6-char token)");
ok(!/[ILO01]/.test(allTokens), "alphabet excludes ambiguous I/L/O/0/1");
eq(allTokens.length, 186, "31 alphabet positions × 6-char tokens swept");

/* --------------------------- calendar-date law ---------------------------- */

section("date-only calendar law (Prompt-35 §84) — strict, NO rollover");
eq(isValidCalendarDate("2026-02-31"), false, "2026-02-31 rejected (no month rollover)");
eq(isValidCalendarDate("2026-13-01"), false, "month 13 rejected");
eq(isValidCalendarDate("2024-02-29"), true, "2024-02-29 accepted (leap year)");
eq(isValidCalendarDate("2026-02-30"), false, "2026-02-30 rejected");
eq(isValidCalendarDate("2023-02-29"), false, "2023-02-29 rejected (non-leap)");
eq(isValidCalendarDate("2026-2-3"), false, "non-padded YYYY-M-D format rejected");
ok(isValidCalendarDate("2026-10-13"), "plain valid calendar date accepted");
eq(calendarDateToUtcMidnoon("2026-10-13").toISOString(), "2026-10-13T12:00:00.000Z", "calendar day normalizes to the canonical UTC-midnoon instant");
eq(utcMidnoonToCalendarDate(new Date("2026-10-13T12:00:00.000Z")), "2026-10-13", "inverse: stored instant → its YYYY-MM-DD calendar day");
eq(utcMidnoonToCalendarDate(calendarDateToUtcMidnoon("2024-02-29")), "2024-02-29", "roundtrip stable for the leap day");

/* ------------------------------- PO gates --------------------------------- */

section("§17 PO billing gate — CONFIRMED/CLOSED only");
eq(purchaseOrderIsBillable("CONFIRMED"), true, "CONFIRMED is billable");
eq(purchaseOrderIsBillable("CLOSED"), true, "CLOSED is billable (already-received quantities survive a pure close)");
eq(purchaseOrderIsBillable("DRAFT"), false, "DRAFT never billable");
eq(purchaseOrderIsBillable("SENT"), false, "SENT never billable");
eq(purchaseOrderIsBillable("CANCELLED"), false, "CANCELLED never billable");
eq(purchaseOrderIsBillable("confirmed"), false, "lowercase never accepted");

section("§10 lifecycle gates — editability per status");
eq(supplierBillLinesEditable("DRAFT"), true, "DRAFT lines/header editable");
eq(supplierBillLinesEditable("POSTED"), false, "POSTED lines frozen");
eq(supplierBillLinesEditable("CANCELLED"), false, "CANCELLED lines frozen");
eq(supplierBillIsReadOnly("DRAFT"), false, "DRAFT not read-only");
eq(supplierBillIsReadOnly("POSTED"), true, "POSTED read-only (immutable in this phase)");
eq(supplierBillIsReadOnly("CANCELLED"), true, "CANCELLED read-only (terminal)");

/* ----------------------------- error codes -------------------------------- */

section("§21 error-code contract — closed map, non-empty stable strings");
const EXPECTED_ERROR_KEYS = [
  "NOT_FOUND",
  "DUPLICATE_REFERENCE",
  "DUPLICATE_INVOICE_REFERENCE",
  "INVALID_STATUS",
  "INVALID_PERSISTED_STATUS",
  "INVALID_TRANSITION",
  "IMMUTABLE",
  "EMPTY",
  "LINE_LIMIT",
  "LINE_CAP_INVARIANT",
  "DUPLICATE_PO_LINE",
  "INVALID_QUANTITY",
  "QUANTITY_EXCEEDS_RECEIVED",
  "QUANTITY_EXCEEDS_AVAILABLE",
  "RETURNED_QUANTITY",
  "PRICE_OVERFLOW",
  "TOTAL_OVERFLOW",
  "CURRENCY_MISMATCH",
  "ZERO_TOTAL",
  "ALREADY_POSTED",
  "ALREADY_LINKED",
  "CORRUPT_HISTORY",
  "FOREIGN_ENTITY",
  "LINKED_EXPENSE_IMMUTABLE",
  "INVALID_DISCOUNT",
  "PO_NOT_BILLABLE",
  "PO_LINE_MISMATCH",
  "SUPPLIER_MISMATCH",
];
eq(
  Object.keys(SUPPLIER_BILL_ERROR_CODES).sort().join(","),
  [...EXPECTED_ERROR_KEYS].sort().join(","),
  "SUPPLIER_BILL_ERROR_CODES contains EXACTLY the 28 contract keys",
);
for (const key of EXPECTED_ERROR_KEYS) {
  const code = (SUPPLIER_BILL_ERROR_CODES as Record<string, unknown>)[key];
  ok(typeof code === "string" && code.length > 0, `error code ${key} is a non-empty string`);
}
eq(SUPPLIER_BILL_ERROR_CODES.INVALID_PERSISTED_STATUS, SUPPLIER_BILL_INVALID_PERSISTED_STATUS, "INVALID_PERSISTED_STATUS reuses the integrity-law constant");
eq(SUPPLIER_BILL_ERROR_CODES.CORRUPT_HISTORY, SUPPLIER_BILL_CORRUPT_HISTORY, "CORRUPT_HISTORY reuses the matching-law constant");

/* ---------------------------- zod boundaries ------------------------------ */

section("zod boundary — supplierBillCreateSchema .strict() rejects injected authority fields (§15)");
const MIN_CREATE = { purchaseOrderId: "abc12345", billDate: "2026-10-13" };
ok(supplierBillCreateSchema.safeParse(MIN_CREATE).success, "minimal valid create accepted ({purchaseOrderId, billDate})");
const AUTHORITY_FIELDS: Array<[string, unknown]> = [
  ["status", "POSTED"],
  ["supplierId", "sup-x"],
  ["currencyCodeAtBill", "IRR"],
  ["totalMinor", 7500],
  ["subtotalMinor", 7500],
  ["expenseId", "exp-x"],
  ["postedAt", "2026-10-13T12:00:00.000Z"],
  ["createdByUserId", "user-x"],
  ["lineTotalMinor", 7500],
];
for (const [field, value] of AUTHORITY_FIELDS) {
  ok(
    !supplierBillCreateSchema.safeParse({ ...MIN_CREATE, [field]: value }).success,
    `create rejects injected authority field: ${field}`,
  );
}
throws(
  () => supplierBillCreateSchema.parse({ ...MIN_CREATE, status: "POSTED" }),
  "injected status throws ZodError at the boundary (.strict())",
  "ZodError",
);
ok(!supplierBillCreateSchema.safeParse({ ...MIN_CREATE, billDate: "2026-02-31" }).success, "create rejects impossible billDate 2026-02-31");
ok(!supplierBillCreateSchema.safeParse({ ...MIN_CREATE, billDate: "not-a-date" }).success, "create rejects non-calendar billDate");
eq(supplierBillCreateSchema.parse({ ...MIN_CREATE, reference: "  AB-12  " }).reference, "AB-12", "create normalizes the reference server-side");

section("zod boundary — supplierBillLineAddSchema bounds (§6/§8)");
const MIN_LINE = { purchaseOrderLineId: "poline-1", billedQty: 5, unitPriceMinor: 2500 };
ok(supplierBillLineAddSchema.safeParse(MIN_LINE).success, "minimal valid line accepted");
ok(!supplierBillLineAddSchema.safeParse({ ...MIN_LINE, billedQty: 0 }).success, "line add rejects billedQty 0");
ok(!supplierBillLineAddSchema.safeParse({ ...MIN_LINE, billedQty: -1 }).success, "line add rejects billedQty −1");
ok(!supplierBillLineAddSchema.safeParse({ ...MIN_LINE, billedQty: 1.5 }).success, "line add rejects fractional billedQty");
ok(!supplierBillLineAddSchema.safeParse({ ...MIN_LINE, unitPriceMinor: -1 }).success, "line add rejects negative unitPriceMinor");
ok(supplierBillLineAddSchema.safeParse({ ...MIN_LINE, unitPriceMinor: 0 }).success, "line add accepts unitPriceMinor 0 (free-item law)");
ok(!supplierBillLineAddSchema.safeParse({ ...MIN_LINE, lineTotalMinor: 12500 }).success, "line add rejects injected lineTotalMinor (server-derived)");
ok(!supplierBillLineAddSchema.safeParse({ ...MIN_LINE, unknownKey: "x" }).success, "line add rejects unknown extra keys (.strict())");

section("zod boundary — supplierBillLineUpdateSchema patch semantics");
ok(supplierBillLineUpdateSchema.safeParse({}).success, "empty patch valid (both fields optional)");
ok(supplierBillLineUpdateSchema.safeParse({ unitPriceMinor: 500 }).success, "preserving-law: {unitPriceMinor: 500} alone is a valid patch");
ok(!supplierBillLineUpdateSchema.safeParse({ billedQty: null }).success, "billedQty null rejected");
ok(!supplierBillLineUpdateSchema.safeParse({ billedQty: 0 }).success, "billedQty 0 rejected in the patch too");

section("zod boundary — supplierBillUpdateSchema immutable relations + discount law");
ok(supplierBillUpdateSchema.safeParse({ supplierInvoiceReference: null }).success, "update accepts supplierInvoiceReference null (clear)");
eq(supplierBillUpdateSchema.parse({ supplierInvoiceReference: null }).supplierInvoiceReference, null, "cleared invoice reference parses to null");
eq(supplierBillUpdateSchema.parse({ supplierInvoiceReference: "  INV-9  " }).supplierInvoiceReference, "INV-9", "invoice reference normalized server-side");
for (const field of ["purchaseOrderId", "supplierId", "status", "reference"]) {
  ok(
    !supplierBillUpdateSchema.safeParse({ [field]: "x" }).success,
    `update rejects immutable relation key: ${field}`,
  );
}
ok(!supplierBillUpdateSchema.safeParse({ discountMinor: -1 }).success, "discountMinor −1 rejected");
ok(!supplierBillUpdateSchema.safeParse({ discountMinor: 1.5 }).success, "fractional discountMinor rejected");
ok(!supplierBillCreateSchema.safeParse({ ...MIN_CREATE, discountMinor: -1 }).success, "create also rejects negative discountMinor");
ok(!supplierBillCreateSchema.safeParse({ ...MIN_CREATE, discountMinor: 1.5 }).success, "create also rejects fractional discountMinor");

/* -------------------------------- DTOs ------------------------------------ */

section("DTO mappers — payable only when linked, allowlist, integrity (§16)");
const AT = new Date("2026-10-13T12:00:00.000Z");
function billRowFixture() {
  return {
    id: "bill-1",
    reference: "SB-20261013-AAAAAA",
    supplierInvoiceReference: "INV-9",
    supplierId: "sup-1",
    supplierNameAtBill: "Acme Parts",
    purchaseOrderId: "po-1",
    purchaseOrderReferenceAtBill: "PO-20261010-AAAAAA",
    status: "DRAFT",
    billDate: AT,
    dueDate: AT,
    currencyCodeAtBill: "IRR",
    currencySymbolAtBill: "﷼",
    decimalPrecisionAtBill: 0,
    subtotalMinor: 7500,
    discountMinor: 0,
    totalMinor: 7500,
    createdAt: AT,
    _count: { lines: 2 },
  };
}
const draftItem = mapSupplierBillListItem(billRowFixture());
eq(draftItem.status, "DRAFT", "list item parses the persisted status");
eq(draftItem.payable, null, "DRAFT bill with expense undefined → payable null (a draft never fabricates a payable)");
eq(draftItem.lineCount, 2, "list item lineCount from _count.lines");
eq(draftItem.billDate, AT.toISOString(), "billDate exposed as ISO-8601 UTC string");
const postedItem = mapSupplierBillListItem({
  ...billRowFixture(),
  status: "POSTED",
  expense: { id: "exp-1", amountMinor: 10000, paidMinor: 4000, status: "PARTIAL" },
});
ok(postedItem.payable !== null, "POSTED bill with a linked expense → payable present");
eq(postedItem.payable?.outstandingMinor, 6000, "payable outstanding = amountMinor − paidMinor (10000 − 4000 = 6000)");
eq(postedItem.payable?.expenseId, "exp-1", "payable exposes the linked Expense id");
eq(postedItem.payable?.paidMinor, 4000, "payable paidMinor passthrough");
eq(postedItem.payable?.status, "PARTIAL", "payable status passthrough");
let listCorruptErr: unknown = null;
let listCorruptThrew = false;
try {
  mapSupplierBillListItem({ ...billRowFixture(), status: "OPEN" });
} catch (e) {
  listCorruptThrew = true;
  listCorruptErr = e;
}
ok(listCorruptThrew && listCorruptErr instanceof SupplierBillStatusIntegrityError, "corrupted persisted status OPEN THROWS in the list mapper (INVALID ≠ DRAFT)");

const lineRow = {
  id: "line-1",
  purchaseOrderLineId: "pol-1",
  productId: "prod-1",
  billedQty: 3,
  unitPriceMinor: 2500,
  lineTotalMinor: 7500,
  productNameAtBill: "Steel Bolt M8",
  skuAtBill: "BOLT-M8",
  unitAtBill: "piece",
  purchaseOrderUnitPriceMinor: 2400,
  createdAt: AT,
  updatedAt: AT,
};
const lineDto = mapSupplierBillLine(lineRow);
eq(lineDto.billedQty, 3, "line DTO passthrough billedQty");
eq(lineDto.unitPriceMinor, 2500, "line DTO passthrough unitPriceMinor");
eq(lineDto.lineTotalMinor, 7500, "line DTO passthrough server-derived lineTotalMinor");
eq(lineDto.productNameAtBill, "Steel Bolt M8", "line DTO snapshot name passthrough");
eq(lineDto.skuAtBill, "BOLT-M8", "line DTO snapshot sku passthrough");
eq(lineDto.unitAtBill, "piece", "line DTO snapshot unit passthrough");
eq(lineDto.purchaseOrderUnitPriceMinor, 2400, "line DTO carries the PO unit price (variance is display-derived)");
eq(lineDto.createdAt, "2026-10-13T12:00:00.000Z", "line DTO createdAt is an ISO-8601 string");
eq(lineDto.updatedAt, "2026-10-13T12:00:00.000Z", "line DTO updatedAt is an ISO-8601 string");

const lineDtos = [
  lineDto,
  mapSupplierBillLine({ ...lineRow, id: "line-2", billedQty: 2, lineTotalMinor: 5000 }),
];
const { _count: _dropCount, ...detailRowBase } = billRowFixture();
const detailRow = { ...detailRowBase, internalNotes: "warehouse note", postedAt: null, cancelledAt: null, updatedAt: AT };
const detail = mapSupplierBillDetail(detailRow, lineDtos, null, []);
eq(detail.lineCount, lineDtos.length, "detail lineCount === lines.length");
eq(detail.lineCount, 2, "detail lineCount is exactly 2");
eq(detail.internalNotes, "warehouse note", "detail internalNotes passthrough");
eq(detail.status, "DRAFT", "detail parses the persisted status");
eq(detail.postedAt, null, "detail postedAt null for a draft");
eq(detail.payable, null, "detail payable null when none passed");
eq(detail.payments.length, 0, "detail payments passthrough (empty)");
eq(detail.createdBy, null, "detail createdBy null when createdByUser absent");
throws(
  () => mapSupplierBillDetail({ ...detailRow, status: "PAID" }, lineDtos, null, []),
  "detail mapper throws on corrupted persisted status",
  "SupplierBillStatusIntegrityError",
);

/* --------------------------------- i18n ----------------------------------- */

section("i18n parity (EN/FA) for the supplierBills namespace");
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
const enMsg = en.default as Record<string, Record<string, unknown>>;
const faMsg = fa.default as Record<string, Record<string, unknown>>;
const enBills = enMsg.supplierBills;
const faBills = faMsg.supplierBills;
const enKeys = flattenKeys(enBills);
const faKeys = flattenKeys(faBills);
ok(enKeys.length >= 60, `EN supplierBills keys present (${enKeys.length})`);
eq(enKeys.length, faKeys.length, "EN/FA key count parity");
const missingInFa = enKeys.filter((k) => !faKeys.includes(k));
eq(missingInFa.length, 0, `no EN key missing in FA${missingInFa.length ? `: ${missingInFa.slice(0, 3).join(",")}` : ""}`);
const missingInEn = faKeys.filter((k) => !enKeys.includes(k));
eq(missingInEn.length, 0, `no FA key missing in EN${missingInEn.length ? `: ${missingInEn.slice(0, 3).join(",")}` : ""}`);
ok(typeof enMsg.nav.supplierBills === "string" && enMsg.nav.supplierBills.length > 0, "EN nav.supplierBills exists");
ok(typeof faMsg.nav.supplierBills === "string" && faMsg.nav.supplierBills.length > 0, "FA nav.supplierBills exists");
eq(faMsg.nav.supplierBills as string, "صورت\u200cحساب تأمین\u200cکنندگان", "FA nav label is the professional Persian term");
// Portability datasets (actual path in the message tree: notifications.datasets).
const enDatasets = ((enMsg.notifications?.datasets ?? enMsg.portability?.datasets) ?? null) as Record<string, unknown> | null;
const faDatasets = ((faMsg.notifications?.datasets ?? faMsg.portability?.datasets) ?? null) as Record<string, unknown> | null;
ok(enDatasets !== null && "supplierBills" in enDatasets, "EN portability datasets: supplierBills key exists");
ok(enDatasets !== null && "supplierBillLines" in enDatasets, "EN portability datasets: supplierBillLines key exists");
ok(faDatasets !== null && "supplierBills" in faDatasets, "FA portability datasets: supplierBills key exists");
ok(faDatasets !== null && "supplierBillLines" in faDatasets, "FA portability datasets: supplierBillLines key exists");
eq(faDatasets?.supplierBillLines as string, "بندهای صورت\u200cحساب تأمین\u200cکننده", "FA portability dataset label is Persian");
// Search integration: group + per-status labels.
const enSearchGroups = enMsg.search.groups as Record<string, unknown>;
const faSearchGroups = faMsg.search.groups as Record<string, unknown>;
ok("SUPPLIER_BILL" in enSearchGroups, "EN search groups.SUPPLIER_BILL exists");
ok("SUPPLIER_BILL" in faSearchGroups, "FA search groups.SUPPLIER_BILL exists");
eq(faSearchGroups.SUPPLIER_BILL as string, "صورت\u200cحساب تأمین\u200cکنندگان", "FA search group label is Persian");
const enSearchStatus = enMsg.search.status as Record<string, unknown>;
const faSearchStatus = faMsg.search.status as Record<string, unknown>;
for (const status of SUPPLIER_BILL_STATUSES) {
  ok(status in enSearchStatus, `EN search status label present: ${status}`);
  ok(status in faSearchStatus, `FA search status label present: ${status}`);
}
for (const status of SUPPLIER_BILL_STATUSES) {
  ok(`status_${status}` in enBills, `EN supplierBills status label present: status_${status}`);
  ok(`status_${status}` in faBills, `FA supplierBills status label present: status_${status}`);
}
eq(faBills.status_DRAFT as string, "پیش\u200cنویس", "FA status_DRAFT terminology");
eq(faBills.status_POSTED as string, "ثبت\u200cشده", "FA status_POSTED terminology");
eq(faBills.status_CANCELLED as string, "لغوشده", "FA status_CANCELLED terminology");
eq(faBills.title as string, "صورت\u200cحساب تأمین\u200cکنندگان", "FA supplierBills.title terminology");

/* ------------------------------- summary ---------------------------------- */

if (failed > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(`\nprompt48-unit: ${passed}/${passed + failed} assertions passed`);
if (failed > 0) process.exit(1);
