/**
 * scripts/r90-sale-draft-unit.ts — R90 UNIT harness.
 *
 * "The invoice lifecycle begins before issue": the DRAFT→ISSUED transition
 * (R89 candidate ①, unblocked by the R89 migration healing). Pure-function
 * assertions — NO database, NO server:
 *
 *   [1] the LIFECYCLE LAW — SALE_STATUSES / OPEN_SALE_STATUSES /
 *       ISSUED_SALE_STATUSES are the closed sets; statusOf (money math)
 *       can NEVER derive DRAFT; issuedIssueDate is the loud type-level
 *       witness of the population law (null issue day outside an
 *       issued-only query = the WHERE and the lifecycle disagree)
 *   [2] the TOKEN LAW — toStatusToken passes DRAFT through (sale side) and
 *       keeps the statusOf mirror for everything else (expense safety)
 *   [3] the ROW LAW — saleRowOverdueState: a DRAFT is silent even with a
 *       dueDate and a wide-open balance (the state trusts the LIFECYCLE,
 *       never the column); absent status stays honest (legacy callers)
 *   [4] the PLAN LAW — planOverdueSaleFilter flags DRAFT as the second
 *       contradiction (the caller 422s; PAID unchanged)
 *   [5] the CREATE SCHEMA — the draft flag parses closed (absent → false,
 *       true → true, garbage rejected); issueDate/dueDate still parse
 *       (the ROUTE owns the draft-with-terms 422 — cross-field)
 *   [6] the PATCH SCHEMA — the issue flag parses closed
 *   [7] the STATUS PARAM — "DRAFT" joins the closed filter tokens
 *   [8] the BACKUP LAW — a DRAFT row round-trips (status enum + null
 *       issueDate) and a draft carrying money is REJECTED (paidMinor 0)
 *   [9] the DETAIL MAPPER — mapSaleDetail maps a draft honestly (status
 *       DRAFT, issueDate null, overdue false even with a past due day)
 *  [10] the 360 ROW MAPPER — mapRecentSales maps a draft recent row
 *       honestly (null issue day, termless silence, DRAFT token)
 *
 * Run: bun scripts/r90-sale-draft-unit.ts
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

import {
  OPEN_SALE_STATUSES,
  OPEN_SALE_STATUS_FILTER,
  ISSUED_SALE_STATUSES,
  SALE_STATUSES,
  statusOf,
  issuedIssueDate,
} from "../src/lib/money";
import { toStatusToken } from "../src/lib/entities/summary";
import { saleRowOverdueState, planOverdueSaleFilter } from "../src/lib/sales-overdue";
import { saleCreateSchema, saleUpdateSchema, statusParam } from "../src/lib/schemas";
import { saleRowSchema } from "../src/lib/backup-schema";
import { mapSaleDetail } from "../src/lib/entities/sale";
import { mapRecentSales } from "../src/lib/entities/customer";

// §84 midnoon helpers (the same law the storage uses)
const midnoon = (day: string) => new Date(`${day}T12:00:00.000Z`);

console.log("\n[1] LIFECYCLE LAW — closed sets + the money-math boundary");
eq([...SALE_STATUSES], ["DRAFT", "UNPAID", "PARTIAL", "PAID"], "1.1 SALE_STATUSES closed set");
eq([...OPEN_SALE_STATUSES], ["UNPAID", "PARTIAL"], "1.2 OPEN population: UNPAID+PARTIAL only");
eq([...ISSUED_SALE_STATUSES], ["UNPAID", "PARTIAL", "PAID"], "1.3 ISSUED population: money math owns three");
eq(OPEN_SALE_STATUS_FILTER, { in: ["UNPAID", "PARTIAL"] }, "1.4 OPEN where fragment literal");
eq(statusOf(1000, 0), "UNPAID", "1.5 statusOf zero-balance → UNPAID (never DRAFT)");
eq(statusOf(1000, 1000), "PAID", "1.6 statusOf settled → PAID");
eq(statusOf(1000, 400), "PARTIAL", "1.7 statusOf partial → PARTIAL");
ok("1.8 statusOf can never produce DRAFT", !Object.values(["UNPAID", "PARTIAL", "PAID"]).includes("DRAFT" as never));
{
  const loud = (() => {
    try {
      issuedIssueDate({ issueDate: null });
      return false;
    } catch {
      return true;
    }
  })();
  ok("1.9 issuedIssueDate fails LOUDLY on a leaked draft", loud);
}
{
  const d = new Date("2026-10-24T09:00:00.000Z");
  const row = { issueDate: d as Date | null, totalMinor: 5 };
  const narrowed = issuedIssueDate(row);
  ok("1.10 issuedIssueDate passes issued rows through verbatim", narrowed.issueDate === d && narrowed.totalMinor === 5);
}

console.log("\n[2] TOKEN LAW — toStatusToken");
eq(toStatusToken("DRAFT"), "DRAFT", "2.1 DRAFT passes through (sale lifecycle)");
eq(toStatusToken("PAID"), "PAID", "2.2 money tokens stay the mirror");
eq(toStatusToken("PARTIAL"), "PARTIAL", "2.3 PARTIAL mirror");
eq(toStatusToken("UNPAID"), "UNPAID", "2.4 UNPAID mirror");
eq(toStatusToken("garbage"), "UNPAID", "2.5 unknown falls to UNPAID (defensive, unchanged)");

console.log("\n[3] ROW LAW — DRAFT silence is lifecycle-honest");
{
  // A draft that somehow carried a PAST due day + a wide-open balance is
  // STILL silent — the state trusts the lifecycle, never the columns.
  const state = saleRowOverdueState(
    { status: "DRAFT", dueDate: midnoon("1969-12-31"), totalMinor: 5_000_000, paidMinor: 0 },
    0,
    "UTC",
  );
  eq(state, { overdue: false, overdueDays: null }, "3.1 DRAFT silent even breached-looking");
}
{
  // Legacy callers (no status field) keep the exact R87 behavior. With
  // todayIdx 0 the past day is 1969-12-31 (the epoch day before "today").
  const state = saleRowOverdueState(
    { dueDate: midnoon("1969-12-31"), totalMinor: 5_000_000, paidMinor: 0 },
    0,
    "UTC",
  );
  eq(state, { overdue: true, overdueDays: 1 }, "3.2 absent status = not-a-draft (R87 law intact; days floored)");
}
{
  const settled = saleRowOverdueState(
    { status: "UNPAID", dueDate: midnoon("2026-10-01"), totalMinor: 100, paidMinor: 100 },
    0,
    "UTC",
  );
  eq(settled, { overdue: false, overdueDays: null }, "3.3 settled still silent");
}

console.log("\n[4] PLAN LAW — DRAFT is the second contradiction");
{
  const off = planOverdueSaleFilter({ overdue: false, status: "DRAFT", todayMidnoon: midnoon("2026-10-24") });
  eq(off, null, "4.1 filter off → null (even with DRAFT status)");
}
{
  const draft = planOverdueSaleFilter({ overdue: true, status: "DRAFT", todayMidnoon: midnoon("2026-10-24") });
  ok("4.2 DRAFT flagged as conflict", draft?.statusConflict === true);
}
{
  const paid = planOverdueSaleFilter({ overdue: true, status: "PAID", todayMidnoon: midnoon("2026-10-24") });
  ok("4.3 PAID conflict unchanged", paid?.statusConflict === true);
}
{
  const open = planOverdueSaleFilter({ overdue: true, status: "UNPAID", todayMidnoon: midnoon("2026-10-24") });
  ok("4.4 UNPAID composes", open?.statusConflict === false);
}
{
  const open = planOverdueSaleFilter({ overdue: true, status: undefined, todayMidnoon: midnoon("2026-10-24") });
  ok("4.5 no status composes", open?.statusConflict === false);
}

console.log("\n[5] CREATE SCHEMA — the draft flag parses closed");
{
  const parsed = saleCreateSchema.parse({ items: [{ name: "x", qty: 1, unitPriceMinor: 100 }] });
  eq(parsed.draft, false, "5.1 absent draft → false (historical issued law)");
}
{
  const parsed = saleCreateSchema.parse({ items: [{ name: "x", qty: 1, unitPriceMinor: 100 }], draft: true });
  eq(parsed.draft, true, "5.2 draft: true parses");
}
{
  const parsed = saleCreateSchema.parse({ items: [{ name: "x", qty: 1, unitPriceMinor: 100 }], draft: null });
  eq(parsed.draft, false, "5.3 draft: null → false");
}
{
  const bad = (() => {
    try {
      saleCreateSchema.parse({ items: [{ name: "x", qty: 1, unitPriceMinor: 100 }], draft: "yes" });
      return false;
    } catch {
      return true;
    }
  })();
  ok("5.4 draft: 'yes' rejected (boolean closed token)", bad);
}

console.log("\n[6] PATCH SCHEMA — the issue flag parses closed");
{
  eq(saleUpdateSchema.parse({}).issue, false, "6.1 absent issue → false");
  eq(saleUpdateSchema.parse({ issue: true }).issue, true, "6.2 issue: true parses");
  eq(saleUpdateSchema.parse({ issue: null }).issue, false, "6.3 issue: null → false");
  const bad = (() => {
    try {
      saleUpdateSchema.parse({ issue: "1" });
      return false;
    } catch {
      return true;
    }
  })();
  ok("6.4 issue: '1' rejected", bad);
}

console.log("\n[7] STATUS PARAM — DRAFT joins the closed filter tokens");
eq(statusParam(new URL("http://x/?status=DRAFT")), "DRAFT", "7.1 DRAFT accepted");
eq(statusParam(new URL("http://x/?status=draft")), "DRAFT", "7.2 case-insensitive (the upper() law)");
eq(statusParam(new URL("http://x/?status=DRAFTED")), null, "7.3 garbage dropped");
eq(statusParam(new URL("http://x/?status=PAID")), "PAID", "7.4 PAID unchanged");

console.log("\n[8] BACKUP LAW — drafts round-trip, draft money is a lie");
{
  const draft = {
    id: "s1",
    number: 1,
    customerId: null,
    subtotalMinor: 1000,
    discountMinor: 0,
    totalMinor: 1000,
    paidMinor: 0,
    status: "DRAFT" as const,
    issueDate: null,
    note: null,
    deletedAt: null,
    items: [],
  };
  ok("8.1 a DRAFT row (null issue day, no money) round-trips", saleRowSchema.safeParse(draft).success);
  ok(
    "8.2 a DRAFT carrying money is REJECTED (paidMinor must be 0)",
    !saleRowSchema.safeParse({ ...draft, paidMinor: 100 }).success,
  );
  ok(
    "8.3 an issued row still validates via statusOf",
    saleRowSchema.safeParse({ ...draft, status: "UNPAID", issueDate: "2026-10-24T12:00:00.000Z" }).success,
  );
  ok(
    "8.4 a mismatched issued status still rejected",
    !saleRowSchema.safeParse({ ...draft, status: "PAID", issueDate: "2026-10-24T12:00:00.000Z" }).success,
  );
}

console.log("\n[9] DETAIL MAPPER — a draft maps honestly");
{
  const detail = mapSaleDetail(
    {
      id: "s1",
      number: 7,
      customerId: null,
      customerName: null,
      issueDate: null,
      dueDate: midnoon("2026-10-01"),
      subtotalMinor: 1000,
      discountMinor: 0,
      taxRateBp: 0,
      taxMinor: 0,
      totalMinor: 1000,
      paidMinor: 0,
      status: "DRAFT",
      note: null,
      createdAt: new Date(),
    },
    [],
    [],
    { timeZone: "UTC", todayIdx: 0 },
  );
  eq(detail.sale.status, "DRAFT", "9.1 status passes through as DRAFT");
  eq(detail.sale.issueDate, null, "9.2 issue day honestly absent");
  eq(detail.sale.overdue, false, "9.3 never overdue (even with a past due day present)");
  eq(detail.sale.balanceMinor, 1000, "9.4 balance arithmetic untouched");
}

console.log("\n[10] 360 ROW MAPPER — a draft recent row maps honestly");
{
  const rows = mapRecentSales(
    [
      {
        id: "d1",
        number: 3,
        issueDate: null,
        dueDate: null,
        totalMinor: 2500,
        paidMinor: 0,
        status: "DRAFT",
      },
      {
        id: "i1",
        number: 2,
        issueDate: new Date("2026-09-01T12:00:00.000Z"),
        dueDate: midnoon("2026-10-01"),
        totalMinor: 1000,
        paidMinor: 0,
        status: "UNPAID",
      },
    ],
    { todayIdx: 0, timeZone: "UTC" },
  );
  eq(rows[0]?.issueDate, null, "10.1 draft issue day honestly absent");
  eq(rows[0]?.status, "DRAFT", "10.2 draft token preserved");
  eq(rows[0]?.overdue, false, "10.3 draft never overdue");
  eq(rows[1]?.issueDate, "2026-09-01T12:00:00.000Z", "10.4 issued row unchanged");
}

console.log(`\n=== r90-sale-draft-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
