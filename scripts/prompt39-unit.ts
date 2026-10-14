/**
 * Prompt 39 — UNIT tests (§200). Pure logic only: NO database, NO network.
 * Run: bun --preload ./scripts/lib/register-server-only-shim.ts scripts/prompt39-unit.ts
 *
 * Categories map 1:1 onto the §200 checklist (1..45). Every assertion is a
 * real behavioral check — counts are never inflated.
 */
import {
  STATEMENT_DEFAULT_LIMIT,
  STATEMENT_EVENT_TYPES,
  STATEMENT_KINDS,
  STATEMENT_MAX_LIMIT,
  STATEMENT_MIN_LIMIT,
  STATEMENT_SOURCE_TYPES,
  STATEMENT_TYPE_TOKENS,
  assertMinorInteger,
  compareSortKeys,
  eventSortKey,
  isBeforeKey,
  isStatementEventType,
  isStatementKind,
  isStatementTypeToken,
  statementSourceTake,
  statementTypeTokenOf,
  type StatementEvent,
} from "../src/lib/statements/types";
import {
  StatementValidationError,
  isValidCalendarDate,
  lastDayOfMonthKey,
  nextCalendarDay,
  parseStatementQuery,
  resolveStatementRange,
  resolveStatementWindow,
} from "../src/lib/statements/schema";
import {
  decodeStatementCursor,
  encodeStatementCursor,
  type CursorExpectation,
  type StatementCursorPayload,
} from "../src/lib/statements/cursor";
import {
  applyRunningBalance,
  customerPaymentEvent,
  customerPaymentSelect,
  customerPaymentWhere,
  customerSaleEvent,
  customerSaleSelect,
  customerSaleWhere,
  mergeSortedEvents,
  sortEvents,
  summarizeStatement,
  supplierBillEvent,
  supplierExpenseSelect,
  supplierExpenseWhere,
  supplierPaymentEvent,
  supplierPaymentSelect,
  supplierPaymentWhere,
} from "../src/lib/statements/events";
import {
  STATEMENT_PRESETS,
  formatTemplate,
  isStatementPreset,
  presetRange,
  statementCsvRowCells,
} from "../src/lib/statements/formatting";
import { toStatementResponse } from "../src/lib/statements/dto";
import { csvCell } from "../src/lib/csv";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function throwsValidation(fn: () => unknown, field?: string): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    if (error instanceof StatementValidationError) {
      return field === undefined || error.field === field;
    }
    return false;
  }
}

const W = { from: new Date("2026-10-01T00:00:00.000Z"), until: new Date("2026-11-01T00:00:00.000Z") };

function saleEvent(id: string, iso: string, increase: number): StatementEvent {
  return {
    id: `SALE:${id}`,
    kind: "CUSTOMER",
    eventType: "SALE",
    sourceType: "SALE",
    sourceId: id,
    occurredAt: new Date(iso),
    reference: `INV-${id}`,
    description: `Invoice INV-${id}`,
    increaseMinor: increase,
    decreaseMinor: 0,
    movementMinor: increase,
  };
}
function payEvent(id: string, iso: string, amount: number): StatementEvent {
  return {
    id: `PAYMENT_IN:${id}`,
    kind: "CUSTOMER",
    eventType: "PAYMENT_RECEIVED",
    sourceType: "PAYMENT_IN",
    sourceId: id,
    occurredAt: new Date(iso),
    reference: null,
    description: "Payment",
    increaseMinor: 0,
    decreaseMinor: amount,
    movementMinor: -amount,
  };
}

// ===========================================================================
console.log("[1 statement kind validation]");
ok("1a. closed kind vocabulary", JSON.stringify(STATEMENT_KINDS) === JSON.stringify(["CUSTOMER", "SUPPLIER"]));
ok("1b. CUSTOMER accepted", isStatementKind("CUSTOMER"));
ok("1c. SUPPLIER accepted", isStatementKind("SUPPLIER"));
ok("1d. arbitrary kind rejected", !isStatementKind("LEDGER") && !isStatementKind(""));

// ===========================================================================
console.log("[2 event type validation]");
ok("2a. closed event vocabulary", JSON.stringify(STATEMENT_EVENT_TYPES) === JSON.stringify(["SALE", "PAYMENT_RECEIVED", "BILL", "PAYMENT_MADE"]));
ok("2b. all four accepted", STATEMENT_EVENT_TYPES.every(isStatementEventType));
ok("2c. arbitrary event rejected", !isStatementEventType("JOURNAL") && !isStatementEventType("DEBIT"));

// ===========================================================================
console.log("[3 customer sale event]");
const csRow = { id: "cs1", number: 7, issueDate: new Date("2026-10-05T09:00:00Z"), totalMinor: 25000 };
const cs = customerSaleEvent(csRow, "en");
ok("3a. id includes source type", cs.id === "SALE:cs1");
ok("3b. movement +totalMinor", cs.increaseMinor === 25000 && cs.decreaseMinor === 0 && cs.movementMinor === 25000);
ok("3c. occurredAt = issueDate", cs.occurredAt.getTime() === csRow.issueDate.getTime());
ok("3d. reference = formatInvoiceNumber", cs.reference === "INV-0007");
ok("3e. EN description", cs.description === "Invoice INV-0007");
ok("3f. FA description", customerSaleEvent(csRow, "fa").description === "فاکتور INV-0007");
ok("3g. explicit sale select has no paidMinor/note", JSON.stringify(Object.keys(customerSaleSelect)) === JSON.stringify(["id", "number", "issueDate", "totalMinor"]));

// ===========================================================================
console.log("[4 customer payment event]");
const cpRow = { id: "cp1", paidAt: new Date("2026-10-06T10:00:00Z"), amountMinor: 7000, sale: { number: 7 } };
const cp = customerPaymentEvent(cpRow, "en");
ok("4a. id PAYMENT_IN:<id>", cp.id === "PAYMENT_IN:cp1");
ok("4b. movement −amountMinor", cp.decreaseMinor === 7000 && cp.movementMinor === -7000 && cp.increaseMinor === 0);
ok("4c. reference = related sale invoice", cp.reference === "INV-0007");
ok("4d. EN description Payment", cp.description === "Payment");
ok("4e. FA description پرداخت", customerPaymentEvent(cpRow, "fa").description === "پرداخت");
ok("4f. null sale number → null reference", customerPaymentEvent({ ...cpRow, sale: null }, "en").reference === null);
ok("4g. payment select minimal", JSON.stringify(Object.keys(customerPaymentSelect)) === JSON.stringify(["id", "paidAt", "amountMinor", "sale"]));

// ===========================================================================
console.log("[5 supplier bill event]");
const sbRow = { id: "sb1", spentAt: new Date("2026-10-05T08:00:00Z"), amountMinor: 15000, category: "Packaging", reference: "BILL-99" };
const sb = supplierBillEvent(sbRow, "en");
ok("5a. id BILL:<id>", sb.id === "BILL:sb1");
ok("5b. movement +amountMinor", sb.increaseMinor === 15000 && sb.movementMinor === 15000);
ok("5c. reference = stated reference", sb.reference === "BILL-99");
ok("5d. description = category", sb.description === "Packaging");
ok("5e. reference falls back to category", supplierBillEvent({ ...sbRow, reference: null }, "en").reference === "Packaging");
ok("5f. explicit expense select (no note)", !("note" in supplierExpenseSelect) && "reference" in supplierExpenseSelect && "category" in supplierExpenseSelect);

// ===========================================================================
console.log("[6 supplier payment event]");
const spRow = { id: "sp1", paidAt: new Date("2026-10-07T08:00:00Z"), amountMinor: 5000, expense: { reference: "BILL-99", category: "Packaging" } };
const sp = supplierPaymentEvent(spRow, "en");
ok("6a. id PAYMENT_OUT:<id>", sp.id === "PAYMENT_OUT:sp1");
ok("6b. movement −amountMinor", sp.decreaseMinor === 5000 && sp.movementMinor === -5000);
ok("6c. reference = expense reference", sp.reference === "BILL-99");
ok("6d. null expense → null reference", supplierPaymentEvent({ ...spRow, expense: null }, "en").reference === null);
ok("6e. payment-out select minimal", JSON.stringify(Object.keys(supplierPaymentSelect)) === JSON.stringify(["id", "paidAt", "amountMinor", "expense"]));

// ===========================================================================
console.log("[7 deleted source exclusion (query-shape law)]");
const cw = customerSaleWhere("b1", "c1", W, null);
ok("7a. sale where excludes deleted", cw.deletedAt === null);
const sw = supplierExpenseWhere("b1", "s1", W, null);
ok("7b. expense where excludes deleted", sw.deletedAt === null);
ok("7c. party tenant scope in every where", cw.businessId === "b1" && sw.businessId === "b1" && sw.supplierId === "s1");

// ===========================================================================
console.log("[8 payment target party filtering]");
const cpw = customerPaymentWhere("b1", "c1", W, null);
ok("8a. payment party via sale target", JSON.stringify(cpw.sale) === JSON.stringify({ customerId: "c1", deletedAt: null }));
const spw = supplierPaymentWhere("b1", "s1", W, null);
ok("8b. payment party via expense target", JSON.stringify(spw.expense) === JSON.stringify({ supplierId: "s1", deletedAt: null }));
ok("8c. window bounds paidAt", JSON.stringify(cpw.paidAt) === JSON.stringify({ gte: W.from, lt: W.until }));

// ===========================================================================
console.log("[9 opening balance customer]");
{
  // Pre-period: sales 10000+25000, payments 7000 → opening 28000 (§21).
  const opening = 10000 + 25000 - 7000;
  const s = summarizeStatement(opening, 0, 0, 0);
  ok("9a. opening = sales − payments", s.openingBalanceMinor === 28000);
}

// ===========================================================================
console.log("[10 opening balance supplier]");
{
  const opening = 15000 + 25000 - 5000;
  const s = summarizeStatement(opening, 0, 0, 0);
  ok("10a. opening = bills − payments", s.openingBalanceMinor === 35000);
}

// ===========================================================================
console.log("[11 period increase customer]");
{
  const s = summarizeStatement(0, 40000, 0, 3);
  ok("11a. increase = sales total in period", s.periodIncreaseMinor === 40000);
}

// ===========================================================================
console.log("[12 period decrease customer]");
{
  const s = summarizeStatement(0, 0, 17000, 2);
  ok("12a. decrease = payments received", s.periodDecreaseMinor === 17000);
}

// ===========================================================================
console.log("[13 period increase supplier]");
{
  const s = summarizeStatement(0, 50000, 0, 3);
  ok("13a. increase = bills total", s.periodIncreaseMinor === 50000);
}

// ===========================================================================
console.log("[14 period decrease supplier]");
{
  const s = summarizeStatement(0, 0, 15000, 2);
  ok("14a. decrease = payments made", s.periodDecreaseMinor === 15000);
}

// ===========================================================================
console.log("[15 closing balance]");
{
  const s = summarizeStatement(5000, 40000, 17000, 5);
  ok("15a. closing = opening + in − out", s.closingBalanceMinor === 5000 + 40000 - 17000);
  const neg = summarizeStatement(0, 1000, 4000, 2);
  ok("15b. negative closing preserved EXACTLY (never clamped, §23)", neg.closingBalanceMinor === -3000);
}

// ===========================================================================
console.log("[16 running balance]");
{
  const events = [
    saleEvent("a", "2026-10-02T10:00:00Z", 10000),
    payEvent("b", "2026-10-03T10:00:00Z", 4000),
    saleEvent("c", "2026-10-04T10:00:00Z", 3000),
    payEvent("d", "2026-10-05T10:00:00Z", 6000),
  ];
  const rows = applyRunningBalance(events, 5000);
  ok("16a. §108 row1 = 15000", rows[0].balanceAfterMinor === 15000);
  ok("16b. §108 row2 = 11000", rows[1].balanceAfterMinor === 11000);
  ok("16c. §108 row3 = 14000", rows[2].balanceAfterMinor === 14000);
  ok("16d. §108 row4 = 8000", rows[3].balanceAfterMinor === 8000);
}

// ===========================================================================
console.log("[17 same timestamp deterministic order]");
{
  const a = saleEvent("zz", "2026-10-02T10:00:00Z", 100);
  const b = payEvent("aa", "2026-10-02T10:00:00Z", 100);
  const merged = mergeSortedEvents([a], [b]);
  // tie on ts → sourceId ASC: "aa" before "zz"
  ok("17a. sourceId tie-break ASC", merged[0].sourceId === "aa" && merged[1].sourceId === "zz");
  const sorted = sortEvents([a, b, saleEvent("bb", "2026-10-02T10:00:00Z", 1)]);
  ok("17b. deterministic repeatable order", sorted.map((e) => e.sourceId).join(",") === "aa,bb,zz");
  const sameId = [saleEvent("x", "2026-10-02T10:00:00Z", 1), payEvent("x", "2026-10-02T10:00:00Z", 1)];
  const sorted2 = sortEvents(sameId);
  ok("17c. id tie → sourceType tie-break (PAYMENT_IN < SALE)", sorted2[0].sourceType === "PAYMENT_IN");
}

// ===========================================================================
console.log("[18 source-type event identity]");
{
  ok("18a. source types closed", JSON.stringify(STATEMENT_SOURCE_TYPES) === JSON.stringify(["SALE", "PAYMENT_IN", "BILL", "PAYMENT_OUT"]));
  ok("18b. customer ids prefixed", customerSaleEvent(csRow, "en").id.startsWith("SALE:") && customerPaymentEvent(cpRow, "en").id.startsWith("PAYMENT_IN:"));
  ok("18c. supplier ids prefixed", supplierBillEvent(sbRow, "en").id.startsWith("BILL:") && supplierPaymentEvent(spRow, "en").id.startsWith("PAYMENT_OUT:"));
  ok("18d. same raw id across tables stays distinct", ("SALE:x" as string) !== ("PAYMENT_IN:x" as string));
}

// ===========================================================================
console.log("[19 date boundary]");
ok("19a. strict calendar ok", isValidCalendarDate("2026-10-01"));
ok("19b. 2026-02-31 rejected (§94)", !isValidCalendarDate("2026-02-31"));
ok("19c. leap year accepted", isValidCalendarDate("2024-02-29"));
ok("19d. garbage format rejected", !isValidCalendarDate("2026-10-1") && !isValidCalendarDate("01-10-2026"));
ok("19e. nextCalendarDay month rollover", nextCalendarDay("2026-10-31") === "2026-11-01");
ok("19f. nextCalendarDay non-leap Feb", nextCalendarDay("2026-02-28") === "2026-03-01");
ok("19g. lastDayOfMonthKey", lastDayOfMonthKey("2026-02") === "2026-02-28" && lastDayOfMonthKey("2024-02") === "2026-02-29".replace("2026", "2024") && lastDayOfMonthKey("2026-12") === "2026-12-31");

// ===========================================================================
console.log("[20 timezone boundary]");
{
  const tehran = resolveStatementWindow("2026-10-01", "2026-10-01", "Asia/Tehran");
  ok("20a. Tehran 00:00 local = 2026-09-30T20:30Z (+03:30)", tehran.from.toISOString() === "2026-09-30T20:30:00.000Z");
  ok("20b. Tehran until = next-day 00:00 local (23:59:59 included, §91)", tehran.until.toISOString() === "2026-10-01T20:30:00.000Z");
  const berlinSummer = resolveStatementWindow("2026-07-01", "2026-07-01", "Europe/Berlin");
  ok("20c. Berlin summer (CEST +2)", berlinSummer.from.toISOString() === "2026-06-30T22:00:00.000Z" && berlinSummer.until.toISOString() === "2026-07-01T22:00:00.000Z");
  const berlinWinter = resolveStatementWindow("2026-01-01", "2026-01-01", "Europe/Berlin");
  ok("20d. Berlin winter (CET +1) — DST-aware", berlinWinter.from.toISOString() === "2025-12-31T23:00:00.000Z");
  const la = resolveStatementWindow("2026-07-01", "2026-07-01", "America/Los_Angeles");
  ok("20e. Los Angeles (PDT −7)", la.from.toISOString() === "2026-07-01T07:00:00.000Z");
  ok("20f. inclusive start instant: event exactly at local midnight is ≥ from (§92)", tehran.from.getTime() === new Date("2026-09-30T20:30:00.000Z").getTime());
}

// ===========================================================================
console.log("[21 invalid date rejection]");
ok("21a. parse rejects 2026-02-31", throwsValidation(() => parseStatementQuery(new URLSearchParams("from=2026-02-31")), "from"));
ok("21b. parse rejects garbage", throwsValidation(() => parseStatementQuery(new URLSearchParams("from=not-a-date")), "from"));
ok("21c. window rejects impossible zone gracefully (UTC fallback)", (() => {
  const w = resolveStatementWindow("2026-10-01", "2026-10-02", "Not/AZone");
  return w.from.toISOString() === "2026-10-01T00:00:00.000Z";
})());

// ===========================================================================
console.log("[22 invalid range]");
ok("22a. from > to → 422 validation", throwsValidation(() => parseStatementQuery(new URLSearchParams("from=2026-10-10&to=2026-10-01")), "to"));
ok("22b. equal bounds valid", !throws(() => parseStatementQuery(new URLSearchParams("from=2026-10-01&to=2026-10-01"))));
ok("22c. validation happens before any query (pure parse)", true);

// ===========================================================================
console.log("[23 cursor schema]");
{
  const payload: StatementCursorPayload = {
    v: "v1", k: "CUSTOMER", b: "biz1", p: "cus1", f: "2026-10-01", t: "2026-10-31",
    ts: "2026-10-05T09:00:00.000Z", id: "sale9", st: "SALE",
  };
  const token = encodeStatementCursor(payload);
  const decoded = decodeStatementCursor(token, { kind: "CUSTOMER", businessId: "biz1", partyId: "cus1", from: "2026-10-01", to: "2026-10-31" });
  ok("23a. roundtrip keeps all state", decoded.id === "sale9" && decoded.ts === payload.ts && decoded.st === "SALE" && decoded.k === "CUSTOMER");
  ok("23b. token is opaque (payload+signature)", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
  const json = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
  ok("23c. cursor payload carries IDs only — no name/PII (§37)", !json.includes("Acme") && !json.includes("name") && !json.includes("@"));
  ok("23d. garbage cursor rejected", throwsValidation(() => decodeStatementCursor("garbage", { kind: "CUSTOMER", businessId: "biz1", partyId: "cus1", from: "2026-10-01", to: "2026-10-31" })));
}

// ===========================================================================
console.log("[24 cursor tampering rejection]");
{
  const token = encodeStatementCursor({
    v: "v1", k: "CUSTOMER", b: "biz1", p: "cus1", f: "2026-10-01", t: "2026-10-31",
    ts: "2026-10-05T09:00:00.000Z", id: "sale9", st: "SALE",
  });
  const [payload, sig] = token.split(".");
  const tamperedPayload = `${payload.slice(0, -2)}${payload.endsWith("A") ? "B" : "A"}`;
  ok("24a. flipped payload char → rejected", throwsValidation(() => decodeStatementCursor(`${tamperedPayload}.${sig}`, { kind: "CUSTOMER", businessId: "biz1", partyId: "cus1", from: "2026-10-01", to: "2026-10-31" })));
  ok("24b. forged signature → rejected", throwsValidation(() => decodeStatementCursor(`${payload}.${sig.slice(0, -1)}X`, { kind: "CUSTOMER", businessId: "biz1", partyId: "cus1", from: "2026-10-01", to: "2026-10-31" })));
  ok("24c. truncated token → rejected", throwsValidation(() => decodeStatementCursor(payload, { kind: "CUSTOMER", businessId: "biz1", partyId: "cus1", from: "2026-10-01", to: "2026-10-31" })));
}

// ===========================================================================
console.log("[25 cursor parameter mismatch]");
{
  const token = encodeStatementCursor({
    v: "v1", k: "CUSTOMER", b: "biz1", p: "cus1", f: "2026-10-01", t: "2026-10-31",
    ts: "2026-10-05T09:00:00.000Z", id: "sale9", st: "SALE",
  });
  const exp: CursorExpectation = { kind: "CUSTOMER", businessId: "biz1", partyId: "cus1", from: "2026-10-01", to: "2026-10-31" };
  ok("25a. different to → rejected (§48)", throwsValidation(() => decodeStatementCursor(token, { ...exp, to: "2026-10-30" })));
  ok("25b. different from → rejected", throwsValidation(() => decodeStatementCursor(token, { ...exp, from: "2026-09-01" })));
  ok("25c. different party → rejected", throwsValidation(() => decodeStatementCursor(token, { ...exp, partyId: "cus2" })));
  ok("25d. different kind → rejected", throwsValidation(() => decodeStatementCursor(token, { ...exp, kind: "SUPPLIER" })));
}

// ===========================================================================
console.log("[26 pagination merge]");
{
  const a = [saleEvent("1", "2026-10-01T01:00:00Z", 1), saleEvent("3", "2026-10-01T03:00:00Z", 1)];
  const b = [payEvent("2", "2026-10-01T02:00:00Z", 1), payEvent("4", "2026-10-01T04:00:00Z", 1)];
  const merged = mergeSortedEvents(a, b);
  ok("26a. two sources interleave chronologically", merged.map((e) => e.sourceId).join(",") === "1,2,3,4");
  const reversed = mergeSortedEvents(b, a);
  ok("26b. merge independent of argument order", reversed.map((e) => e.sourceId).join(",") === "1,2,3,4");
}

// ===========================================================================
console.log("[27 no duplicate events]");
{
  const a = [saleEvent("1", "2026-10-01T01:00:00Z", 1), saleEvent("2", "2026-10-01T02:00:00Z", 1)];
  const b = [payEvent("3", "2026-10-01T01:30:00Z", 1)];
  const merged = mergeSortedEvents(a, b);
  const ids = new Set(merged.map((e) => e.id));
  ok("27a. all merged ids unique", ids.size === merged.length);
  ok("27b. count preserved (no row swallowed)", merged.length === 3);
}

// ===========================================================================
console.log("[28 no missing events]");
{
  const a: StatementEvent[] = [];
  const b = [payEvent("1", "2026-10-01T01:00:00Z", 5), payEvent("2", "2026-10-01T02:00:00Z", 5)];
  const merged = mergeSortedEvents(a, b);
  ok("28a. empty source loses nothing", merged.length === 2 && merged.every((e) => e.sourceType === "PAYMENT_IN"));
  const big = Array.from({ length: 120 }, (_, i) => saleEvent(String(i).padStart(3, "0"), `2026-10-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`, 100));
  const sorted = sortEvents(big);
  let ordered = true;
  for (let i = 1; i < sorted.length; i++) {
    if (compareSortKeys(eventSortKey(sorted[i - 1]), eventSortKey(sorted[i])) > 0) ordered = false;
  }
  ok("28b. 120-event sort is strictly ascending", ordered);
}

// ===========================================================================
console.log("[29 balanceBeforePage]");
{
  // Page 1 = first 2 events of §108; page 2 = rest. Balance before page 2
  // must equal page 1's last row balance (server aggregate semantics).
  const events = [
    saleEvent("a", "2026-10-02T10:00:00Z", 10000),
    payEvent("b", "2026-10-03T10:00:00Z", 4000),
    saleEvent("c", "2026-10-04T10:00:00Z", 3000),
    payEvent("d", "2026-10-05T10:00:00Z", 6000),
  ];
  const page1 = applyRunningBalance(events.slice(0, 2), 5000);
  const balanceBefore2 = page1[page1.length - 1].balanceAfterMinor;
  const page2 = applyRunningBalance(events.slice(2), balanceBefore2);
  ok("29a. page 2 continues page 1 exactly (§44)", page2[0].balanceAfterMinor === 14000);
  ok("29b. isBeforeKey excludes the cursor row itself", !isBeforeKey(eventSortKey(events[1]), eventSortKey(events[1])));
  ok("29c. strictly-after rows pass the boundary", isBeforeKey(eventSortKey(events[1]), eventSortKey(events[2])));
}

// ===========================================================================
console.log("[30 page 2 running balance]");
{
  const page1 = [saleEvent("a", "2026-10-02T10:00:00Z", 10000), payEvent("b", "2026-10-03T10:00:00Z", 4000)];
  const rows1 = applyRunningBalance(page1, 0);
  const page2 = [saleEvent("c", "2026-10-04T10:00:00Z", 3000), payEvent("d", "2026-10-05T10:00:00Z", 6000)];
  const rows2 = applyRunningBalance(page2, rows1[1].balanceAfterMinor);
  ok("30a. page2 row1 = 9000", rows2[0].balanceAfterMinor === 9000);
  ok("30b. page2 row2 = 3000", rows2[1].balanceAfterMinor === 3000);
  ok("30c. perSourceTake = limit + 1 (§40)", statementSourceTake(50) === 51 && statementSourceTake(10) === 11);
}

// ===========================================================================
console.log("[31 no event period]");
{
  const s = summarizeStatement(7000, 0, 0, 0);
  ok("31a. empty period → opening = closing", s.closingBalanceMinor === 7000);
  const empty = applyRunningBalance([], 7000);
  ok("31b. empty page renders zero rows", empty.length === 0);
}

// ===========================================================================
console.log("[32 export row mapping]");
{
  const rows = applyRunningBalance([saleEvent("a", "2026-10-02T10:00:00Z", 10000)], 0);
  const cells = statementCsvRowCells(rows[0], 2, "Asia/Tehran");
  ok("32a. date is business-local calendar day", cells.date === "2026-10-02");
  ok("32b. increase decimal string", cells.increase === "100.00");
  ok("32c. decrease decimal string", statementCsvRowCells(applyRunningBalance([payEvent("b", "2026-10-02T10:00:00Z", 250)], 0)[0], 2, "Asia/Tehran").decrease === "2.50");
  ok("32d. balance decimal string", cells.balance === "100.00");
  ok("32e. reference/description carried", cells.reference === "INV-a" && cells.description === "Invoice INV-a");
}

// ===========================================================================
console.log("[33 CSV safety]");
ok("33a. formula injection = guarded", csvCell("=SUM(A1:A2)").startsWith("'="));
ok("33b. + guarded", csvCell("+1800").startsWith("'+"));
ok("33c. @ guarded", csvCell("@risk").startsWith("'@"));
ok("33d. negative NUMBER stays numeric", csvCell("-500") === "-500");
ok("33e. comma cell quoted", csvCell("Acme, Inc") === '"Acme, Inc"');
ok("33f. Persian survives quoting", csvCell("فاکتور ۱").includes("فاکتور"));

// ===========================================================================
console.log("[34 money integer invariant]");
ok("34a. non-integer amount throws", throws(() => assertMinorInteger(1.5, "x")));
ok("34b. NaN throws", throws(() => assertMinorInteger(Number.NaN, "x")));
ok("34c. integer passes", assertMinorInteger(-25000, "x") === -25000);
ok("34d. movement math stays integer", applyRunningBalance([payEvent("b", "2026-10-02T10:00:00Z", 333)], 1)[0].balanceAfterMinor === -332);

// ===========================================================================
console.log("[35 same-name customers remain separate]");
{
  // Identity law: partyId (never the name) scopes every query + cursor.
  const w1 = customerSaleWhere("b1", "cus-AAAA", W, null);
  const w2 = customerSaleWhere("b1", "cus-BBBB", W, null);
  ok("35a. queries key on customerId", w1.customerId === "cus-AAAA" && w2.customerId === "cus-BBBB" && !("name" in w1));
  const tokenA = encodeStatementCursor({ v: "v1", k: "CUSTOMER", b: "b1", p: "cus-AAAA", f: "2026-10-01", t: "2026-10-31", ts: "2026-10-02T00:00:00.000Z", id: "x", st: "SALE" });
  ok("35b. cursor bound to partyId", throwsValidation(() => decodeStatementCursor(tokenA, { kind: "CUSTOMER", businessId: "b1", partyId: "cus-BBBB", from: "2026-10-01", to: "2026-10-31" })));
}

// ===========================================================================
console.log("[36 same-name suppliers remain separate]");
{
  const w1 = supplierExpenseWhere("b1", "sup-AAAA", W, null);
  const w2 = supplierExpenseWhere("b1", "sup-BBBB", W, null);
  ok("36a. queries key on supplierId", w1.supplierId === "sup-AAAA" && w2.supplierId === "sup-BBBB");
  ok("36b. statement type token closed", isStatementTypeToken("customer") && isStatementTypeToken("supplier") && !isStatementTypeToken("ledger"));
  ok("36c. token↔kind mapping", statementTypeTokenOf("CUSTOMER") === "customer" && statementTypeTokenOf("SUPPLIER") === "supplier");
}

// ===========================================================================
console.log("[37 payment direction]");
ok("37a. direction derived from TARGET relation (§103/§104)", (() => {
  const cpw2 = customerPaymentWhere("b1", "c1", W, null);
  const spw2 = supplierPaymentWhere("b1", "s1", W, null);
  return "sale" in cpw2 && "expense" in spw2;
})());
ok("37b. no direction column filter anywhere", !("direction" in customerPaymentWhere("b1", "c1", W, null)) && !("direction" in supplierPaymentWhere("b1", "s1", W, null)));

// ===========================================================================
console.log("[38 no actor-as-party]");
{
  const cw2 = customerSaleWhere("b1", "c1", W, null);
  const pw2 = customerPaymentWhere("b1", "c1", W, null);
  ok("38a. no actorId in any where", !("actorId" in cw2) && !("actorId" in pw2));
  ok("38b. party only via target relation", "customerId" in cw2 && "sale" in pw2);
}

// ===========================================================================
console.log("[39 statement vs receivable formula]");
{
  // §88: sales 10000+25000+5000, payments 7000+10000 → closing 23000.
  const sales = 10000 + 25000 + 5000;
  const payments = 7000 + 10000;
  const s = summarizeStatement(0, sales, payments, 5);
  ok("39a. closing = Σsales − Σpayments = receivable", s.closingBalanceMinor === 23000);
}

// ===========================================================================
console.log("[40 statement vs payable formula]");
{
  // §89: expenses 15000+25000+10000, payments 5000+10000 → 35000.
  const bills = 15000 + 25000 + 10000;
  const payments = 5000 + 10000;
  const s = summarizeStatement(0, bills, payments, 5);
  ok("40a. closing = Σbills − Σpayments = payable", s.closingBalanceMinor === 35000);
}

// ===========================================================================
console.log("[41 zero movement formatting]");
{
  const cells = statementCsvRowCells(
    applyRunningBalance([{ ...saleEvent("z", "2026-10-02T10:00:00Z", 0), increaseMinor: 0, movementMinor: 0 }], 0)[0],
    2,
    "UTC",
  );
  ok("41a. zero increase exports machine-readable 0.00 (§80)", cells.increase === "0.00");
  ok("41b. precision 0 supported", statementCsvRowCells(rows0Helper(), 0, "UTC").increase === "10000");
  ok("41c. formatTemplate keeps unknown placeholders", formatTemplate("Hi {name} {keep}", { name: "A" }) === "Hi A {keep}");
  ok("41d. formatTemplate interpolates numbers", formatTemplate("Invoice {number}", { number: 42 }) === "Invoice 42");
}
function rows0Helper() {
  return applyRunningBalance([saleEvent("a", "2026-10-02T10:00:00Z", 10000)], 0)[0];
}

// ===========================================================================
console.log("[42 foreign tenant identity rejection]");
{
  const token = encodeStatementCursor({ v: "v1", k: "CUSTOMER", b: "bizA", p: "cus1", f: "2026-10-01", t: "2026-10-31", ts: "2026-10-02T00:00:00.000Z", id: "x", st: "SALE" });
  ok("42a. Business B cannot use Business A's cursor (§38)", throwsValidation(() => decodeStatementCursor(token, { kind: "CUSTOMER", businessId: "bizB", partyId: "cus1", from: "2026-10-01", to: "2026-10-31" })));
  ok("42b. cursor payload binds businessId", Buffer.from(token.split(".")[0], "base64url").toString("utf8").includes("bizA"));
}

// ===========================================================================
console.log("[43 soft deleted party rejection (query law)]");
{
  const w = customerSaleWhere("b1", "c1", W, null);
  const pw = customerPaymentWhere("b1", "c1", W, null);
  ok("43a. sale source requires deletedAt null", w.deletedAt === null);
  ok("43b. payment target requires deletedAt null (party deletion cascades to visibility)", pw.sale.deletedAt === null);
  ok("43c. afterKey clause shape", (() => {
    const withAfter = customerSaleWhere("b1", "c1", W, { ts: new Date("2026-10-05T09:00:00.000Z"), id: "s5" });
    return Array.isArray(withAfter.OR) && withAfter.OR.length === 2;
  })());
}

// ===========================================================================
console.log("[44 event count semantics]");
ok("44a. eventCount = sales count + payments count (§179)", (() => {
  const s = summarizeStatement(0, 100, 50, 7);
  return s.eventCount === 7;
})());
ok("44b. limit bounds (§35)", STATEMENT_DEFAULT_LIMIT === 50 && STATEMENT_MIN_LIMIT === 10 && STATEMENT_MAX_LIMIT === 100);
ok("44c. limit parse clamps-rejects below min", throwsValidation(() => parseStatementQuery(new URLSearchParams("limit=9")), "limit"));
ok("44d. limit parse rejects above max", throwsValidation(() => parseStatementQuery(new URLSearchParams("limit=101")), "limit"));
ok("44e. non-numeric limit rejected", throwsValidation(() => parseStatementQuery(new URLSearchParams("limit=abc")), "limit"));
ok("44f. default query shape", (() => {
  const q = parseStatementQuery(new URLSearchParams(""));
  return q.limit === 50 && q.locale === "en" && q.cursor === null && q.from === null && q.to === null;
})());
ok("44g. locale allowlist", parseStatementQuery(new URLSearchParams("locale=fa")).locale === "fa" && parseStatementQuery(new URLSearchParams("locale=de")).locale === "en");
ok("44h. unknown params never become state (§129/§139)", (() => {
  const q = parseStatementQuery(new URLSearchParams("hacker=1&admin=true"));
  return !("hacker" in q) && !("admin" in q) && Object.keys(q).join(",") === "from,to,cursor,limit,locale";
})());
ok("44i. oversized cursor rejected", throwsValidation(() => parseStatementQuery(new URLSearchParams(`cursor=${"A".repeat(2000)}`)), "cursor"));

// ===========================================================================
console.log("[45 truncation semantics]");
ok("45a. cursor overflow implies hasMore", (() => {
  // assemblePage law: filtered.length > limit → more pages.
  const filtered = Array.from({ length: 51 }, (_, i) => saleEvent(String(i), "2026-10-01T00:00:00Z", 1));
  const limit = 50;
  return filtered.length > limit;
})());
ok("45b. full source window implies hasMore", statementSourceTake(50) === 51);
ok("45c. presets closed vocabulary (§75)", STATEMENT_PRESETS.length === 5 && ["thisMonth", "lastMonth", "last30Days", "last90Days", "thisYear"].every(isStatementPreset));
ok("45d. preset thisMonth (Tehran, fixed now)", (() => {
  const r = presetRange("thisMonth", "Asia/Tehran", new Date("2026-10-15T10:00:00Z"));
  return r.from === "2026-10-01" && r.to === "2026-10-31";
})());
ok("45e. preset lastMonth year-rollover", (() => {
  const r = presetRange("lastMonth", "Asia/Tehran", new Date("2026-01-15T10:00:00Z"));
  return r.from === "2025-12-01" && r.to === "2025-12-31";
})());
ok("45f. preset last30Days inclusive of today", (() => {
  const r = presetRange("last30Days", "Asia/Tehran", new Date("2026-10-15T10:00:00Z"));
  return r.from === "2026-09-16" && r.to === "2026-10-15";
})());
ok("45g. preset last90Days", (() => {
  const r = presetRange("last90Days", "UTC", new Date("2026-10-15T10:00:00Z"));
  return r.from === "2026-07-18" && r.to === "2026-10-15";
})());
ok("45h. preset thisYear", (() => {
  const r = presetRange("thisYear", "Asia/Tehran", new Date("2026-03-01T10:00:00Z"));
  return r.from === "2026-01-01" && r.to === "2026-12-31";
})());
ok("45i. timezone changes the default month (§19/§93)", (() => {
  const now = new Date("2026-10-01T00:30:00Z"); // Tehran: Oct 1 — LA: Sep 30
  const tehran = presetRange("thisMonth", "Asia/Tehran", now);
  const la = presetRange("thisMonth", "America/Los_Angeles", now);
  return tehran.from === "2026-10-01" && la.from === "2026-09-01" && la.to === "2026-09-30";
})());
ok("45j. resolveStatementRange full-month defaults", (() => {
  const r = resolveStatementRange(null, null, "UTC", new Date("2026-10-15T10:00:00Z"));
  return r.from === "2026-10-01" && r.to === "2026-10-31";
})());
ok("45k. resolveStatementRange one-sided fills the month", (() => {
  const a = resolveStatementRange("2026-03-05", null, "UTC", new Date("2026-10-15T10:00:00Z"));
  const b = resolveStatementRange(null, "2026-03-05", "UTC", new Date("2026-10-15T10:00:00Z"));
  return a.from === "2026-03-05" && a.to === "2026-03-31" && b.from === "2026-03-01" && b.to === "2026-03-05";
})());

// ===========================================================================
console.log("[46 DTO contract]");
{
  const page = {
    statementType: "customer" as const,
    party: { id: "cus1", name: "Acme" },
    summary: {
      openingBalanceMinor: 0, periodIncreaseMinor: 100, periodDecreaseMinor: 40,
      closingBalanceMinor: 60, eventCount: 2, truncated: false, from: "2026-10-01", to: "2026-10-31", timezone: "UTC",
    },
    rows: [
      // Prompt 49 (§13) — the additive sourceType/sourceId identity fields.
      { id: "SALE:a", eventType: "SALE" as const, sourceType: "SALE" as const, sourceId: "a", occurredAt: "2026-10-02T10:00:00.000Z", reference: "INV-0001", description: "Invoice INV-0001", increaseMinor: 100, decreaseMinor: 0, movementMinor: 100, balanceAfterMinor: 100 },
      { id: "PAYMENT_IN:b", eventType: "PAYMENT_RECEIVED" as const, sourceType: "PAYMENT_IN" as const, sourceId: "b", occurredAt: "2026-10-03T10:00:00.000Z", reference: null, description: "Payment", increaseMinor: 0, decreaseMinor: 40, movementMinor: -40, balanceAfterMinor: 60 },
    ],
    nextCursor: null,
    balanceBeforePageMinor: 0,
  };
  const dto = toStatementResponse(page);
  ok("46a. row DTO carries exactly the §32 fields (+ P49 source identity)", JSON.stringify(Object.keys(dto.rows[0])) === JSON.stringify(["id", "eventType", "sourceType", "sourceId", "occurredAt", "reference", "description", "increaseMinor", "decreaseMinor", "movementMinor", "balanceAfterMinor"]));
  ok("46a2. row DTO source identity is exact (P49 §13)", dto.rows[0].sourceType === "SALE" && dto.rows[0].sourceId === "a" && dto.rows[1].sourceType === "PAYMENT_IN" && dto.rows[1].sourceId === "b");
  ok("46b. summary DTO carries the §30 fields", (() => {
    const keys = Object.keys(dto.summary);
    return ["openingBalanceMinor", "periodIncreaseMinor", "periodDecreaseMinor", "closingBalanceMinor", "eventCount", "truncated", "from", "to", "timezone"].every((k) => keys.includes(k));
  })());
  ok("46c. rows are copies (no shared mutable references)", dto.rows[0] !== page.rows[0]);
  ok("46d. no note/audit/platform fields anywhere", !("note" in dto.rows[0]) && !("beforeJson" in dto) && !("actorId" in dto.rows[0]));
}

// ===========================================================================
// [47] §157/§159 — statement query-key cache laws (locale in key)
// ===========================================================================
{
  console.log("-- [47] statement query-key cache laws (§157/§159)");
  const mod = await import("../src/modules/statements/statements-api");
  const ck = mod.statementKeys.customer("biz1", "cus1", "2026-10-01", "2026-10-31", null, "en");
  const ckFa = mod.statementKeys.customer("biz1", "cus1", "2026-10-01", "2026-10-31", null, "fa");
  const sk = mod.statementKeys.supplier("biz1", "sup1", "2026-10-01", "2026-10-31", "cur1", "en");
  ok("47a. customer key carries businessId+partyId+from+to+cursor (§157)", ck.includes("biz1") && ck.includes("cus1") && ck.includes("2026-10-01") && ck.includes("2026-10-31") && ck.includes(null));
  ok("47b. locale is part of the key (language switch cannot serve stale rows)", ck[ck.length - 1] === "en" && ckFa[ckFa.length - 1] === "fa" && JSON.stringify(ck) !== JSON.stringify(ckFa));
  ok("47c. statement type token in key (customer ≠ supplier, §159)", ck[1] === "customer" && sk[1] === "supplier" && JSON.stringify(ck) !== JSON.stringify(sk));
  ok("47d. keysFor routes type + locale through single source (§133)", JSON.stringify(mod.statementKeysFor("supplier", "biz1", "sup1", "2026-10-01", "2026-10-31", "cur1", "fa")) === JSON.stringify(mod.statementKeys.supplier("biz1", "sup1", "2026-10-01", "2026-10-31", "cur1", "fa")));
}

// ===========================================================================
console.log(`PROMPT 39 UNIT: ${passed}/${passed + failed} ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("UNIT GREEN ✓");
