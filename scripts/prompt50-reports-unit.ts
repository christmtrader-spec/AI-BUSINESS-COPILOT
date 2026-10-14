/**
 * scripts/prompt50-reports-unit.ts — Prompt 50 UNIT harness.
 *
 * Pure-function assertions over the reporting-period service
 * (src/lib/report-periods.ts), the hardened report engines
 * (src/lib/reports.ts window/bucketing helpers, src/lib/reports-advanced.ts
 * window law, src/lib/report-performance.ts allocation + query parsing)
 * and EN/FA parity — NO database, NO server:
 *
 *   [1] strict local-date / month-key parsing
 *   [2] pure local-calendar arithmetic (day/month walks, span counts)
 *   [3] zonedDayStartUtc EXACTNESS across offsets + DST (east/west/±14h/±30min)
 *   [4] rolling window law — N local days ending today, no future dates
 *   [5] previous-window law — exactly N days, no overlap, no gap (Gate D)
 *   [6] custom range law — 366-day cap, from<=to, future rejection/clamp
 *   [7] month window law — current month clamps at end of today (Gate B)
 *   [8] pctChange — zero baseline stays null; never a invented 100%
 *   [9] safe integer arithmetic — overflow → controlled integrity error
 *  [10] invoice discount allocation — exact largest-remainder reconciliation
 *  [11] allocation integrity — corrupt invoices never silently normalized
 *  [12] performance query parsing — closed vocab, clamps, strict dates
 *  [13] performance cursor — roundtrip, tamper, binding
 *  [14] summary engine window/bucket helpers — DST-stable day enumeration
 *  [15] EN/FA parity — the whole reports namespace (Gate Q)
 *
 * Run: bun scripts/prompt50-reports-unit.ts
 */

import { createRequire } from "node:module";
import path from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}
function throws(name: string, fn: () => unknown, Err?: new (...a: never[]) => Error) {
  try {
    fn();
    ok(name, false, "did not throw");
  } catch (e) {
    ok(name, Err ? e instanceof Err : true, e instanceof Error ? e.message : String(e));
  }
}

import {
  MAX_REPORT_RANGE_DAYS,
  ReportIntegrityError,
  ReportRangeError,
  addLocalDays,
  addMonthKey,
  daysBetweenInclusive,
  enumerateLocalDays,
  localDateKeyOf,
  localMonthKeyOf,
  parseLocalDateKey,
  parseMonthKeyInput,
  pctChange,
  resolveCustomRange,
  resolveMonthWindow,
  resolvePreviousWindow,
  resolveRollingWindow,
  safeAdd,
  safeMul,
  todayKey,
  zonedDayEndExclusiveUtc,
  zonedDayStartUtc,
} from "../src/lib/report-periods";
import {
  allocateInvoiceDiscount,
  decodePerformanceCursor,
  encodePerformanceCursor,
  isExpenseGroupBy,
  isSalesGroupBy,
  parsePerformanceLimit,
  parsePerformanceRange,
} from "../src/lib/report-performance";

console.log("[1] strict local-date / month-key parsing");
{
  eq(parseLocalDateKey("2026-02-28"), "2026-02-28", "1a. valid date accepted");
  eq(parseLocalDateKey("2024-02-29"), "2024-02-29", "1b. leap day accepted in leap year");
  eq(parseLocalDateKey("2026-02-29"), null, "1c. Feb 29 in a non-leap year rejected");
  eq(parseLocalDateKey("2026-4-5"), null, "1d. non-padded components rejected");
  eq(parseLocalDateKey("2026-13-01"), null, "1e. month 13 rejected");
  eq(parseLocalDateKey("2026-00-10"), null, "1f. month 00 rejected");
  eq(parseLocalDateKey("2026-04-31"), null, "1g. April 31 rejected");
  eq(parseLocalDateKey("2026-04-05T10:00:00Z"), null, "1h. datetime string rejected");
  eq(parseLocalDateKey("1999-12-31"), null, "1i. below 2000 rejected");
  eq(parseLocalDateKey(12345), null, "1j. non-string rejected");
  eq(parseMonthKeyInput("2026-09"), "2026-09", "1k. valid month accepted");
  eq(parseMonthKeyInput("2026-13"), null, "1l. month 13 rejected");
  eq(parseMonthKeyInput("2026-9"), null, "1m. non-padded month rejected");
  eq(parseMonthKeyInput("2026-09-01"), null, "1n. date passed as month rejected");
}

console.log("[2] pure local-calendar arithmetic");
{
  eq(addLocalDays("2026-01-01", -1), "2025-12-31", "2a. year boundary walked back");
  eq(addLocalDays("2026-02-28", 1), "2026-03-01", "2b. non-leap Feb walks to Mar 1");
  eq(addLocalDays("2024-02-28", 1), "2024-02-29", "2c. leap Feb keeps Feb 29");
  eq(addLocalDays("2026-03-01", -1), "2026-02-28", "2d. walk back into Feb");
  eq(addMonthKey("2026-01", -1), "2025-12", "2e. month key year boundary");
  eq(addMonthKey("2025-12", 1), "2026-01", "2f. month key forward");
  eq(addMonthKey("2026-07", -6), "2026-01", "2g. six months back");
  eq(daysBetweenInclusive("2026-01-01", "2026-01-01"), 1, "2h. same day = 1");
  eq(daysBetweenInclusive("2026-01-01", "2026-01-07"), 7, "2i. one week = 7");
  eq(daysBetweenInclusive("2026-01-01", "2025-12-31"), 0, "2j. inverted range = 0");
  eq(daysBetweenInclusive("2026-02-28", "2026-03-01"), 2, "2k. span across month end");
  eq(enumerateLocalDays("2026-02-27", "2026-03-02").join(","), "2026-02-27,2026-02-28,2026-03-01,2026-03-02", "2l. month-boundary enumeration exact");
  eq(enumerateLocalDays("2026-12-30", "2027-01-02").length, 4, "2m. year-boundary enumeration count");
}

console.log("[3] zonedDayStartUtc EXACTNESS — offsets, DST, extreme zones");
{
  // For every zone: the start instant maps back to the key, one ms earlier
  // maps to the PREVIOUS local day, and the day length is 23h/24h/25h.
  const zones = [
    "UTC",
    "Asia/Tehran", // +03:30 fixed (DST-free since 2022)
    "America/New_York", // DST transitions (spring 2026-03-08, fall 2026-11-01)
    "Europe/Berlin", // DST, east of UTC
    "Pacific/Kiritimati", // +14:00 — extreme east
    "Pacific/Midway", // -11:00 — extreme west
    "Australia/Lord_Howe", // +10:30/+11:00 — 30-minute DST shift
    "Asia/Kolkata", // +05:30 — half-hour offset
    "America/St_Johns", // -03:30/-02:30 — half-hour DST
    "Asia/Kathmandu", // +05:45 — 45-minute offset
  ];
  const sampleDays = [
    "2026-01-15", // plain winter day
    "2026-03-08", // US spring-forward
    "2026-03-07", // day before US spring-forward
    "2026-11-01", // US fall-back
    "2026-06-15", // northern summer
    "2026-09-30", // month boundary
    "2024-02-29", // leap day
  ];
  let checked = 0;
  let exact = true;
  let dayLengths = new Set<number>();
  for (const tz of zones) {
    for (const day of sampleDays) {
      const start = zonedDayStartUtc(day, tz);
      if (localDateKeyOf(start, tz) !== day) exact = false;
      if (localDateKeyOf(new Date(start.getTime() - 1), tz) === day) exact = false;
      const end = zonedDayEndExclusiveUtc(day, tz);
      const len = end.getTime() - start.getTime();
      if (len < 23 * 3600_000 || len > 25 * 3600_000) exact = false;
      dayLengths.add(len);
      checked++;
    }
  }
  ok("3a. every start instant is the FIRST ms of its local day", exact, `${checked} probes`);
  ok(
    "3b. local days are 23h/24h/25h — never assumed 24h",
    [...dayLengths].every((l) => [23, 24, 25].includes(Math.round(l / 3600_000))),
    `lengths=${[...dayLengths].sort().join(",")}`,
  );
  // Concrete DST probe: New York 2026-03-08 is a 23-hour day (spring forward).
  const nySpringStart = zonedDayStartUtc("2026-03-08", "America/New_York").getTime();
  const nySpringEnd = zonedDayEndExclusiveUtc("2026-03-08", "America/New_York").getTime();
  ok("3c. NY spring-forward day is exactly 23h", nySpringEnd - nySpringStart === 23 * 3600_000, `${(nySpringEnd - nySpringStart) / 3600_000}h`);
  // Tehran +03:30: local midnight is 20:30Z the previous day.
  const tehranStart = zonedDayStartUtc("2026-10-03", "Asia/Tehran").getTime();
  ok("3d. Tehran local day starts 20:30Z prev day", tehranStart === Date.UTC(2026, 9, 2, 20, 30, 0), new Date(tehranStart).toISOString());
  // +14:00 zone: local midnight of Oct 3 = 10:00Z on the PREVIOUS UTC date.
  const kiriStart = zonedDayStartUtc("2026-10-03", "Pacific/Kiritimati").getTime();
  ok("3e. Kiritimati (+14) local day starts 10:00Z prev UTC day", kiriStart === Date.UTC(2026, 9, 2, 10, 0, 0), new Date(kiriStart).toISOString());
  throws("3f. bogus timezone fails LOUD, never silently mis-buckets", () => zonedDayStartUtc("2026-10-03", "Not/AZone"), ReportIntegrityError);
}

console.log("[4] rolling window law — N local days ending today (Gate B)");
{
  const now = new Date("2026-10-03T12:00:00.000Z");
  for (const tz of ["UTC", "Asia/Tehran", "Pacific/Kiritimati", "America/New_York"]) {
    const w = resolveRollingWindow(tz, 30, now);
    ok(`4a. ${tz}: 30 local days`, w.dayKeys.length === 30);
    ok(`4b. ${tz}: window ends on TODAY (business-local)`, w.toKey === todayKey(now, tz), `${w.toKey} vs ${todayKey(now, tz)}`);
    ok(`4c. ${tz}: no future local date in window`, w.dayKeys.every((k) => k <= todayKey(now, tz)));
    ok(`4d. ${tz}: oldest key is toKey-29`, w.fromKey === addLocalDays(w.toKey, -29));
    ok(`4e. ${tz}: fetchUntil == start of the day AFTER toKey`, w.fetchUntil.getTime() === zonedDayStartUtc(addLocalDays(w.toKey, 1), tz).getTime());
    // The exclusive fetch window is exactly [fromKey 00:00, dayAfter(toKey) 00:00).
    ok(`4f. ${tz}: fetchFrom == start of fromKey's local day`, w.fetchFrom.getTime() === zonedDayStartUtc(w.fromKey, tz).getTime());
  }
}

console.log("[5] previous-window law — exact N days, no overlap/gap (Gate D)");
{
  const now = new Date("2026-10-03T12:00:00.000Z");
  for (const days of [7, 30, 90] as const) {
    const cur = resolveRollingWindow("Asia/Tehran", days, now);
    const prev = resolvePreviousWindow("Asia/Tehran", days, cur.fromKey);
    ok(`5a. days=${days}: previous window has exactly N days`, daysBetweenInclusive(prev.fromKey, prev.toKey) === days);
    ok(`5b. days=${days}: previous.toKey is the day BEFORE current.fromKey`, prev.toKey === addLocalDays(cur.fromKey, -1));
    ok(`5c. days=${days}: no overlap`, prev.toKey < cur.fromKey);
    ok(`5d. days=${days}: no gap`, daysBetweenInclusive(prev.fromKey, cur.toKey) === days * 2);
    ok(`5e. days=${days}: previous DB bounds exact`, prev.fetchUntil.getTime() === cur.fetchFrom.getTime());
  }
  // Year-boundary comparison: a 7-day window starting Jan 4 → previous ends
  // Jan 3 and starts Dec 28 — cleanly crossing the year boundary.
  const janNow = new Date("2027-01-10T12:00:00.000Z");
  const janCur = resolveRollingWindow("UTC", 7, janNow);
  const janPrev = resolvePreviousWindow("UTC", 7, janCur.fromKey);
  eq(janPrev.toKey, "2027-01-03", "5f. previous window ends the day before the current window");
  eq(janPrev.fromKey, "2026-12-28", "5g. previous window CROSSES the year boundary cleanly");
  ok("5h. previous window length still exact across the year boundary", daysBetweenInclusive(janPrev.fromKey, janPrev.toKey) === 7);
}

console.log("[6] custom range law — strict, capped, future-safe");
{
  const now = new Date("2026-10-03T12:00:00.000Z");
  const w = resolveCustomRange("UTC", "2026-09-01", "2026-09-30", now);
  ok("6a. 30-day custom window accepted", w.dayKeys.length === 30 && w.fromKey === "2026-09-01" && w.toKey === "2026-09-30");
  throws("6b. from > to rejected", () => resolveCustomRange("UTC", "2026-09-10", "2026-09-01", now), ReportRangeError);
  throws("6c. junk dates rejected", () => resolveCustomRange("UTC", "2026/09/01", "2026-09-30", now), ReportRangeError);
  throws("6d. range > 366 days rejected", () => resolveCustomRange("UTC", "2025-01-01", "2026-02-01", now), ReportRangeError);
  ok(`6e. 366-day range accepted (cap=${MAX_REPORT_RANGE_DAYS})`, resolveCustomRange("UTC", "2025-10-01", "2026-10-01", now).dayKeys.length === 366);
  throws("6f. fully-future range rejected", () => resolveCustomRange("UTC", "2026-10-05", "2026-10-10", now), ReportRangeError);
  const clamped = resolveCustomRange("UTC", "2026-10-01", "2026-12-31", now);
  eq(clamped.toKey, "2026-10-03", "6g. partly-future range clamps toKey at today");
  ok("6h. clamped window has no future bucket", clamped.dayKeys.every((k) => k <= "2026-10-03"));
}

console.log("[7] month window law — current month clamps at end of TODAY");
{
  const now = new Date("2026-10-15T12:00:00.000Z");
  const cur = resolveMonthWindow("UTC", "2026-10", now)!;
  ok("7a. current month fetchUntil == end of today", cur.fetchUntil.getTime() === zonedDayEndExclusiveUtc("2026-10-15", "UTC").getTime());
  const past = resolveMonthWindow("UTC", "2026-09", now)!;
  ok("7b. past month ends at the natural month end", past.fetchUntil.getTime() === zonedDayStartUtc("2026-10-01", "UTC").getTime());
  ok("7c. past month starts at the exact local month start", past.fetchFrom.getTime() === zonedDayStartUtc("2026-09-01", "UTC").getTime());
  eq(resolveMonthWindow("UTC", "2026-13", now), null, "7d. invalid month rejected");
  // Tehran: the current-month clamp is expressed in EXACT local instants.
  const curTehran = resolveMonthWindow("Asia/Tehran", "2026-10", now)!;
  ok("7e. Tehran current-month clamp is exact (20:30Z)", curTehran.fetchUntil.getTime() === Date.UTC(2026, 9, 15, 20, 30, 0), curTehran.fetchUntil.toISOString());
}

console.log("[8] pctChange — zero baseline stays null (never invented 100%)");
{
  eq(pctChange(150, 100), 50, "8a. simple growth");
  eq(pctChange(50, 100), -50, "8b. decline");
  eq(pctChange(100, 0), null, "8c. zero baseline → null (NOT +100%)");
  eq(pctChange(0, 0), null, "8d. zero→zero → null");
  eq(pctChange(100, -5), null, "8e. negative baseline → null (no nonsense)");
}

console.log("[9] safe integer arithmetic — overflow fails LOUD (Gate O)");
{
  eq(safeAdd(2, 3), 5, "9a. plain add");
  eq(safeMul(3, 4), 12, "9b. plain mul");
  throws("9c. overflow throws integrity error", () => safeAdd(Number.MAX_SAFE_INTEGER, 1), ReportIntegrityError);
  throws("9d. qty overflow throws", () => safeMul(Number.MAX_SAFE_INTEGER, 2, "inventory"), ReportIntegrityError);
  throws("9e. non-integer money throws", () => safeAdd(1.5, 1), ReportIntegrityError);
  throws("9f. float qty throws", () => safeMul(1.5, 100), ReportIntegrityError);
}

console.log("[10] invoice discount allocation — exact reconciliation (§7.2)");
{
  // Simple: 3 lines, 10% discount.
  {
    const lines = [
      { id: "l1", lineTotalMinor: 10_000 },
      { id: "l2", lineTotalMinor: 20_000 },
      { id: "l3", lineTotalMinor: 70_000 },
    ];
    const nets = allocateInvoiceDiscount(lines, 90_000); // 10_000 discount
    const sum = nets.reduce((a, b) => a + b, 0);
    ok("10a. allocated nets sum EXACTLY to the invoice total", sum === 90_000, `sum=${sum}`);
    ok("10b. proportional shares correct", nets[0] === 9_000 && nets[1] === 18_000 && nets[2] === 63_000, JSON.stringify(nets));
  }
  // Randomized reconciliation: every allocation sums exactly to the total.
  {
    let reconciled = 0;
    let nonNegative = true;
    let deterministic = true;
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + (trial % 6);
      const lines = Array.from({ length: n }, (_, i) => ({
        id: `line-${i}`,
        lineTotalMinor: 1 + ((trial * 7919 + i * 104729) % 1_000_000),
      }));
      const lineSum = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
      const discount = Math.floor((trial % 90) * lineSum / 100);
      const total = lineSum - discount;
      const nets = allocateInvoiceDiscount(lines, total);
      const sum = nets.reduce((a, b) => a + b, 0);
      if (sum !== total) { reconciled++; continue; }
      if (!nets.every((v) => Number.isSafeInteger(v) && v >= 0)) nonNegative = false;
      const again = allocateInvoiceDiscount(lines, total);
      if (JSON.stringify(again) !== JSON.stringify(nets)) deterministic = false;
    }
    ok("10c. 300 randomized invoices: nets sum exactly to total every time", reconciled === 0, `${reconciled} mismatches`);
    ok("10d. all allocated nets are safe non-negative integers", nonNegative);
    ok("10e. allocation is deterministic across runs", deterministic);
  }
  // Remainder distribution + tie-break by stable id.
  {
    // 3 equal lines, total 100 → 34/33/33, remainder unit to the smallest id.
    const lines = [
      { id: "a", lineTotalMinor: 10 },
      { id: "b", lineTotalMinor: 10 },
      { id: "c", lineTotalMinor: 10 },
    ];
    const nets = allocateInvoiceDiscount(lines, 100);
    eq(nets, [34, 33, 33], "10f. equal lines + remainder: first-by-id gets the unit");
    // Ties on remainder resolve by id ascending: the unit goes to line "a".
    const tie = [
      { id: "z", lineTotalMinor: 5 },
      { id: "a", lineTotalMinor: 5 },
    ];
    const tieNets = allocateInvoiceDiscount(tie, 11);
    eq(tieNets, [5, 6], "10g. remainder tie-break by stable line id (a before z)");
  }
  // No discount: nets equal lines exactly.
  {
    const lines = [
      { id: "l1", lineTotalMinor: 12_345 },
      { id: "l2", lineTotalMinor: 6_789 },
    ];
    const nets = allocateInvoiceDiscount(lines, 19_134);
    eq(nets, [12_345, 6_789], "10h. zero discount → nets == line values");
  }
  // Full discount (total 0): every net 0.
  {
    const nets = allocateInvoiceDiscount(
      [{ id: "a", lineTotalMinor: 5_000 }, { id: "b", lineTotalMinor: 7_000 }],
      0,
    );
    eq(nets, [0, 0], "10i. 100% discount → all nets zero");
  }
  // BigInt exactness on large values.
  {
    const lines = [
      { id: "a", lineTotalMinor: 4_000_000_000_000 },
      { id: "b", lineTotalMinor: 6_000_000_000_000 },
    ];
    const nets = allocateInvoiceDiscount(lines, 9_999_999_999_999);
    const sum = nets.reduce((a, b) => a + b, 0);
    ok("10j. huge (multi-trillion) invoice reconciles exactly via BigInt", sum === 9_999_999_999_999, `sum=${sum}`);
  }
}

console.log("[11] allocation integrity — corrupt invoices never normalized");
{
  throws("11a. zero lines + non-zero total", () => allocateInvoiceDiscount([], 500), ReportIntegrityError);
  throws("11b. negative line total", () => allocateInvoiceDiscount([{ id: "a", lineTotalMinor: -5 }], 100), ReportIntegrityError);
  throws("11c. non-integer total", () => allocateInvoiceDiscount([{ id: "a", lineTotalMinor: 10 }], 10.5), ReportIntegrityError);
  throws("11d. negative total", () => allocateInvoiceDiscount([{ id: "a", lineTotalMinor: 10 }], -1), ReportIntegrityError);
  throws("11e. zero-value lines with non-zero total", () => allocateInvoiceDiscount([{ id: "a", lineTotalMinor: 0 }], 500), ReportIntegrityError);
}

console.log("[12] performance query parsing — closed vocab + clamps");
{
  ok("12a. sales groupBy closed vocab", isSalesGroupBy("product") && isSalesGroupBy("customer") && isSalesGroupBy("day") && isSalesGroupBy("month") && !isSalesGroupBy("note"));
  ok("12b. expense groupBy closed vocab", isExpenseGroupBy("category") && isExpenseGroupBy("supplier") && !isExpenseGroupBy("product"));
  eq(parsePerformanceLimit(null), 25, "12c. default limit 25");
  eq(parsePerformanceLimit("50"), 50, "12d. valid limit");
  throws("12e. limit below floor rejected", () => parsePerformanceLimit("5"), ReportRangeError);
  throws("12f. limit above cap rejected", () => parsePerformanceLimit("5000"), ReportRangeError);
  throws("12g. non-numeric limit rejected", () => parsePerformanceLimit("abc"), ReportRangeError);
  const now = new Date("2026-10-03T12:00:00.000Z");
  const w = parsePerformanceRange("Asia/Tehran", "2026-09-01", "2026-09-20", now);
  ok("12h. strict range accepted with exact bounds", w.fromKey === "2026-09-01" && w.toKey === "2026-09-20" && w.fetchFrom.getTime() === zonedDayStartUtc("2026-09-01", "Asia/Tehran").getTime());
  throws("12i. missing from rejected", () => parsePerformanceRange("UTC", null, "2026-09-20", now), ReportRangeError);
  throws("12j. malformed to rejected", () => parsePerformanceRange("UTC", "2026-09-01", "09/20/2026", now), ReportRangeError);
  throws("12k. over-366d range rejected", () => parsePerformanceRange("UTC", "2025-01-01", "2026-01-02", now), ReportRangeError);
  throws("12l. future-only range rejected", () => parsePerformanceRange("UTC", "2026-10-10", "2026-10-20", now), ReportRangeError);
}

console.log("[13] performance cursor — roundtrip, tamper, binding");
{
  const state = { v: "v1" as const, b: "biz-1", k: "cashflow:2026-09-01:2026-09-30:*", ts: "2026-09-15T10:00:00.000Z", id: "pay-3" };
  const token = encodePerformanceCursor(state);
  ok("13a. token is payload.signature", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
  const decoded = decodePerformanceCursor(token, { businessId: "biz-1", binding: state.k });
  eq(decoded.id, "pay-3", "13b. roundtrip id");
  eq(decoded.ts, state.ts, "13c. roundtrip ts");
  throws("13d. tampered payload rejected", () => decodePerformanceCursor(`${token.slice(0, -3)}abc`, { businessId: "biz-1", binding: state.k }), ReportRangeError);
  throws("13e. foreign binding rejected", () => decodePerformanceCursor(token, { businessId: "biz-1", binding: "cashflow:2026-09-01:2026-09-30:IN" }), ReportRangeError);
  throws("13f. foreign tenant rejected", () => decodePerformanceCursor(token, { businessId: "biz-2", binding: state.k }), ReportRangeError);
  throws("13g. garbage token rejected", () => decodePerformanceCursor("garbage", { businessId: "biz-1", binding: state.k }), ReportRangeError);
  throws("13h. unsigned JSON rejected", () => decodePerformanceCursor(Buffer.from(JSON.stringify(state)).toString("base64url"), { businessId: "biz-1", binding: state.k }), ReportRangeError);
}

console.log("[14] summary engine helpers — DST-stable day enumeration");
{
  // localMonthKeyOf is the authoritative bucket key used by the MoM engine.
  eq(localMonthKeyOf(new Date("2026-09-30T20:30:00.000Z"), "Asia/Tehran"), "2026-10", "14a. 20:30Z is Oct 1 in Tehran (+3:30)");
  eq(localMonthKeyOf(new Date("2026-09-30T20:29:59.999Z"), "Asia/Tehran"), "2026-09", "14b. one ms earlier is still September");
  eq(localMonthKeyOf(new Date("2026-10-01T00:30:00.000Z"), "America/New_York"), "2026-09", "14c. west-of-UTC month boundary");
  eq(localDateKeyOf(new Date("2026-03-08T07:00:00.000Z"), "America/New_York"), "2026-03-08", "14d. spring-forward instant maps to the right local day");
  // Rolling window buckets are pure local-calendar enumerations.
  const w = resolveRollingWindow("Australia/Lord_Howe", 7, new Date("2026-04-05T14:00:00.000Z"));
  ok("14e. 30-min-DST zone rolling window still has exactly 7 local days", w.dayKeys.length === 7);
  ok(
    "14f. window days are contiguous calendar days (inclusive span 2 between neighbours)",
    w.dayKeys.every((k, i) => i === 0 || daysBetweenInclusive(w.dayKeys[i - 1], k) === 2),
  );
}

console.log("[15] EN/FA parity — the whole reports namespace (Gate Q)");
{
  const esmRequire = createRequire(path.join(process.cwd(), "package.json"));
  const enMod = esmRequire("./src/i18n/messages/en") as { default: Record<string, unknown> };
  const faMod = esmRequire("./src/i18n/messages/fa") as { default: Record<string, unknown> };
  const enReports = enMod.default.reports as Record<string, unknown>;
  const faReports = faMod.default.reports as Record<string, unknown>;
  const enKeys = Object.keys(enReports);
  const faKeys = Object.keys(faReports);
  ok("15a. reports key parity (EN ⊆ FA)", enKeys.every((k) => faKeys.includes(k)), enKeys.filter((k) => !faKeys.includes(k)).join(","));
  ok("15b. reports key parity (FA ⊆ EN)", faKeys.every((k) => enKeys.includes(k)), faKeys.filter((k) => !enKeys.includes(k)).join(","));
  const required = [
    "categoryOther", "momDetailPreview", "perfTitle", "perfKindCashflow",
    "perfBasisNet", "perfBasisExpense", "perfBasisCash", "perfColUnlinked",
    "perfColNoCustomer", "perfTruncated", "perfExportTooLarge", "perfEmpty",
    "perfInvalidRange", "perfNetValue", "perfOpenSource",
  ];
  ok("15c. Prompt 50 keys present in BOTH locales", required.every((k) => k in enReports && k in faReports));
  // §2.4 — no false profit claim anywhere in the reports namespace.
  ok(
    "15d. EN never labels netAccrual as profit",
    !String(enReports.kpiNetAccrual).toLowerCase().includes("profit"),
    String(enReports.kpiNetAccrual),
  );
  ok(
    "15e. FA netAccrual label is truthful (سود absent)",
    !String(faReports.kpiNetAccrual).includes("سود"),
    String(faReports.kpiNetAccrual),
  );
  ok("15f. FA categoryOther is professional Persian", faReports.categoryOther === "سایر");
  ok("15g. FA perfDirectionIn/Out are professional financial terms", faReports.perfDirectionIn === "وارد" && faReports.perfDirectionOut === "خارج");
  // Interpolation contracts preserved: every {param} in EN appears in FA.
  const paramRe = /\{(\w+)\}/g;
  let interpolationOk = true;
  const badKeys: string[] = [];
  for (const k of enKeys) {
    const en = String(enReports[k]);
    const fa = k in faReports ? String(faReports[k]) : "";
    const enParams = [...en.matchAll(paramRe)].map((m) => m[1]).sort().join(",");
    const faParams = [...fa.matchAll(paramRe)].map((m) => m[1]).sort().join(",");
    if (enParams !== faParams) {
      interpolationOk = false;
      badKeys.push(k);
    }
  }
  ok("15h. interpolation params identical across EN/FA", interpolationOk, badKeys.join(","));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
