/**
 * R76 — unit sanity for the shared report-insight derivations
 * (src/lib/reports-insights.ts). Pure module — no database, no Next.js
 * runtime. Same standalone style as scripts/prompt20-state-machine.test.ts.
 *
 * Run: bun scripts/reports-insights.test.ts
 */
import {
  collectionPercentOf,
  isAgedOver60,
  isPastDueDay,
  sumAgedOver60Sales,
  sumOverdueSales,
  sumPastDueBills,
} from "../src/lib/reports-insights";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- collectionPercentOf: gating -------------------------------------------
check("gate: zero revenue → null", collectionPercentOf(0, 0) === null);
check("gate: zero collected → null", collectionPercentOf(8_600_000, 0) === null);
check("gate: negative revenue → null", collectionPercentOf(-5, 100) === null);
check("gate: negative collected → null", collectionPercentOf(8_600_000, -1) === null);

// ---- collectionPercentOf: math ---------------------------------------------
check("ratio: 1.8M/8.6M → 21 (R75 live-verified figure)",
  collectionPercentOf(8_600_000, 1_800_000) === 21,
  String(collectionPercentOf(8_600_000, 1_800_000)));
check("ratio: exactly 100 stays 100", collectionPercentOf(500, 500) === 100);
check("ratio: over-collection caps at 100 (never >100)",
  collectionPercentOf(500, 700) === 100,
  String(collectionPercentOf(500, 700)));
check("ratio: rounds to nearest whole percent (0.5% up)",
  collectionPercentOf(1_000, 5) === 1,
  String(collectionPercentOf(1_000, 5))); // 0.5% → 1
check("ratio: rounds down below .5",
  collectionPercentOf(1_000, 4) === 0,
  String(collectionPercentOf(1_000, 4))); // 0.4% → 0

// ---- isAgedOver60: bucket-union consistency --------------------------------
check("aging: age 60 is NOT over-60 (bucket D31_60)",
  isAgedOver60(60) === false);
check("aging: age 61 IS over-60 (bucket D61_90 starts)",
  isAgedOver60(61) === true);
check("aging: age 91 IS over-60 (bucket D90_PLUS)",
  isAgedOver60(91) === true);
check("aging: negative age clamps to not-over",
  isAgedOver60(-3) === false);
check("aging: fractional age floors first (60.9 → 60 → not over)",
  isAgedOver60(60.9) === false,
  String(isAgedOver60(60.9)));

// ---- R77: isPastDueDay — stated-due-day gate --------------------------------
// UTC "today" anchor: pick fixed day indices. localDayIndex uses business tz;
// with tz="UTC" the index of 2026-10-24 is a plain day count — construct via
// the same helper for self-consistency.
const TZ = "UTC";
const todayIdx = Math.floor(Date.UTC(2026, 9, 24) / 86_400_000); // 2026-10-24
const dayIdx = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

check("pastdue: no due date → never past due (honest: no terms stated)",
  isPastDueDay(null, todayIdx, TZ) === false);
check("pastdue: due today is NOT past due (strictly before today)",
  isPastDueDay(new Date(dayIdx(2026, 10, 24) * 86_400_000), todayIdx, TZ) === false);
check("pastdue: due yesterday IS past due",
  isPastDueDay(new Date(dayIdx(2026, 10, 23) * 86_400_000), todayIdx, TZ) === true);
check("pastdue: due far in the future is not past due",
  isPastDueDay(new Date(dayIdx(2027, 1, 15) * 86_400_000), todayIdx, TZ) === false);
check("pastdue: ISO string input accepted (same result as Date)",
  isPastDueDay("2026-10-20T12:00:00.000Z", todayIdx, TZ) === true);

// ---- R77: sumAgedOver60Sales — aggregate over open-sale rows ----------------
// tz "UTC", today = 2026-10-24. Ages: 90d → over-60; 30d → not; 61d → over.
const saleRows = [
  { issueDate: new Date(dayIdx(2026, 7, 26) * 86_400_000), totalMinor: 12_000, paidMinor: 0 }, // 90d, bal 12000
  { issueDate: new Date(dayIdx(2026, 9, 24) * 86_400_000), totalMinor: 30_000, paidMinor: 10_000 }, // 30d, bal 20000
  { issueDate: new Date(dayIdx(2026, 8, 24) * 86_400_000), totalMinor: 5_000, paidMinor: 5_000 }, // 61d old, balance 0 (paid-up edge — still an aged INVOICE, adds 0 to the sum)
];
const agedAgg = sumAgedOver60Sales(saleRows, todayIdx, TZ);
check("aged-sum: count = aged invoices (incl. zero-balance 61d edge)",
  agedAgg.count === 2,
  JSON.stringify(agedAgg));
check("aged-sum: minor sums balances of aged rows only (12000 + 0)",
  agedAgg.minor === 12_000,
  JSON.stringify(agedAgg));

// ---- R77: sumPastDueBills — aggregate over open-expense rows ----------------
const billRows = [
  { dueDate: new Date(dayIdx(2026, 10, 17) * 86_400_000), amountMinor: 8_000, paidMinor: 0 }, // past due, bal 8000
  { dueDate: new Date(dayIdx(2026, 10, 24) * 86_400_000), amountMinor: 4_000, paidMinor: 0 }, // due today, NOT past due
  { dueDate: null, amountMinor: 9_000, paidMinor: 1_000 }, // no due date → never past due
  { dueDate: new Date(dayIdx(2026, 11, 30) * 86_400_000), amountMinor: 6_000, paidMinor: 0 }, // future
];
const pastDueAgg = sumPastDueBills(billRows, todayIdx, TZ);
check("pastdue-sum: count = stated due days strictly before today",
  pastDueAgg.count === 1,
  JSON.stringify(pastDueAgg));
check("pastdue-sum: minor = balance of past-due rows only (8000)",
  pastDueAgg.minor === 8_000,
  JSON.stringify(pastDueAgg));

// ---- R77: cross-gate honesty — receivables never use the past-due gate ------
// A sale issued 90 days ago with NO due date must never read as "past due";
// the receivables framing is aging only (R76 law, pinned here).
check("honesty: aged sale is aging-true but pastdue-false (no due date)",
  isAgedOver60(90) === true && isPastDueDay(null, todayIdx, TZ) === false);

// ---- R82: sumOverdueSales — the stated-terms breach aggregate ---------------
// Mirror of sumPastDueBills over OPEN sale rows carrying R81 Sale.dueDate:
// the SAME isPastDueDay gate — the aging card slice, the header pill and the
// copilot chip cite figures that cannot disagree with the rows by construction.
const overdueSaleRows = [
  { dueDate: new Date(dayIdx(2026, 9, 8) * 86_400_000), totalMinor: 15_000, paidMinor: 0 }, // breached, bal 15000
  { dueDate: null, totalMinor: 12_000, paidMinor: 0 }, // termless → never overdue
  { dueDate: new Date(dayIdx(2026, 10, 24) * 86_400_000), totalMinor: 20_000, paidMinor: 5_000 }, // due today → not overdue
  { dueDate: new Date(dayIdx(2026, 11, 13) * 86_400_000), totalMinor: 20_000, paidMinor: 0 }, // future terms
];
const overdueAgg = sumOverdueSales(overdueSaleRows, todayIdx, TZ);
check("overdue-sum: count = stated due days strictly before today (1)",
  overdueAgg.count === 1,
  JSON.stringify(overdueAgg));
check("overdue-sum: minor = balance of breached rows only (15000)",
  overdueAgg.minor === 15_000,
  JSON.stringify(overdueAgg));
check("overdue-sum: empty scope → zeroed slice, never null",
  sumOverdueSales([], todayIdx, TZ).minor === 0 && sumOverdueSales([], todayIdx, TZ).count === 0);
check("overdue-sum: PAID-row contract is the caller's (mirror of pastDue) — gate ignores paidMinor",
  sumOverdueSales([{ dueDate: new Date(dayIdx(2026, 9, 8) * 86_400_000), totalMinor: 10_000, paidMinor: 10_000 }], todayIdx, TZ).count === 1);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:", failures.join(" | "));
  process.exit(1);
}
