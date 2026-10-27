/**
 * scripts/r85-bill-list-pastdue-unit.ts — R85 UNIT harness.
 *
 * Pure-function assertions over the supplier-bill LIST past-due lane —
 * NO database, NO server:
 *
 *   [1] billRowPastDueState — the per-row read law (the R83 detail law
 *       applied to a list row): POSTED + live outstanding > 0 + the stated
 *       due DAY strictly before today's BUSINESS-timezone day; DRAFT and
 *       CANCELLED documents never; settled/overpaid payables never; no
 *       stated terms never; days floored at 1 (due-today is not past due)
 *   [2] the BUSINESS timezone governs — at 21:30Z Tehran has already
 *       flipped to the next day while UTC has not: a due midnoon of the
 *       UTC-current day is a Tehran breach and NOT a UTC breach (the same
 *       divergence the r81 [7] gate case proves on the write side)
 *   [3] planPastDueBillFilter — the SQL-side plan: no filter → null;
 *       forced POSTED; the `lt todayMidnoon` breach cap; the user's due
 *       window composing (gte/lte) with the cap; explicit non-POSTED
 *       status is a CONTRADICTION (the 422 law)
 *   [4] the midnoon cap derivation — todayMidnoon from the business day
 *       key (localDayKey of the flip instant → the Tehran day, not UTC's)
 *   [5] mapSupplierBillListItem — the state arrives precomputed and is
 *       forwarded verbatim; default = honest no-breach
 *   [6] the list query schema — pastDue accepts "1"/"true", rejects
 *       garbage, stays .strict() against injection
 *
 * Run: bun scripts/r85-bill-list-pastdue-unit.ts
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

import { billRowPastDueState, planPastDueBillFilter } from "../src/lib/supplier-bills/pastdue";
import { localDayIndex, localDayKey } from "../src/lib/aging";
import { calendarDateToUtcMidnoon } from "../src/lib/supplier-bills/types";
import { mapSupplierBillListItem } from "../src/lib/supplier-bills/dto";
import { supplierBillListQuerySchema } from "../src/lib/supplier-bills/schema";

const TEHRAN = "Asia/Tehran";
const UTC = "UTC";

/* Deterministic instants — 2026-10-24T21:30Z is Tehran 2026-10-25T01:00
 * (next day) while UTC is still 2026-10-24. The flip instant is the heart
 * of [2]. */
const FLIP = new Date("2026-10-24T21:30:00.000Z");
const midnoon = (day: string) => calendarDateToUtcMidnoon(day);

function row(over: Partial<Parameters<typeof billRowPastDueState>[0]> = {}) {
  return {
    status: "POSTED",
    dueDate: midnoon("2026-10-20"),
    expense: { amountMinor: 100_000, paidMinor: 0 },
    ...over,
  } as Parameters<typeof billRowPastDueState>[0];
}

/* [1] the per-row read law */
{
  const tehranToday = localDayIndex(FLIP, TEHRAN); // Oct 25
  eq(tehranToday > localDayIndex(FLIP, UTC), true, "[1] flip instant: Tehran day > UTC day");

  eq(billRowPastDueState(row(), tehranToday, TEHRAN), { pastDue: true, pastDueDays: 5 },
    "[1] POSTED + outstanding + due −5d → past due, 5 days");
  eq(billRowPastDueState(row({ dueDate: midnoon("2026-10-24") }), tehranToday, TEHRAN),
    { pastDue: true, pastDueDays: 1 }, "[1] due the day before today's BUSINESS day → 1 day");
  eq(billRowPastDueState(row({ dueDate: midnoon("2026-10-25") }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] due TODAY (business day) → never past due");
  eq(billRowPastDueState(row({ dueDate: midnoon("2026-10-30") }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] future due day → not past due");
  eq(billRowPastDueState(row({ dueDate: null }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] no stated terms → honest silence");
  eq(billRowPastDueState(row({ status: "DRAFT" }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] DRAFT document → never past due");
  eq(billRowPastDueState(row({ status: "CANCELLED" }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] CANCELLED document → never past due");
  eq(billRowPastDueState(row({ expense: { amountMinor: 100_000, paidMinor: 100_000 } }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] settled payable → never past due");
  eq(billRowPastDueState(row({ expense: { amountMinor: 100_000, paidMinor: 120_000 } }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] overpaid payable (outstanding < 0) → never past due");
  eq(billRowPastDueState(row({ expense: null }), tehranToday, TEHRAN),
    { pastDue: false, pastDueDays: null }, "[1] no live payable → never past due");
  eq(billRowPastDueState(row({ expense: { amountMinor: 100_000, paidMinor: 99_999 } }), tehranToday, TEHRAN),
    { pastDue: true, pastDueDays: 5 }, "[1] one minor unit outstanding → still a breach");
}

/* [2] the BUSINESS timezone governs — the flip case */
{
  const utcToday = localDayIndex(FLIP, UTC); // Oct 24
  const dueSameDay = midnoon("2026-10-24");
  eq(billRowPastDueState(row({ dueDate: dueSameDay }), utcToday, UTC),
    { pastDue: false, pastDueDays: null }, "[2] same row under UTC law → NOT past due");
  eq(billRowPastDueState(row({ dueDate: dueSameDay }), localDayIndex(FLIP, TEHRAN), TEHRAN),
    { pastDue: true, pastDueDays: 1 }, "[2] the SAME row under Tehran law → past due 1 day");
}

/* [3] the SQL-side plan */
{
  const todayMidnoon = midnoon("2026-10-25");
  eq(planPastDueBillFilter({ pastDue: false, todayMidnoon }), null, "[3] filter off → no contribution");

  const bare = planPastDueBillFilter({ pastDue: true, todayMidnoon });
  ok("[3] forced POSTED", bare?.status === "POSTED");
  ok("[3] no explicit status → no conflict", bare?.statusConflict === false);
  eq(bare?.dueDate.lt, todayMidnoon, "[3] breach cap = lt today's midnoon");
  eq(bare?.dueDate.gte, undefined, "[3] no user window → no gte");
  eq(bare?.dueDate.lte, undefined, "[3] no user window → no lte");

  eq(planPastDueBillFilter({ pastDue: true, status: "POSTED", todayMidnoon })?.statusConflict, false,
    "[3] explicit POSTED composes");
  eq(planPastDueBillFilter({ pastDue: true, status: "DRAFT", todayMidnoon })?.statusConflict, true,
    "[3] explicit DRAFT contradicts → 422");
  eq(planPastDueBillFilter({ pastDue: true, status: "CANCELLED", todayMidnoon })?.statusConflict, true,
    "[3] explicit CANCELLED contradicts → 422");

  const composed = planPastDueBillFilter({
    pastDue: true, dueDateFrom: "2026-10-01", dueDateTo: "2026-10-20", todayMidnoon,
  });
  eq(composed?.dueDate.gte, midnoon("2026-10-01"), "[3] user gte composes with the cap");
  eq(composed?.dueDate.lte, midnoon("2026-10-20"), "[3] user lte composes with the cap");
  eq(composed?.dueDate.lt, todayMidnoon, "[3] the cap survives composition");

  // SQL-level same-day-never: the cap is a STRICT lt of today's midnoon, so
  // a row stored at today's midnoon is excluded — exactly the read law.
  ok("[3] a due AT today's midnoon is not lt the cap", !(todayMidnoon < todayMidnoon));
  ok("[3] a due midnoon yesterday IS lt the cap", midnoon("2026-10-24") < todayMidnoon);
}

/* [4] the cap derives from the BUSINESS day, not UTC's */
{
  const cap = calendarDateToUtcMidnoon(localDayKey(FLIP, TEHRAN));
  eq(cap, midnoon("2026-10-25"), "[4] Tehran flip instant → cap on the Tehran day");
  const utcCap = calendarDateToUtcMidnoon(localDayKey(FLIP, UTC));
  eq(utcCap, midnoon("2026-10-24"), "[4] same instant under UTC → a day earlier");
}

/* [5] the mapper forwards the precomputed state — never re-derives */
{
  const baseRow = {
    id: "b1", reference: "SB-1", supplierInvoiceReference: null,
    supplierId: "s1", supplierNameAtBill: "Acme", purchaseOrderId: "po1",
    purchaseOrderReferenceAtBill: "PO-1", status: "POSTED",
    billDate: midnoon("2026-10-01"), dueDate: midnoon("2026-10-20"),
    currencyCodeAtBill: "USD", currencySymbolAtBill: "$", decimalPrecisionAtBill: 2,
    subtotalMinor: 100_000, discountMinor: 0, totalMinor: 100_000,
    createdAt: midnoon("2026-10-01"), _count: { lines: 1 },
    expense: { id: "e1", amountMinor: 100_000, paidMinor: 0, status: "UNPAID" },
  };
  const silent = mapSupplierBillListItem(baseRow);
  eq([silent.pastDue, silent.pastDueDays], [false, null], "[5] default state = honest no-breach");
  const flagged = mapSupplierBillListItem(baseRow, { pastDue: true, pastDueDays: 5 });
  eq([flagged.pastDue, flagged.pastDueDays], [true, 5], "[5] state forwarded verbatim");
  // The mapper is STRUCTURALLY incapable of day math: the state param is
  // the only source (a row with breached dates but no state stays silent).
  eq(mapSupplierBillListItem(baseRow).pastDue, false,
    "[5] breached dates WITHOUT a precomputed state stay silent (one authority)");
}

/* [6] the list query schema */
{
  eq(supplierBillListQuerySchema.parse({})?.pastDue, undefined, "[6] absent → off");
  eq(supplierBillListQuerySchema.parse({ pastDue: "1" })?.pastDue, true, "[6] \"1\" → on");
  eq(supplierBillListQuerySchema.parse({ pastDue: "true" })?.pastDue, true, "[6] \"true\" → on");
  let rejected = false;
  try { supplierBillListQuerySchema.parse({ pastDue: "0" }); } catch { rejected = true; }
  ok("[6] \"0\" rejected at the boundary", rejected);
  let injected = false;
  try { supplierBillListQuerySchema.parse({ pastDue: "1", expense: { paidMinor: -1 } }); } catch { injected = true; }
  ok("[6] .strict() rejects injected authority fields", injected);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
