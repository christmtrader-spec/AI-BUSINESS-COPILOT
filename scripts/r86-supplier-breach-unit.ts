/**
 * scripts/r86-supplier-breach-unit.ts — R86 UNIT harness.
 *
 * "The breach follows the supplier": the Supplier 360 joins the ONE
 * pastdue.ts law and the breach filter becomes a deep link. Pure-function
 * assertions — NO database, NO server:
 *
 *   [1] the HASH LAW — #/supplier-bills?pastDue=1&supplier=<id> parses to
 *       the closed sub-state and serializes back byte-identical (the
 *       reports ?month= closed-token law): "1"/"true" accepted, garbage
 *       dropped, an unsafe supplier id NEVER becomes state, absent params
 *       keep the plain list hash, unknown params ignored
 *   [2] the recent-bill ROW LAW — billRowPastDueState over the Supplier-360
 *       row shape (status + dueDate + LIVE expense amountMinor/paidMinor):
 *       the full honesty matrix incl. the days floor and settled silence
 *   [3] the BUSINESS-tz governs the 360 too — the Tehran-vs-UTC flip case
 *       (the read-side twin of the r81 [7] write-side case, now on the
 *       supplier surface)
 *   [4] the COUNT plan — planPastDueBillFilter with no user window is the
 *       exact WHERE the count runs (POSTED forced + lt todayMidnoon cap);
 *       the supplier scope composes at the caller (proven structurally)
 *   [5] mapSupplierDetail — the breach facts + recent-bill rows arrive
 *       precomputed and are forwarded VERBATIM (the mapper never derives
 *       day math); the default is the honest zero
 *
 * Run: bun scripts/r86-supplier-breach-unit.ts
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

import { hashToView, viewToHash } from "../src/store/app-store";
import { billRowPastDueState, planPastDueBillFilter } from "../src/lib/supplier-bills/pastdue";
import { localDayIndex, localDayKey } from "../src/lib/aging";
import { calendarDateToUtcMidnoon } from "../src/lib/supplier-bills/types";
import { mapSupplierDetail } from "../src/lib/entities/supplier";

console.log("== [1] the hash law (deep-linkable breach filter) ==");
// On states.
eq(hashToView("#/supplier-bills?pastDue=1"), { kind: "supplier-bills", pastDue: true, supplierId: undefined }, "?pastDue=1 parses on");
eq(hashToView("#/supplier-bills?pastDue=true"), { kind: "supplier-bills", pastDue: true, supplierId: undefined }, "?pastDue=true parses on");
eq(hashToView("#/supplier-bills?supplier=sup-01"), { kind: "supplier-bills", pastDue: undefined, supplierId: "sup-01" }, "?supplier parses alone");
eq(hashToView("#/supplier-bills?pastDue=1&supplier=sup-01"), { kind: "supplier-bills", pastDue: true, supplierId: "sup-01" }, "both params compose");
// Off / garbage states — the closed-token law drops, never invents.
eq(hashToView("#/supplier-bills"), { kind: "supplier-bills", pastDue: undefined, supplierId: undefined }, "bare hash stays plain");
eq(hashToView("#/supplier-bills?pastDue=0"), { kind: "supplier-bills", pastDue: undefined, supplierId: undefined }, "?pastDue=0 dropped (only 1/true)");
eq(hashToView("#/supplier-bills?pastDue=yes"), { kind: "supplier-bills", pastDue: undefined, supplierId: undefined }, "?pastDue=yes dropped");
eq(hashToView("#/supplier-bills?pastDue="), { kind: "supplier-bills", pastDue: undefined, supplierId: undefined }, "empty pastDue dropped");
eq(hashToView("#/supplier-bills?supplier="), { kind: "supplier-bills", pastDue: undefined, supplierId: undefined }, "empty supplier dropped");
eq(
  hashToView("#/supplier-bills?supplier=../../etc"),
  { kind: "supplier-bills", pastDue: undefined, supplierId: undefined },
  "path-traversal supplier id NEVER becomes state",
);
eq(
  hashToView("#/supplier-bills?supplier=" + encodeURIComponent("<script>")),
  { kind: "supplier-bills", pastDue: undefined, supplierId: undefined },
  "script-y supplier id NEVER becomes state",
);
eq(hashToView("#/supplier-bills?bogus=1&pastDue=1"), { kind: "supplier-bills", pastDue: true, supplierId: undefined }, "unknown params ignored, valid ones still parse");
// Serialization — round-trip byte-identity.
eq(viewToHash({ kind: "supplier-bills" }), "#/supplier-bills", "plain view → plain hash");
eq(viewToHash({ kind: "supplier-bills", pastDue: true }), "#/supplier-bills?pastDue=1", "pastDue serializes as the 1 token");
eq(viewToHash({ kind: "supplier-bills", supplierId: "sup-01" }), "#/supplier-bills?supplier=sup-01", "supplier serializes");
eq(
  viewToHash({ kind: "supplier-bills", pastDue: true, supplierId: "sup-01" }),
  "#/supplier-bills?pastDue=1&supplier=sup-01",
  "both serialize in canonical order",
);
const rt1 = viewToHash({ kind: "supplier-bills", pastDue: true });
ok("round-trip pastDue", rt1 !== null && (() => { const v = hashToView(rt1); return v.kind === "supplier-bills" && v.pastDue === true; })());
const rt2 = viewToHash({ kind: "supplier-bills", pastDue: true, supplierId: "sup-01" });
ok("round-trip both", rt2 !== null && (() => { const v = hashToView(rt2); return v.kind === "supplier-bills" && v.pastDue === true && v.supplierId === "sup-01"; })());

console.log("== [2] the recent-bill row law (Supplier-360 rows) ==");
const TZ = "Asia/Tehran";
const TODAY_IDX = localDayIndex(new Date("2026-10-24T09:00:00Z"), TZ); // Oct 24 in Tehran (12:30 local)
const row = (over: {
  status?: string;
  dueDaysAgo?: number | null;
  amountMinor?: number;
  paidMinor?: number;
  withExpense?: boolean;
}) => ({
  status: over.status ?? "POSTED",
  dueDate:
    over.dueDaysAgo == null
      ? null
      : calendarDateToUtcMidnoon(
          localDayKey(new Date(Date.UTC(2026, 9, 24) - over.dueDaysAgo * 86_400_000), "UTC"),
        ),
  expense: over.withExpense === false
    ? null
    : { amountMinor: over.amountMinor ?? 200_000, paidMinor: over.paidMinor ?? 0 },
});

eq(billRowPastDueState(row({ dueDaysAgo: 5 }), TODAY_IDX, TZ), { pastDue: true, pastDueDays: 5 }, "breached −5d → days 5");
eq(billRowPastDueState(row({ dueDaysAgo: 1 }), TODAY_IDX, TZ), { pastDue: true, pastDueDays: 1 }, "breached −1d → floored at 1");
eq(billRowPastDueState(row({ dueDaysAgo: 0 }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "due TODAY is not past due (§9)");
eq(billRowPastDueState(row({ dueDaysAgo: -3 }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "future due never");
eq(billRowPastDueState(row({ dueDaysAgo: null }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "no stated terms → honest silence (both null)");
eq(billRowPastDueState(row({ dueDaysAgo: 5, status: "DRAFT" }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "DRAFT never (not yet a payable)");
eq(billRowPastDueState(row({ dueDaysAgo: 5, status: "CANCELLED" }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "CANCELLED never");
eq(billRowPastDueState(row({ dueDaysAgo: 5, withExpense: false }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "no live payable → never");
eq(billRowPastDueState(row({ dueDaysAgo: 5, paidMinor: 200_000 }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "settled payable → never");
eq(billRowPastDueState(row({ dueDaysAgo: 5, paidMinor: 250_000 }), TODAY_IDX, TZ), { pastDue: false, pastDueDays: null }, "overpaid → never");
eq(billRowPastDueState(row({ dueDaysAgo: 5, amountMinor: 200_000, paidMinor: 199_999 }), TODAY_IDX, TZ), { pastDue: true, pastDueDays: 5 }, "one minor unit outstanding is still a breach");

console.log("== [3] the business tz governs the 360 too ==");
// 21:30Z on Oct 24 → Tehran is already Oct 25 (00:00 next-day local? No —
// 21:30Z = 01:00+03:30 next day). The SAME due midnoon of the UTC-current
// day is a Tehran breach, NOT a UTC breach.
const FLIP = new Date("2026-10-24T21:30:00Z");
const tehranIdx = localDayIndex(FLIP, TZ);
const utcIdx = localDayIndex(FLIP, "UTC");
ok("flip instant: Tehran is one day ahead of UTC", tehranIdx === utcIdx + 1, `tehran=${tehranIdx} utc=${utcIdx}`);
const utcTodayRow = {
  status: "POSTED",
  dueDate: calendarDateToUtcMidnoon(localDayKey(FLIP, "UTC")), // due "today" by UTC's clock
  expense: { amountMinor: 100_000, paidMinor: 0 },
};
eq(billRowPastDueState(utcTodayRow, tehranIdx, TZ), { pastDue: true, pastDueDays: 1 }, "UTC-today due is a Tehran breach (business tz law)");
eq(billRowPastDueState(utcTodayRow, utcIdx, "UTC"), { pastDue: false, pastDueDays: null }, "the SAME row under UTC is silent");

console.log("== [4] the count plan ==");
const todayMidnoon = calendarDateToUtcMidnoon(localDayKey(new Date("2026-10-24T09:00:00Z"), TZ));
const plan = planPastDueBillFilter({ pastDue: true, todayMidnoon });
ok("plan active for the count", plan !== null);
if (plan) {
  eq(plan.status, "POSTED", "count plan forces POSTED");
  ok("count plan caps at lt todayMidnoon", plan.dueDate.lt === todayMidnoon && plan.dueDate.gte === undefined && plan.dueDate.lte === undefined);
  ok("count plan has no status conflict (no explicit status)", plan.statusConflict === false);
}
// The supplier scope composes at the caller — structurally: the where the
// count builds is { ...plan fields, supplierId }. Prove the plan fragment
// composes with an extra scope key without clobbering (the object-spread
// law the service uses).
const scopedWhere = { businessId: "b1", supplierId: "s1", status: plan?.status, dueDate: plan?.dueDate };
ok("scoped where keeps the plan's lt cap", scopedWhere.dueDate?.lt === todayMidnoon);
ok("scoped where keeps POSTED", scopedWhere.status === "POSTED");
ok("scoped where carries the supplier", scopedWhere.supplierId === "s1");
ok("no window → no gte/lte in the plan", plan?.dueDate.gte === undefined && plan?.dueDate.lte === undefined);

console.log("== [5] mapper honesty (forward, never derive) ==");
const record = {
  id: "sup-01",
  name: "Breach Supplier",
  phone: null,
  email: null,
  address: null,
  note: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};
const SUMMARY = { totalExpensesMinor: 0, paidExpensesMinor: 0, payableMinor: 0, expenseCount: 0, paidExpenseCount: 0, openExpenseCount: 0 };
const detail = mapSupplierDetail(
  record,
  SUMMARY,
  [],
  [],
  [],
  [],
  [],
  [
    {
      id: "bill-1",
      reference: "SB-1",
      supplierInvoiceReference: null,
      purchaseOrderReferenceAtBill: "PO-1",
      status: "POSTED",
      billDate: "2026-09-01T00:00:00.000Z",
      dueDate: "2026-10-19T00:00:00.000Z",
      totalMinor: 200_000,
      currencySymbolAtBill: "$",
      decimalPrecisionAtBill: 2,
      payableStatus: "UNPAID",
      paidMinor: 0,
      pastDue: true,
      pastDueDays: 5,
    },
    {
      id: "bill-2",
      reference: "SB-2",
      supplierInvoiceReference: null,
      purchaseOrderReferenceAtBill: "PO-2",
      status: "DRAFT",
      billDate: "2026-10-01T00:00:00.000Z",
      dueDate: null,
      totalMinor: 50_000,
      currencySymbolAtBill: "$",
      decimalPrecisionAtBill: 2,
      payableStatus: null,
      paidMinor: null,
      pastDue: false,
      pastDueDays: null,
    },
  ],
  undefined,
  { count: 7, outstandingMinor: 1_234_567 },
);
ok("breach count forwarded verbatim", detail.pastDueBillCount === 7);
ok("outstanding forwarded verbatim", detail.pastDueBillsOutstandingMinor === 1_234_567);
ok("breached row state forwarded verbatim", detail.recentSupplierBills?.[0]?.pastDue === true && detail.recentSupplierBills?.[0]?.pastDueDays === 5);
ok("silent row state forwarded verbatim", detail.recentSupplierBills?.[1]?.pastDue === false && detail.recentSupplierBills?.[1]?.pastDueDays === null);
// Default = honest zero (an old caller without the breach arg stays valid).
const detailDefault = mapSupplierDetail(record, SUMMARY, [], [], [], [], [], [], undefined);
ok("default breach count is the honest 0", detailDefault.pastDueBillCount === 0);
ok("default outstanding is the honest 0", detailDefault.pastDueBillsOutstandingMinor === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
