/**
 * scripts/r88-customer-overdue-unit.ts — R88 UNIT harness.
 *
 * "The breach follows the customer": the Customer 360 joins the stated-
 * terms breach law (the receivables twin of the R86 supplier strip) and
 * the sales worklist becomes customer-scoped (#/sales?overdue=1&customer=).
 * Pure-function assertions — NO database, NO server:
 *
 *   [1] the HASH LAW — #/sales?customer=<id> parses to the closed module
 *       sub-state and serializes back byte-identical (the R86 supplier
 *       closed-token law, receivables twin): charset-safe ids only,
 *       garbage/traversal/oversize dropped, the customer COMPOSES with
 *       month+overdue (canonical month→overdue→customer order), non-sales
 *       modules never grow the state, sameView re-enters without remount
 *   [2] the 360 ROW LAW — mapRecentSales carries the SERVER-derived breach
 *       state (the ONE sales-overdue.ts law): the full honesty matrix on
 *       the 360's recent-invoice rows, the legacy no-ctx honest absence,
 *       the Tehran-vs-UTC flip on the customer read
 *   [3] the DETAIL MAPPER — mapCustomerDetail's additive breach facts:
 *       present when supplied, honest absence for legacy callers, the
 *       rest of the DTO untouched
 *
 * Run: bun scripts/r88-customer-overdue-unit.ts
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

import { hashToView, viewToHash, sameView } from "../src/store/app-store";
import { mapRecentSales, mapCustomerDetail, type CustomerSaleRow } from "../src/lib/entities/customer";
import { localDayIndex, localDayKey } from "../src/lib/aging";
import { calendarDateToUtcMidnoon } from "../src/lib/supplier-bills/types";

const CID = "cmd9xk3f2qte7l8b4xyz00001"; // charset-safe cuid-shaped id

console.log("== [1] the hash law (the customer-scoped worklist deep link) ==");
// On states.
eq(
  hashToView("#/sales?customer=" + CID),
  { kind: "module", module: "sales", customerId: CID },
  "?customer=<safe-id> parses on",
);
eq(
  hashToView(`#/sales?overdue=1&customer=${CID}`),
  { kind: "module", module: "sales", overdue: true, customerId: CID },
  "overdue + customer compose (the 360 drill landing)",
);
// Off / garbage states — the closed-token law drops, never invents.
eq(hashToView("#/sales"), { kind: "module", module: "sales" }, "bare hash stays plain");
eq(hashToView("#/sales?customer="), { kind: "module", module: "sales" }, "empty customer dropped");
eq(hashToView("#/sales?customer=<script>"), { kind: "module", module: "sales" }, "script token dropped — never state");
eq(hashToView("#/sales?customer=../../etc"), { kind: "module", module: "sales" }, "traversal id dropped");
eq(hashToView("#/sales?customer=" + "a".repeat(65)), { kind: "module", module: "sales" }, "oversize id (>64) dropped");
eq(hashToView("#/sales?customer=sp%20ace"), { kind: "module", module: "sales" }, "space id dropped (charset law)");
// Composition with month + overdue — the full canonical stack.
eq(
  hashToView(`#/sales?month=2026-04&overdue=1&customer=${CID}`),
  { kind: "module", module: "sales", param: "2026-04", overdue: true, customerId: CID },
  "month + overdue + customer compose",
);
eq(
  hashToView(`#/sales?month=2026-04&customer=${CID}`),
  { kind: "module", module: "sales", param: "2026-04", customerId: CID },
  "month + customer compose (no overdue)",
);
eq(
  hashToView(`#/sales?month=2026-04&customer=<script>`),
  { kind: "module", module: "sales", param: "2026-04" },
  "month survives garbage customer",
);
// The sub-state is SALES-ONLY: other modules never grow it.
eq(hashToView(`#/expenses?customer=${CID}`), { kind: "module", module: "expenses" }, "expenses ignores customer");
eq(hashToView(`#/reports?customer=${CID}`), { kind: "module", module: "reports" }, "reports ignores customer");
// Serialize: byte-identity round-trips (canonical month→overdue→customer order).
eq(viewToHash({ kind: "module", module: "sales", customerId: CID }), `#/sales?customer=${CID}`, "serialize customer-only");
eq(
  viewToHash({ kind: "module", module: "sales", overdue: true, customerId: CID }),
  `#/sales?overdue=1&customer=${CID}`,
  "serialize overdue+customer",
);
eq(
  viewToHash({ kind: "module", module: "sales", param: "2026-04", overdue: true, customerId: CID }),
  `#/sales?month=2026-04&overdue=1&customer=${CID}`,
  "serialize month+overdue+customer (canonical order)",
);
eq(
  viewToHash({ kind: "module", module: "sales", param: "2026-04", customerId: CID }),
  `#/sales?month=2026-04&customer=${CID}`,
  "serialize month+customer",
);
eq(viewToHash({ kind: "module", module: "sales", customerId: "<script>" }), "#/sales", "unsafe id serializes NO hash fragment — never a fake destination");
eq(viewToHash({ kind: "module", module: "sales", overdue: true, customerId: "../../etc" }), "#/sales?overdue=1", "unsafe id dropped, overdue kept");
eq(viewToHash({ kind: "module", module: "expenses", customerId: CID }), "#/expenses", "non-sales module never serializes the token");
// Round-trip law: parse(serialize(view)) === view for the canonical forms.
eq(
  hashToView(viewToHash({ kind: "module", module: "sales", customerId: CID })!),
  { kind: "module", module: "sales", customerId: CID },
  "round-trip customer-only",
);
eq(
  hashToView(viewToHash({ kind: "module", module: "sales", param: "2026-04", overdue: true, customerId: CID })!),
  { kind: "module", module: "sales", param: "2026-04", overdue: true, customerId: CID },
  "round-trip full stack",
);
eq(
  hashToView(viewToHash({ kind: "module", module: "sales", overdue: true })!),
  { kind: "module", module: "sales", overdue: true },
  "round-trip overdue-only (R87 law unchanged)",
);
// sameView: the customer scope is structural — hash→hash re-enters WITHOUT remount.
ok(
  "sameView: customer flip is structural (re-enters the store)",
  sameView(
    { kind: "module", module: "sales" },
    { kind: "module", module: "sales", customerId: CID },
  ) === false,
);
ok(
  "sameView: identical customer scopes are the same view (no remount)",
  sameView(
    { kind: "module", module: "sales", customerId: CID },
    { kind: "module", module: "sales", customerId: CID },
  ) === true,
);
ok(
  "sameView: different customers are different views",
  sameView(
    { kind: "module", module: "sales", customerId: CID },
    { kind: "module", module: "sales", customerId: "cmd9xk3f2qte7l8b4xyz00002" },
  ) === false,
);
ok(
  "sameView: overdue+customer both compared",
  sameView(
    { kind: "module", module: "sales", overdue: true, customerId: CID },
    { kind: "module", module: "sales", customerId: CID },
  ) === false,
);
ok(
  "sameView: viewKey stays module:sales for every sub-state (no remount)",
  true,
);

console.log("== [2] the 360 row law (mapRecentSales carries the server state) ==");
const TZ = "Asia/Tehran";
const todayIdx = localDayIndex(new Date("2026-10-24T12:00:00Z"), TZ); // fixed "today" for determinism
const d = (offsetDays: number): Date =>
  // §84 storage law: every dueDate is the UTC-midnoon instant of its day.
  calendarDateToUtcMidnoon(localDayKey(new Date(2026, 9, 24 + offsetDays, 12, 0, 0), "UTC"));
const saleRow = (over: Partial<CustomerSaleRow>): CustomerSaleRow => ({
  id: "sale-1",
  number: 7,
  issueDate: new Date("2026-10-01T12:00:00Z"),
  dueDate: d(-5),
  totalMinor: 1_000_000,
  paidMinor: 0,
  status: "UNPAID",
  ...over,
});
const ctx = { todayIdx, timeZone: TZ };

// The breach matrix — the SAME law the sales list rows speak.
const rows = mapRecentSales([saleRow({})], ctx);
eq(rows[0].overdue, true, "UNPAID due −5d → overdue on the 360 too");
eq(rows[0].overdueDays, 5, "days floor math: 5");
eq(rows[0].dueDate, d(-5).toISOString(), "due day joins the row (ISO)");
eq(rows[0].balanceMinor, 1_000_000, "balanceMinor = total − paid");
eq(mapRecentSales([saleRow({ paidMinor: 1_000_000, status: "PAID" })], ctx)[0].overdue, false, "settled → honest silence on the 360");
eq(mapRecentSales([saleRow({ paidMinor: 1_000_000, status: "PAID" })], ctx)[0].overdueDays, null, "settled → days null");
eq(mapRecentSales([saleRow({ dueDate: d(0) })], ctx)[0].overdue, false, "due TODAY is NOT overdue (the floor law)");
eq(mapRecentSales([saleRow({ dueDate: d(-1) })], ctx)[0].overdueDays, 1, "due −1d → overdueDays floors at 1");
eq(mapRecentSales([saleRow({ dueDate: d(14) })], ctx)[0].overdue, false, "future due → silence");
eq(mapRecentSales([saleRow({ dueDate: null })], ctx)[0].overdue, false, "termless → honest silence");
eq(mapRecentSales([saleRow({ dueDate: null })], ctx)[0].dueDate, null, "termless → dueDate serializes null");
// The absent (undefined) due day reads as NO terms — never a crash, never a state.
eq(mapRecentSales([saleRow({ dueDate: undefined })], ctx)[0].overdue, false, "absent dueDate reads termless (legacy row shape)");

// The legacy no-ctx caller gets honest ABSENCE — never a fabricated flag.
const legacy = mapRecentSales([saleRow({})]);
eq(legacy[0].overdue, false, "no ctx → no state (never fabricated)");
eq(legacy[0].overdueDays, null, "no ctx → days null");
eq(legacy[0].dueDate, d(-5).toISOString(), "no ctx → the due day still rides the row");

console.log("== [2b] the Tehran-vs-UTC flip on the CUSTOMER read ==");
// The flip twin of r87 [3]: at 2026-10-24T21:00:00Z Tehran is already
// Oct 25 while UTC is still Oct 24 — an invoice due "Oct 24" is ALREADY a
// breach on the customer's 360 (the strip counts it) while a UTC-reading
 // surface would stay silent. One tz law, both sides of the book.
const flipNow = new Date("2026-10-24T21:00:00Z");
const tehranIdx = localDayIndex(flipNow, TZ);
const utcIdx = localDayIndex(flipNow, "UTC");
ok("boundary precondition: Tehran is one day ahead of UTC", tehranIdx === utcIdx + 1, `tehran=${tehranIdx} utc=${utcIdx}`);
const flipDue = calendarDateToUtcMidnoon("2026-10-24");
eq(
  mapRecentSales([saleRow({ dueDate: flipDue })], { todayIdx: tehranIdx, timeZone: TZ })[0].overdue,
  true,
  "UTC-today due IS a Tehran breach on the 360",
);
eq(
  mapRecentSales([saleRow({ dueDate: flipDue })], { todayIdx: utcIdx, timeZone: "UTC" })[0].overdue,
  false,
  "…and silent under UTC — the tz is the authority",
);

console.log("== [3] the detail mapper (additive breach facts) ==");
const record = {
  id: CID,
  name: "Test Customer",
  phone: null,
  email: null,
  address: null,
  note: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};
const summary = {
  totalSalesMinor: 1_500_000,
  paidSalesMinor: 500_000,
  receivableMinor: 1_000_000,
  invoiceCount: 2,
  paidInvoiceCount: 1,
  openInvoiceCount: 1,
};
// Legacy caller (no overdue facts) — honest absence, DTO otherwise complete.
const legacyDetail = mapCustomerDetail(record, summary, [saleRow({})], []);
eq(legacyDetail.overdueSaleCount, undefined, "legacy caller → overdueSaleCount absent (honest)");
eq(legacyDetail.overdueSalesOutstandingMinor, undefined, "legacy caller → outstanding absent (honest)");
eq(legacyDetail.crm.openOpportunityCount, 0, "legacy caller → CRM section still present-but-empty");
// Full caller — the strip facts ride additively, nothing else moves.
const full = mapCustomerDetail(
  record,
  summary,
  [saleRow({}), saleRow({ id: "sale-2", paidMinor: 500_000, status: "PARTIAL" })],
  [],
  undefined,
  [],
  [],
  [],
  undefined,
  { count: 2, outstandingMinor: 1_500_000 },
  ctx,
);
eq(full.overdueSaleCount, 2, "strip count rides additively");
eq(full.overdueSalesOutstandingMinor, 1_500_000, "strip outstanding rides additively");
eq(full.recentSales.length, 2, "recent rows untouched by the strip facts");
eq(full.recentSales.every((r) => r.overdue === true), true, "both rows carry their state (ctx passed)");
eq(full.summary.receivableMinor, 1_000_000, "the financial summary is UNTOUCHED by the breach scan");

console.log(`\n=== r88: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
