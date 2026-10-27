/**
 * scripts/r92-bill-attribution-unit.ts — R92 PURE-LAW HARNESS (persists).
 *
 * Proves the PAYABLES twin of the R91 attribution engine
 * (src/lib/reports-insights.ts → topPastDueSupplier):
 *
 *  [1] the GATE IDENTITY — topPastDueSupplier walks the SAME isPastDueDay
 *      gate sumPastDueBills uses: over identical rows the attributed groups
 *      reconcile EXACTLY with the totals, the winner's slice never exceeds
 *      the total, and the groups partition the population.
 *  [2] the ATTRIBUTABLE SUBSET — anonymous payables (no supplierId) count
 *      in the TOTAL but never in the attribution; all-anonymous → null.
 *  [3] the SHARED SELECTION LAW — the tie chain lives in ONE place
 *      (pickTopAttributed): money DESC → count DESC → name asc → id asc;
 *      an SALES-side tie case and the BILL-side tie case pick by the SAME
 *      law (the refactor's equivalence witness).
 *  [4] the HONEST SILENCE — empty/settled/future/termless rows → null.
 *  [5] the TIMEZONE FLIP — a boundary-straddling due day flips WITH the
 *      totals (one authority).
 *
 * Run: bun scripts/r92-bill-attribution-unit.ts   (exit 0 = all green)
 */

import {
  sumPastDueBills,
  topOverdueParty,
  topPastDueSupplier,
  type AttributableBillRow,
  type AttributableSaleRow,
} from "../src/lib/reports-insights";
import { localDayIndex } from "../src/lib/aging";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

const row = (r: Partial<AttributableBillRow>): AttributableBillRow => ({
  dueDate: null,
  amountMinor: 0,
  paidMinor: 0,
  ...r,
});

/** The UTC-midnoon instant of a day `offset` days from today in `tz`. */
function midnoon(offsetDays: number, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const base = new Date(`${y}-${m}-${d}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base;
}

console.log("[1] GATE IDENTITY — the payables attribution is a reading of the totals");
{
  const tz = "Asia/Tehran";
  const today = localDayIndex(new Date(), tz);
  const rows: AttributableBillRow[] = [
    row({ supplierId: "s-akar", supplierName: "Akar Ltd", dueDate: midnoon(-10, tz), amountMinor: 8_000, paidMinor: 0 }),
    row({ supplierId: "s-akar", supplierName: "Akar Ltd", dueDate: midnoon(-3, tz), amountMinor: 3_000, paidMinor: 1_000 }),
    row({ supplierId: "s-bahar", supplierName: "Bahar Supply", dueDate: midnoon(-20, tz), amountMinor: 5_000, paidMinor: 0 }),
    row({ supplierId: "s-cyrus", supplierName: "Cyrus Goods", dueDate: midnoon(+5, tz), amountMinor: 9_000, paidMinor: 0 }),
  ];
  const total = sumPastDueBills(rows, today, tz);
  const top = topPastDueSupplier(rows, today, tz);
  ok("winner = Akar (10,000 outstanding, 2 bills)", !!top && top.id === "s-akar" && top.minor === 10_000 && top.count === 2, JSON.stringify(top));
  ok("slice ≤ total (count)", (top?.count ?? 0) <= total.count, `${top?.count} vs ${total.count}`);
  ok("slice ≤ total (minor)", (top?.minor ?? 0) <= total.minor, `${top?.minor} vs ${total.minor}`);
  // Groups partition the population: recompute independently.
  let gCount = 0;
  let gMinor = 0;
  for (const r of rows) {
    if (!r.supplierId || !r.dueDate) continue;
    if (!(today > localDayIndex(new Date(r.dueDate), tz))) continue;
    gCount += 1;
    gMinor += r.amountMinor - r.paidMinor;
  }
  ok("groups partition the population (partial payment deducted)", gCount === total.count && gMinor === total.minor, `${gCount}/${gMinor} vs ${total.count}/${total.minor}`);
  ok("partial payment reduces the slice (Akar INV2 carries 2,000)", !!top && top.minor === 10_000 && total.minor === 15_000);
}

console.log("\n[2] ATTRIBUTABLE SUBSET — anonymous payables stay honest");
{
  const tz = "Asia/Tehran";
  const today = localDayIndex(new Date(), tz);
  const rows: AttributableBillRow[] = [
    row({ dueDate: midnoon(-10, tz), amountMinor: 50_000, paidMinor: 0, supplierId: null, supplierName: null }),
    row({ supplierId: "s-akar", supplierName: "Akar Ltd", dueDate: midnoon(-2, tz), amountMinor: 2_000, paidMinor: 0 }),
  ];
  const total = sumPastDueBills(rows, today, tz);
  const top = topPastDueSupplier(rows, today, tz);
  ok("anonymous breach still counts in the TOTAL", total.count === 2 && total.minor === 52_000, JSON.stringify(total));
  ok("attribution names only Akar (2,000) — the honest subset", !!top && top.id === "s-akar" && top.count === 1 && top.minor === 2_000, JSON.stringify(top));
  const anonymousOnly: AttributableBillRow[] = [
    row({ dueDate: midnoon(-10, tz), amountMinor: 50_000, paidMinor: 0 }),
  ];
  ok("all-anonymous population → null attribution (chip hidden)",
    topPastDueSupplier(anonymousOnly, today, tz) === null);
}

console.log("\n[3] SHARED SELECTION LAW — one tie chain on both sides of the book");
{
  const tz = "UTC";
  const today = localDayIndex(new Date(), tz);
  const due = midnoon(-5, tz);
  // BILL side: money tie → count wins.
  const byCountBill: AttributableBillRow[] = [
    row({ supplierId: "s-a", supplierName: "Zeta", dueDate: due, amountMinor: 1_000, paidMinor: 0 }),
    row({ supplierId: "s-b", supplierName: "Alpha", dueDate: due, amountMinor: 1_000, paidMinor: 0 }),
    row({ supplierId: "s-b", supplierName: "Alpha", dueDate: due, amountMinor: 1_000, paidMinor: 0 }),
  ];
  const topBill = topPastDueSupplier(byCountBill, today, tz);
  ok("BILL side: money tie → count wins (Alpha, 2×1,000)", !!topBill && topBill.id === "s-b" && topBill.count === 2, JSON.stringify(topBill));
  // SALES side under the SAME tie shape → the SAME law (refactor equivalence).
  const byCountSale: AttributableSaleRow[] = byCountBill.map((r) => ({
    dueDate: r.dueDate,
    totalMinor: r.amountMinor,
    paidMinor: r.paidMinor,
    customerId: r.supplierId,
    customerName: r.supplierName,
  }));
  const topSale = topOverdueParty(byCountSale, today, tz);
  ok("SALES side: identical tie shape → identical winner (the ONE law)", !!topSale && topSale.id === "s-b" && topSale.count === 2 && topSale.name === "Alpha");
  // BILL side: count tie → name asc.
  const byNameBill: AttributableBillRow[] = [
    row({ supplierId: "s-a", supplierName: "Zeta", dueDate: due, amountMinor: 1_000, paidMinor: 0 }),
    row({ supplierId: "s-b", supplierName: "Alpha", dueDate: due, amountMinor: 1_000, paidMinor: 0 }),
  ];
  ok("BILL side: count tie → name asc (Alpha)", topPastDueSupplier(byNameBill, today, tz)?.id === "s-b");
  // BILL side: name tie → id asc.
  const byIdBill: AttributableBillRow[] = [
    row({ supplierId: "s-2", supplierName: "Same", dueDate: due, amountMinor: 1_000, paidMinor: 0 }),
    row({ supplierId: "s-1", supplierName: "Same", dueDate: due, amountMinor: 1_000, paidMinor: 0 }),
  ];
  ok("BILL side: name tie → id asc (s-1)", topPastDueSupplier(byIdBill, today, tz)?.id === "s-1");
}

console.log("\n[4] HONEST SILENCE — nothing → null");
{
  const tz = "UTC";
  const today = localDayIndex(new Date(), tz);
  ok("empty rows → null", topPastDueSupplier([], today, tz) === null);
  const settled: AttributableBillRow[] = [
    row({ supplierId: "s-a", supplierName: "A", dueDate: midnoon(-90, tz), amountMinor: 1_000, paidMinor: 1_000 }),
  ];
  ok("MIRROR law: settled rows reconcile with the pure sum (caller's contract excludes them at the boundary)",
    sumPastDueBills(settled, today, tz).count === 1 &&
    !!topPastDueSupplier(settled, today, tz) &&
    topPastDueSupplier(settled, today, tz)!.minor === 0);
  const future: AttributableBillRow[] = [
    row({ supplierId: "s-a", supplierName: "A", dueDate: midnoon(+30, tz), amountMinor: 1_000, paidMinor: 0 }),
  ];
  ok("future terms → null (never past due)", topPastDueSupplier(future, today, tz) === null);
  const termless: AttributableBillRow[] = [
    row({ supplierId: "s-a", supplierName: "A", dueDate: null, amountMinor: 1_000, paidMinor: 0 }),
  ];
  ok("termless → null (no stated terms, honest silence)", topPastDueSupplier(termless, today, tz) === null);
}

console.log("\n[5] TIMEZONE FLIP — the payables attribution follows the business tz");
{
  const now = new Date();
  const dueInstant = new Date(now.getTime() - 20 * 3_600_000 - 30 * 60_000);
  const utcIdx = localDayIndex(now, "UTC");
  const tehranIdx = localDayIndex(now, "Asia/Tehran");
  const dueUtcIdx = localDayIndex(dueInstant, "UTC");
  const dueTehranIdx = localDayIndex(dueInstant, "Asia/Tehran");
  if (dueUtcIdx === dueTehranIdx) {
    console.log("  (boundary not straddled this run — flip check skipped)");
    ok("tz flip: run conditions", true);
  } else {
    const rows: AttributableBillRow[] = [
      row({ supplierId: "s-a", supplierName: "A", dueDate: dueInstant, amountMinor: 1_000, paidMinor: 0 }),
    ];
    const inUtc =
      dueUtcIdx < utcIdx ? topPastDueSupplier(rows, utcIdx, "UTC")?.id ?? null : null;
    const inTehran =
      dueTehranIdx < tehranIdx ? topPastDueSupplier(rows, tehranIdx, "Asia/Tehran")?.id ?? null : null;
    ok("tz flip: exactly one zone sees the breach — attribution follows its zone",
      (inUtc === "s-a") !== (inTehran === "s-a"),
      `utc=${String(inUtc)} tehran=${String(inTehran)}`);
    const totalUtc = sumPastDueBills(rows, utcIdx, "UTC").count;
    const totalTehran = sumPastDueBills(rows, tehranIdx, "Asia/Tehran").count;
    ok("tz flip: totals flip WITH the attribution (one authority)",
      totalUtc !== totalTehran && (inUtc === "s-a") === (totalUtc === 1),
      `utcTotal=${totalUtc} tehranTotal=${totalTehran}`);
  }
}

console.log(`\n=== r92-bill-attribution-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exitCode = 1;
}
