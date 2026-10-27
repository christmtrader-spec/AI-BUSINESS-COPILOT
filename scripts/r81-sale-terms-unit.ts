/**
 * scripts/r81-sale-terms-unit.ts — R81/R83 UNIT harness.
 *
 * Pure-function assertions over the stated-terms (dueDate) law that R81
 * gives Sale invoices and R83 extends into a full terms LIFECYCLE —
 * NO database, NO server:
 *
 *   [1] §84 date-only law (dueDateStringSchema, now SHARED by both sides
 *       of the book) — format, garbage calendar rejection, leap years,
 *       midnoon instant
 *   [2] saleCreateSchema.dueDate — absent/null → null (no invented terms)
 *   [3] the shared isPastDueDay gate (receivables overdue law) — due day
 *       vs today's business day: same day never overdue, strictly-before
 *       is, no terms never is; timezone-correct across UTC/Tehran
 *   [4] mapSaleDetail stated-terms state — overdue = past-due day AND open
 *       balance; PAID invoices are never overdue; null terms keep the
 *       honest AGING framing; missing context degrades to NEVER overdue
 *   [5] DTO shape — dueDate/overdue present, closed vocabulary, no leakage
 *   [6] R83 saleUpdateSchema three-state law — dueDate absent=untouched /
 *       null=clear / date=set; issueDate absent=untouched (null NOT a
 *       clear — the column is NOT NULL); note three-state text
 *   [7] R83 the shared dueBeforeIssue write gate — same-day never before,
 *       strictly-before is, and the BUSINESS timezone governs (a due
 *       day that survives in UTC can still be before the issue day in
 *       Tehran — the gate must catch it)
 *
 * Run: bun scripts/r81-sale-terms-unit.ts
 */

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

import { dueDateStringSchema, saleCreateSchema, saleUpdateSchema } from "../src/lib/schemas";
import { isPastDueDay } from "../src/lib/reports-insights";
import { dueBeforeIssue, localDayIndex } from "../src/lib/aging";
import { mapSaleDetail } from "../src/lib/entities/sale";

const base = new Date("2026-10-24T10:00:00.000Z");

/* [1] §84 date-only law — now the SHARED terms law for sales AND bills */
{
  const good = dueDateStringSchema.parse("2026-03-15");
  ok("§84 midnoon instant", good instanceof Date && good.toISOString() === "2026-03-15T12:00:00.000Z", String(good));
  const leap = dueDateStringSchema.parse("2024-02-29");
  ok("leap day accepted (2024-02-29)", leap.toISOString() === "2024-02-29T12:00:00.000Z", String(leap));
  let threw = false;
  try {
    dueDateStringSchema.parse("2026-02-29"); // non-leap year
  } catch {
    threw = true;
  }
  ok("non-leap 02-29 rejected", threw);
  threw = false;
  try {
    dueDateStringSchema.parse("2026-02-31"); // JS would roll over to Mar 3
  } catch {
    threw = true;
  }
  ok("garbage calendar day rejected (02-31)", threw);
  threw = false;
  try {
    dueDateStringSchema.parse("2026-3-15"); // not zero-padded
  } catch {
    threw = true;
  }
  ok("non-YYYY-MM-DD format rejected", threw);
  threw = false;
  try {
    dueDateStringSchema.parse("2026-03-15T08:00:00Z"); // datetime, not date-only
  } catch {
    threw = true;
  }
  ok("datetime string rejected (date-only law)", threw);
}

/* [2] saleCreateSchema.dueDate — absent/null → null */
{
  const noTerms = saleCreateSchema.parse({
    items: [{ name: "Widget", qty: 1, unitPriceMinor: 500 }],
  });
  eq(noTerms.dueDate, null, "absent dueDate → null (no invented terms)");
  const explicitNull = saleCreateSchema.parse({
    items: [{ name: "Widget", qty: 1, unitPriceMinor: 500 }],
    dueDate: null,
  });
  eq(explicitNull.dueDate, null, "explicit null dueDate → null");
  const stated = saleCreateSchema.parse({
    items: [{ name: "Widget", qty: 1, unitPriceMinor: 500 }],
    dueDate: "2026-11-30",
  });
  ok(
    "stated dueDate → §84 midnoon Date",
    stated.dueDate instanceof Date && stated.dueDate.toISOString() === "2026-11-30T12:00:00.000Z",
    String(stated.dueDate),
  );
}

/* [3] the shared gate — receivables overdue law (business tz, A07) */
{
  const todayUtc = localDayIndex(new Date("2026-10-24T12:00:00.000Z"), "UTC");
  eq(todayUtc, localDayIndex(new Date("2026-10-24T00:00:00.000Z"), "UTC"), "UTC day index stable across the day's hours");
  ok("due TODAY never overdue (strictly-before law)", isPastDueDay(new Date("2026-10-24T12:00:00.000Z"), todayUtc, "UTC") === false);
  ok("due YESTERDAY overdue", isPastDueDay(new Date("2026-10-23T12:00:00.000Z"), todayUtc, "UTC") === true);
  ok("due TOMORROW not overdue", isPastDueDay(new Date("2026-10-25T12:00:00.000Z"), todayUtc, "UTC") === false);
  ok("no stated terms never overdue", isPastDueDay(null, todayUtc, "UTC") === false);

  // Timezone honesty: the §84 midnoon instant maps to the SAME calendar
  // day in every display timezone (the whole point of the §84 rule).
  const tehranIdx = localDayIndex(new Date("2026-10-24T12:00:00.000Z"), "Asia/Tehran");
  eq(tehranIdx, todayUtc, "§84 midnoon → same day index in UTC and Asia/Tehran");
  const tehranToday = localDayIndex(new Date(), "Asia/Tehran");
  ok(
    "Tehran business day governs the gate (due yesterday Tehran → overdue)",
    isPastDueDay(new Date(`${tehranDayStr(-1)}T12:00:00.000Z`), tehranToday, "Asia/Tehran") === true,
  );
  ok(
    "Tehran business day governs the gate (due today Tehran → not overdue)",
    isPastDueDay(new Date(`${tehranDayStr(0)}T12:00:00.000Z`), tehranToday, "Asia/Tehran") === false,
  );
}
function tehranDayStr(offsetDays: number): string {
  // Today's business day in Tehran, shifted by offsetDays, as YYYY-MM-DD.
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  // Compute the date AS SEEN in Asia/Tehran (+03:30 / +04:30) by using the
  // locale formatter — avoids any hand-rolled offset math.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA yields YYYY-MM-DD
}

/* [4] mapSaleDetail stated-terms state */
{
  const items = [{ id: "i1", productId: null, name: "Widget", unit: null, qty: 1, unitPriceMinor: 500, lineTotalMinor: 500 }];
  const past = new Date("2026-09-01T12:00:00.000Z");
  const todayIdx = localDayIndex(new Date(), "UTC");

  const overdueOpen = mapSaleDetail(
    { id: "s1", number: 1, customerId: null, customerName: null, issueDate: base, dueDate: past, subtotalMinor: 500, discountMinor: 0, taxRateBp: 0, taxMinor: 0, totalMinor: 500, paidMinor: 0, status: "UNPAID", note: null, createdAt: base },
    items,
    [],
    { timeZone: "UTC", todayIdx },
  );
  ok("open + past-due day → overdue", overdueOpen.sale.overdue === true);
  ok("dueDate surfaces as ISO", overdueOpen.sale.dueDate === "2026-09-01T12:00:00.000Z", String(overdueOpen.sale.dueDate));

  const overduePaid = mapSaleDetail(
    { id: "s2", number: 2, customerId: null, customerName: null, issueDate: base, dueDate: past, subtotalMinor: 500, discountMinor: 0, taxRateBp: 0, taxMinor: 0, totalMinor: 500, paidMinor: 500, status: "PAID", note: null, createdAt: base },
    items,
    [],
    { timeZone: "UTC", todayIdx },
  );
  ok("PAID invoice never overdue (open-balance law)", overduePaid.sale.overdue === false);

  const termless = mapSaleDetail(
    { id: "s3", number: 3, customerId: null, customerName: null, issueDate: base, dueDate: null, subtotalMinor: 500, discountMinor: 0, taxRateBp: 0, taxMinor: 0, totalMinor: 500, paidMinor: 0, status: "UNPAID", note: null, createdAt: base },
    items,
    [],
    { timeZone: "UTC", todayIdx },
  );
  ok("no stated terms → AGING framing (overdue false, dueDate null)", termless.sale.overdue === false && termless.sale.dueDate === null);

  const dueToday = mapSaleDetail(
    { id: "s4", number: 4, customerId: null, customerName: null, issueDate: base, dueDate: new Date(`${tehranDayStr(0)}T12:00:00.000Z`), subtotalMinor: 500, discountMinor: 0, taxRateBp: 0, taxMinor: 0, totalMinor: 500, paidMinor: 0, status: "UNPAID", note: null, createdAt: base },
    items,
    [],
    { timeZone: "Asia/Tehran", todayIdx: localDayIndex(new Date(), "Asia/Tehran") },
  );
  ok("due TODAY (business day) not yet overdue", dueToday.sale.overdue === false);

  const legacyCtx = mapSaleDetail(
    { id: "s5", number: 5, customerId: null, customerName: null, issueDate: base, dueDate: past, subtotalMinor: 500, discountMinor: 0, taxRateBp: 0, taxMinor: 0, totalMinor: 500, paidMinor: 0, status: "UNPAID", note: null, createdAt: base },
    items,
    [],
  );
  ok("missing day-math context degrades to NEVER overdue (honest default)", legacyCtx.sale.overdue === false);
}

/* [5] DTO shape — closed, additive, no leakage */
{
  const d = mapSaleDetail(
    { id: "s1", number: 1, customerId: null, customerName: null, issueDate: base, dueDate: new Date("2026-09-01T12:00:00.000Z"), subtotalMinor: 500, discountMinor: 0, taxRateBp: 0, taxMinor: 0, totalMinor: 500, paidMinor: 0, status: "UNPAID", note: null, createdAt: base },
    [],
    [],
    { timeZone: "UTC", todayIdx: localDayIndex(new Date(), "UTC") },
  );
  const saleKeys = Object.keys(d.sale);
  ok("dueDate + overdue present on the detail DTO", saleKeys.includes("dueDate") && saleKeys.includes("overdue"), saleKeys.join(","));
  ok("no business internals leak", !saleKeys.includes("businessId") && !saleKeys.includes("deletedAt"), saleKeys.join(","));
}

/* [6] R83 saleUpdateSchema — the PATCH three-state law */
{
  // dueDate: absent → undefined (untouched — NOT null, which would clear).
  const untouched = saleUpdateSchema.parse({});
  eq(untouched.dueDate, undefined, "PATCH: absent dueDate → undefined (untouched)");
  // null → null (explicit clear — back to the honest AGING framing).
  const cleared = saleUpdateSchema.parse({ dueDate: null });
  eq(cleared.dueDate, null, "PATCH: null dueDate → null (explicit clear)");
  // value → §84 midnoon instant.
  const restated = saleUpdateSchema.parse({ dueDate: "2026-12-05" });
  ok(
    "PATCH: stated dueDate → §84 midnoon Date",
    restated.dueDate instanceof Date && restated.dueDate.toISOString() === "2026-12-05T12:00:00.000Z",
    String(restated.dueDate),
  );
  // garbage still rejected by the SHARED date-only law.
  let threw = false;
  try {
    saleUpdateSchema.parse({ dueDate: "2026-02-30" });
  } catch {
    threw = true;
  }
  ok("PATCH: garbage dueDate rejected (shared §84 law)", threw);

  // issueDate: absent → undefined; a REAL ISO instant → Date; null is NOT
  // a clear (the column is NOT NULL — a null payload degrades to untouched).
  eq(saleUpdateSchema.parse({}).issueDate, undefined, "PATCH: absent issueDate → undefined");
  const moved = saleUpdateSchema.parse({ issueDate: "2026-10-01T09:30:00.000Z" });
  ok(
    "PATCH: ISO issueDate → Date",
    moved.issueDate instanceof Date && moved.issueDate.toISOString() === "2026-10-01T09:30:00.000Z",
    String(moved.issueDate),
  );
  eq(saleUpdateSchema.parse({ issueDate: null }).issueDate, undefined, "PATCH: null issueDate degrades to untouched (NOT NULL column)");

  // note: full three-state text law.
  eq(saleUpdateSchema.parse({}).note, undefined, "PATCH: absent note → undefined");
  eq(saleUpdateSchema.parse({ note: null }).note, null, "PATCH: null note → null (clear)");
  eq(saleUpdateSchema.parse({ note: "" }).note, null, "PATCH: empty note → null (clear)");
  eq(saleUpdateSchema.parse({ note: "  Net-30 confirmed  " }).note, "Net-30 confirmed", "PATCH: note trimmed");

  // Money is structurally out of the PATCH vocabulary — unknown keys are
  // stripped by zod, so a tampered payload can never move totals.
  const stripped = saleUpdateSchema.parse({ totalMinor: 1, paidMinor: 999 } as Record<string, unknown>);
  ok("PATCH: money fields structurally stripped", !("totalMinor" in stripped) && !("paidMinor" in stripped));
}

/* [7] R83 dueBeforeIssue — the ONE write-side ordering gate */
{
  const issue = new Date("2026-10-24T10:00:00.000Z");
  ok("same DAY never 'before' (due==issue)", dueBeforeIssue(new Date("2026-10-24T12:00:00.000Z"), issue, "UTC") === false);
  ok("due strictly before issue → gate trips", dueBeforeIssue(new Date("2026-10-23T12:00:00.000Z"), issue, "UTC") === true);
  ok("due after issue → gate silent", dueBeforeIssue(new Date("2026-10-25T12:00:00.000Z"), issue, "UTC") === false);

  // The BUSINESS timezone governs: an issue instant at 21:00Z is ALREADY
  // the NEXT calendar day in Tehran (+03:30). A due day that looks legal
  // in UTC (same UTC day) is a breach in the business timezone — the gate
  // must catch it, mirroring the read-side isPastDueDay arithmetic.
  const tehranLateIssue = new Date("2026-10-24T21:00:00.000Z"); // Tehran: Oct 25, 00:30
  eq(
    localDayIndex(tehranLateIssue, "Asia/Tehran") - localDayIndex(tehranLateIssue, "UTC"),
    1,
    "fixture: 21:00Z issue lands on the NEXT Tehran calendar day",
  );
  ok(
    "business-tz gate: UTC-legal due day is a Tehran breach",
    dueBeforeIssue(new Date("2026-10-24T12:00:00.000Z"), tehranLateIssue, "Asia/Tehran") === true,
  );
  ok(
    "same pair judged in UTC stays legal (tz is the caller's law)",
    dueBeforeIssue(new Date("2026-10-24T12:00:00.000Z"), tehranLateIssue, "UTC") === false,
  );
  // A corrected issue day can drag an existing due day below it — the
  // effective-pair gate (PATCH route) evaluates the POST-patch pair.
  ok(
    "effective-pair semantics: backdated issue + kept due can breach",
    dueBeforeIssue(new Date("2026-10-24T12:00:00.000Z"), new Date("2026-10-30T10:00:00.000Z"), "UTC") === true,
  );
}

console.log(`\nr81-sale-terms-unit: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
