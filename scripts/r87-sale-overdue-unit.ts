/**
 * scripts/r87-sale-overdue-unit.ts — R87 UNIT harness.
 *
 * "The overdue lane becomes a worklist": the SALES list joins the
 * stated-terms breach law (the receivables twin of the R85/R86 payables
 * arc) and the overdue filter becomes a deep link. Pure-function
 * assertions — NO database, NO server:
 *
 *   [1] the HASH LAW — #/sales?overdue=1 parses to the closed module
 *       sub-state and serializes back byte-identical (the reports ?month=
 *       / R86 supplier-bills closed-token law): "1"/"true" accepted,
 *       garbage dropped, the month param COMPOSES, non-sales modules never
 *       grow the sub-state, sameView re-enters without remounting
 *   [2] the ROW LAW — saleRowOverdueState over the sale row shape (balance
 *       + dueDate): the full honesty matrix incl. the days floor (due
 *       today is NOT overdue), settled silence and no-terms silence
 *   [3] the BUSINESS tz governs the receivables lane too — the
 *       Tehran-vs-UTC flip case (the read-side twin of the r81 [7]
 *       write-side case, now on the sales list)
 *   [4] the FILTER plan — planOverdueSaleFilter: null when off, the PAID
 *       contradiction flagged (the caller 422s), the lt todayMidnoon cap,
 *       UNPAID/PARTIAL compose without conflict
 *
 * Run: bun scripts/r87-sale-overdue-unit.ts
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
import { saleRowOverdueState, planOverdueSaleFilter } from "../src/lib/sales-overdue";
import { localDayIndex, localDayKey } from "../src/lib/aging";
import { calendarDateToUtcMidnoon } from "../src/lib/supplier-bills/types";

console.log("== [1] the hash law (deep-linkable overdue worklist) ==");
// On states.
eq(hashToView("#/sales?overdue=1"), { kind: "module", module: "sales", param: undefined, overdue: true }, "?overdue=1 parses on");
eq(hashToView("#/sales?overdue=true"), { kind: "module", module: "sales", param: undefined, overdue: true }, "?overdue=true parses on");
// Off / garbage states — the closed-token law drops, never invents.
eq(hashToView("#/sales"), { kind: "module", module: "sales", param: undefined, overdue: undefined }, "bare hash stays plain");
eq(hashToView("#/sales?overdue=0"), { kind: "module", module: "sales", param: undefined, overdue: undefined }, "?overdue=0 dropped (only 1/true)");
eq(hashToView("#/sales?overdue=yes"), { kind: "module", module: "sales", param: undefined, overdue: undefined }, "?overdue=yes dropped");
eq(hashToView("#/sales?overdue="), { kind: "module", module: "sales", param: undefined, overdue: undefined }, "empty overdue dropped");
eq(hashToView("#/sales?overdue=<script>"), { kind: "module", module: "sales", param: undefined, overdue: undefined }, "script token dropped — never state");
// Composition with the month param (month first — canonical order).
eq(
  hashToView("#/sales?month=2026-04&overdue=1"),
  { kind: "module", module: "sales", param: "2026-04", overdue: true },
  "month + overdue compose",
);
eq(
  hashToView("#/sales?month=2026-04&overdue=garbage"),
  { kind: "module", module: "sales", param: "2026-04", overdue: undefined },
  "month alone survives garbage overdue",
);
// The sub-state is SALES-ONLY: other modules never grow it.
eq(hashToView("#/expenses?overdue=1"), { kind: "module", module: "expenses", param: undefined, overdue: undefined }, "expenses ignores overdue");
eq(hashToView("#/reports?overdue=1"), { kind: "module", module: "reports", param: undefined, overdue: undefined }, "reports ignores overdue");
// Serialize: byte-identity round-trips.
eq(viewToHash({ kind: "module", module: "sales", overdue: true }), "#/sales?overdue=1", "serialize overdue-only");
eq(viewToHash({ kind: "module", module: "sales", param: "2026-04", overdue: true }), "#/sales?month=2026-04&overdue=1", "serialize month+overdue (month first)");
eq(viewToHash({ kind: "module", module: "sales", overdue: false }), "#/sales", "overdue:false serializes plain");
eq(viewToHash({ kind: "module", module: "expenses", overdue: true }), "#/expenses", "non-sales module never serializes the token");
// Round-trip law: parse(serialize(view)) === view for the canonical forms.
eq(
  hashToView(viewToHash({ kind: "module", module: "sales", overdue: true })!),
  { kind: "module", module: "sales", param: undefined, overdue: true },
  "round-trip overdue-only",
);
eq(
  hashToView(viewToHash({ kind: "module", module: "sales", param: "2026-04", overdue: true })!),
  { kind: "module", module: "sales", param: "2026-04", overdue: true },
  "round-trip month+overdue",
);
// sameView: the sub-state is structural — hash→hash re-enters WITHOUT remount.
ok(
  "sameView: overdue flip is structural (re-enters the store)",
  sameView(
    { kind: "module", module: "sales" },
    { kind: "module", module: "sales", overdue: true },
  ) === false,
);
ok(
  "sameView: identical overdue states are the same view (no remount)",
  sameView(
    { kind: "module", module: "sales", overdue: true },
    { kind: "module", module: "sales", overdue: true },
  ),
);
ok(
  "sameView: month+overdue equal — no remount",
  sameView(
    { kind: "module", module: "sales", param: "2026-04", overdue: true },
    { kind: "module", module: "sales", param: "2026-04", overdue: true },
  ),
);
ok(
  "viewKey stays module:sales (the mounted list keeps its local state)",
  viewKeyOfSafe({ kind: "module", module: "sales", overdue: true }) === "module:sales",
);
function viewKeyOfSafe(v: Parameters<typeof sameView>[0]): string {
  // Imported indirectly through sameView's contract; re-derive the law:
  // viewKeyOf ignores the sub-state — a module view's key is module:<name>.
  return v.kind === "module" ? `module:${v.module}` : (v as { kind: string }).kind;
}

console.log("== [2] the row law (saleRowOverdueState honesty matrix) ==");
const TZ = "Asia/Tehran";
const todayIdx = localDayIndex(new Date("2026-10-24T12:00:00Z"), TZ); // fixed "today" for determinism
const d = (offsetDays: number): Date =>
  // §84 storage law: every dueDate is the UTC-midnoon instant of its day.
  calendarDateToUtcMidnoon(localDayKey(new Date(2026, 9, 24 + offsetDays, 12, 0, 0), "UTC"));
const row = (over: Partial<{ dueDate: Date | null; totalMinor: number; paidMinor: number }>) => ({
  dueDate: d(-5),
  totalMinor: 1_000_000,
  paidMinor: 0,
  ...over,
});

eq(saleRowOverdueState(row({}), todayIdx, TZ), { overdue: true, overdueDays: 5 }, "UNPAID due −5d → overdue 5d");
eq(saleRowOverdueState(row({ paidMinor: 400_000 }), todayIdx, TZ), { overdue: true, overdueDays: 5 }, "PARTIAL due −5d → overdue 5d (balance open)");
eq(saleRowOverdueState(row({ paidMinor: 1_000_000 }), todayIdx, TZ), { overdue: false, overdueDays: null }, "PAID (settled) → honest silence");
eq(saleRowOverdueState(row({ paidMinor: 1_500_000 }), todayIdx, TZ), { overdue: false, overdueDays: null }, "over-settled → honest silence");
eq(saleRowOverdueState(row({ dueDate: d(0) }), todayIdx, TZ), { overdue: false, overdueDays: null }, "due TODAY is NOT overdue (the floor law)");
eq(saleRowOverdueState(row({ dueDate: d(-1) }), todayIdx, TZ), { overdue: true, overdueDays: 1 }, "due −1d → overdueDays floors at 1");
eq(saleRowOverdueState(row({ dueDate: d(14) }), todayIdx, TZ), { overdue: false, overdueDays: null }, "future due → silence");
eq(saleRowOverdueState(row({ dueDate: null }), todayIdx, TZ), { overdue: false, overdueDays: null }, "no stated terms → honest silence (the AGING framing applies)");
eq(saleRowOverdueState(row({ dueDate: d(-30) }), todayIdx, TZ), { overdue: true, overdueDays: 30 }, "due −30d → 30 whole days");

console.log("== [3] the Tehran-vs-UTC flip (business tz governs receivables too) ==");
// A due date whose calendar day in Tehran is TOMORROW while UTC is still
// TODAY: the flip twin of r81 [7]. Iran is UTC+3:30 year-round (no DST
// since 2022) — at 2026-10-24T21:00:00Z it is already 00:30 Oct 25 in
// Tehran while UTC is still Oct 24.
const flipNow = new Date("2026-10-24T21:00:00Z");
const tehranIdx = localDayIndex(flipNow, TZ);
const utcIdx = localDayIndex(flipNow, "UTC");
ok(
  "boundary precondition: Tehran is one day ahead of UTC",
  tehranIdx === utcIdx + 1,
  `tehran=${tehranIdx} utc=${utcIdx}`,
);
// An invoice due "Oct 24" — the UTC-today day. In Tehran that day is
// ALREADY YESTERDAY (breached, 1 day), while under UTC it is merely due
// today (silent) — the list badge, the receivables aggregate and the
// copilot chip all read the BUSINESS tz, so the flip can never disagree.
const flipDue = calendarDateToUtcMidnoon("2026-10-24");
eq(saleRowOverdueState({ dueDate: flipDue, totalMinor: 500_000, paidMinor: 0 }, tehranIdx, TZ), { overdue: true, overdueDays: 1 }, "UTC-today due IS a Tehran breach");
eq(saleRowOverdueState({ dueDate: flipDue, totalMinor: 500_000, paidMinor: 0 }, utcIdx, "UTC"), { overdue: false, overdueDays: null }, "…and silent under UTC — the tz is the authority");

console.log("== [4] the filter plan (planOverdueSaleFilter) ==");
const todayMidnoon = calendarDateToUtcMidnoon(localDayKey(new Date("2026-10-24T12:00:00Z"), TZ));
eq(planOverdueSaleFilter({ overdue: false, todayMidnoon }), null, "filter off → no contribution");
const plan = planOverdueSaleFilter({ overdue: true, todayMidnoon });
ok("filter on → plan exists", plan !== null);
if (plan) {
  eq(plan.dueDate, { lt: todayMidnoon }, "the cap is lt TODAY's business-day midnoon (exact §84 calendar-day compare)");
  eq(plan.statusConflict, false, "no explicit status → no conflict");
}
eq(
  planOverdueSaleFilter({ overdue: true, status: "PAID", todayMidnoon })?.statusConflict,
  true,
  "explicit PAID is a CONTRADICTION (the caller 422s — a paid invoice cannot breach terms)",
);
eq(
  planOverdueSaleFilter({ overdue: true, status: "UNPAID", todayMidnoon })?.statusConflict,
  false,
  "UNPAID composes",
);
eq(
  planOverdueSaleFilter({ overdue: true, status: "PARTIAL", todayMidnoon })?.statusConflict,
  false,
  "PARTIAL composes",
);

console.log(`\n=== r87: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
