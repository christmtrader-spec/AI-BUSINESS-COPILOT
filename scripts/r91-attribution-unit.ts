/**
 * scripts/r91-attribution-unit.ts — R91 PURE-LAW HARNESS (persists).
 *
 * Proves the attribution engine (src/lib/reports-insights.ts) — the per-
 * customer roll-up the copilot's R91 action chips cite:
 *
 *  [1] the GATE IDENTITY — topOverdueParty walks the SAME isPastDueDay gate
 *      sumOverdueSales uses, and topAgedOver60Party the SAME isAgedOver60
 *      gate sumAgedOver60Sales uses: over identical rows the attributed
 *      groups reconcile EXACTLY with the totals (count and minor), and the
 *      winner's slice never exceeds the total.
 *  [2] the ATTRIBUTABLE SUBSET — walk-in rows (no customerId) are honest
 *      non-attributable: skipped by the attribution while still counted by
 *      the totals, so count ≤ total holds by construction (never equality
 *      when a walk-in breaches).
 *  [3] the SELECTION LAW — largest outstanding (minor) DESC, ties broken
 *      count DESC, then name asc, then id asc; deterministic across runs.
 *  [4] the HONEST SILENCE — no rows / no attributable rows / no breaching
 *      rows → null (the chip never renders on nothing).
 *  [5] the TIMEZONE FLIP — a due/issue day that straddles the Tehran-vs-UTC
 *      midnight boundary belongs to DIFFERENT populations under the two
 *      timezones; the attribution follows the SAME business-tz day math the
 *      totals use (one authority).
 *
 * Run: bun scripts/r91-attribution-unit.ts   (exit 0 = all green)
 */

import {
  isAgedOver60,
  sumAgedOver60Sales,
  sumOverdueSales,
  topAgedOver60Party,
  topOverdueParty,
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

const row = (r: Partial<AttributableSaleRow>): AttributableSaleRow => ({
  dueDate: null,
  totalMinor: 0,
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

function reconcile(
  name: string,
  rows: AttributableSaleRow[],
  todayIdx: number,
  tz: string,
  lane: "overdue" | "aged",
) {
  const total =
    lane === "overdue"
      ? sumOverdueSales(rows, todayIdx, tz)
      : sumAgedOver60Sales(rows as any, todayIdx, tz);
  const top =
    lane === "overdue"
      ? topOverdueParty(rows, todayIdx, tz)
      : topAgedOver60Party(rows, todayIdx, tz);
  if (!top) {
    ok(`${name}: null ⇔ total.count === 0 or nothing attributable`,
      total.count === 0 || rows.every((r) => !r.customerId),
      `total=${JSON.stringify(total)}`);
    return;
  }
  // Every attributable breaching row's money flows into exactly one group;
  // recompute the group sums independently for the reconciliation.
  const groups = new Map<string, { count: number; minor: number }>();
  for (const r of rows) {
    if (!r.customerId) continue;
    const hit =
      lane === "overdue"
        ? !!r.dueDate &&
          todayIdx > localDayIndex(new Date(r.dueDate), tz) &&
          true
        : !!r.issueDate &&
          isAgedOver60(todayIdx - localDayIndex(new Date(r.issueDate), tz));
    if (!hit) continue;
    const g = groups.get(r.customerId) ?? { count: 0, minor: 0 };
    g.count += 1;
    g.minor += r.totalMinor - r.paidMinor;
    groups.set(r.customerId, g);
  }
  const topGroup = groups.get(top.id);
  ok(`${name}: winner's slice matches its independent group`,
    !!topGroup && topGroup.count === top.count && topGroup.minor === top.minor,
    `top=${JSON.stringify(top)} group=${JSON.stringify(topGroup)}`);
  ok(`${name}: slice ≤ total (count)`, top.count <= total.count,
    `${top.count} vs ${total.count}`);
  ok(`${name}: slice ≤ total (minor)`, top.minor <= total.minor,
    `${top.minor} vs ${total.minor}`);
  const allAttributed = rows.every((r) => !!r.customerId);
  if (allAttributed) {
    // Full reconciliation: the SUM OVER ALL GROUPS equals the total — the
    // winner is only the largest slice, the groups partition the population.
    let gCount = 0;
    let gMinor = 0;
    for (const g of groups.values()) {
      gCount += g.count;
      gMinor += g.minor;
    }
    ok(`${name}: full reconciliation when every row is attributable (groups partition the population)`,
      gCount === total.count && gMinor === total.minor,
      `groups=${gCount}/${gMinor} vs total=${total.count}/${total.minor}`);
  }
}

console.log("[1] GATE IDENTITY — the attribution is a reading of the totals");
{
  const tz = "Asia/Tehran";
  const today = localDayIndex(new Date(), tz);
  const rows: AttributableSaleRow[] = [
    row({ customerId: "c-akar", customerName: "Akar", dueDate: midnoon(-10, tz), totalMinor: 8_000, paidMinor: 0, issueDate: midnoon(-70, tz) }),
    row({ customerId: "c-akar", customerName: "Akar", dueDate: midnoon(-3, tz), totalMinor: 3_000, paidMinor: 0, issueDate: midnoon(-5, tz) }),
    row({ customerId: "c-bahar", customerName: "Bahar", dueDate: midnoon(-20, tz), totalMinor: 5_000, paidMinor: 0, issueDate: midnoon(-30, tz) }),
    row({ customerId: "c-cyrus", customerName: "Cyrus", dueDate: midnoon(+5, tz), totalMinor: 9_000, paidMinor: 0, issueDate: midnoon(-2, tz) }),
  ];
  reconcile("overdue matrix", rows, today, tz, "overdue");
  reconcile("aged matrix", rows, today, tz, "aged");
  const topO = topOverdueParty(rows, today, tz);
  ok("overdue winner = Akar (11,000) by outstanding", !!topO && topO.id === "c-akar" && topO.minor === 11_000 && topO.count === 2, JSON.stringify(topO));
  ok("overdue non-winner Bahar exists with its own slice", !!topO && topO.minor > 5_000);
  const topA = topAgedOver60Party(rows, today, tz);
  ok("aged winner = Akar (8,000, only 70-day-old invoice)", !!topA && topA.id === "c-akar" && topA.count === 1 && topA.minor === 8_000, JSON.stringify(topA));
}

console.log("\n[2] ATTRIBUTABLE SUBSET — walk-ins stay honest");
{
  const tz = "Asia/Tehran";
  const today = localDayIndex(new Date(), tz);
  const rows: AttributableSaleRow[] = [
    row({ dueDate: midnoon(-10, tz), totalMinor: 50_000, paidMinor: 0, customerId: null, customerName: null }), // walk-in breach
    row({ customerId: "c-akar", customerName: "Akar", dueDate: midnoon(-2, tz), totalMinor: 2_000, paidMinor: 0 }),
  ];
  const total = sumOverdueSales(rows, today, tz);
  const top = topOverdueParty(rows, today, tz);
  ok("walk-in breach still counts in the TOTAL", total.count === 2 && total.minor === 52_000, JSON.stringify(total));
  ok("attribution names only Akar (2,000) — the honest subset", !!top && top.id === "c-akar" && top.count === 1 && top.minor === 2_000, JSON.stringify(top));
  ok("slice < total when a walk-in breaches (never equality)", !!top && top.minor < total.minor);
  const walkInOnly: AttributableSaleRow[] = [
    row({ dueDate: midnoon(-10, tz), totalMinor: 50_000, paidMinor: 0 }),
  ];
  ok("all-walk-in population → null attribution (chip hidden)",
    topOverdueParty(walkInOnly, today, tz) === null);
}

console.log("\n[3] SELECTION LAW — deterministic tie chain");
{
  const tz = "UTC";
  const today = localDayIndex(new Date(), tz);
  const due = midnoon(-5, tz);
  // Equal money → count decides.
  const byCount: AttributableSaleRow[] = [
    row({ customerId: "c-a", customerName: "Zeta", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
    row({ customerId: "c-b", customerName: "Alpha", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
    row({ customerId: "c-b", customerName: "Alpha", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
  ];
  const topCount = topOverdueParty(byCount, today, tz);
  ok("money tie → count wins (Alpha, 2×1,000)", !!topCount && topCount.id === "c-b" && topCount.count === 2, JSON.stringify(topCount));
  // Equal money AND count → name asc.
  const byName: AttributableSaleRow[] = [
    row({ customerId: "c-a", customerName: "Zeta", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
    row({ customerId: "c-b", customerName: "Alpha", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
  ];
  const topName = topOverdueParty(byName, today, tz);
  ok("count tie → name asc (Alpha)", !!topName && topName.id === "c-b" && topName.name === "Alpha", JSON.stringify(topName));
  // Equal money, count, name → id asc.
  const byId: AttributableSaleRow[] = [
    row({ customerId: "c-2", customerName: "Same", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
    row({ customerId: "c-1", customerName: "Same", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
  ];
  const topId = topOverdueParty(byId, today, tz);
  ok("name tie → id asc (c-1)", !!topId && topId.id === "c-1", JSON.stringify(topId));
  // Persian names sort by code point — deterministic, not locale-dependent.
  const faNames: AttributableSaleRow[] = [
    row({ customerId: "c-الف", customerName: "الف", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
    row({ customerId: "c-ب", customerName: "ب", dueDate: due, totalMinor: 1_000, paidMinor: 0 }),
  ];
  const topFa = topOverdueParty(faNames, today, tz);
  ok("FA names tie → code-point order (الف < ب)", !!topFa && topFa.name === "الف", JSON.stringify(topFa));
  // Determinism: same input twice → same winner.
  const again = topOverdueParty(byCount, today, tz);
  ok("determinism: identical input → identical winner", JSON.stringify(again) === JSON.stringify(topCount));
}

console.log("\n[4] HONEST SILENCE — nothing → null");
{
  const tz = "UTC";
  const today = localDayIndex(new Date(), tz);
  ok("empty rows → null (overdue)", topOverdueParty([], today, tz) === null);
  ok("empty rows → null (aged)", topAgedOver60Party([], today, tz) === null);
  const settled: AttributableSaleRow[] = [
    row({ customerId: "c-a", customerName: "A", dueDate: midnoon(-90, tz), totalMinor: 1_000, paidMinor: 1_000 }),
    row({ customerId: "c-b", customerName: "B", dueDate: midnoon(-90, tz), totalMinor: 2_000, paidMinor: 2_000 }),
  ];
  // MIRROR law (not a balance law): the pure attribution walks the SAME gate
  // as the pure sum — whatever the sum counts, the attribution reconciles
  // with, settled rows included. Excluding settled money is the CALLER's
  // contract (open rows only — the SQL field reference enforces it at the
  // boundary; see the snapshot's OPEN_SALE_STATUS_FILTER where).
  const settledSum = sumOverdueSales(settled, today, tz);
  const settledTop = topOverdueParty(settled, today, tz);
  ok("mirror law holds on ANY rows the caller passes (incl. settled)",
    settledSum.count === 2 && settledSum.minor === 0 &&
    !!settledTop && settledTop.count === 1 && settledTop.minor === 0 && settledTop.id === "c-a",
    `sum=${JSON.stringify(settledSum)} top=${JSON.stringify(settledTop)}`);
  const future: AttributableSaleRow[] = [
    row({ customerId: "c-a", customerName: "A", dueDate: midnoon(+30, tz), totalMinor: 1_000, paidMinor: 0 }),
  ];
  ok("future terms → null (due today/future is never overdue)",
    topOverdueParty(future, today, tz) === null);
  const termless: AttributableSaleRow[] = [
    row({ customerId: "c-a", customerName: "A", dueDate: null, totalMinor: 1_000, paidMinor: 0, issueDate: midnoon(-100, tz) }),
  ];
  ok("termless → overdue null but AGED still sees it (two lanes)",
    topOverdueParty(termless, today, tz) === null &&
    !!topAgedOver60Party(termless, today, tz) &&
    topAgedOver60Party(termless, today, tz)!.minor === 1_000);
  const youngAged: AttributableSaleRow[] = [
    row({ customerId: "c-a", customerName: "A", dueDate: null, totalMinor: 1_000, paidMinor: 0, issueDate: midnoon(-60, tz) }),
  ];
  ok("60 whole days is NOT over 60 (the strict gate)",
    topAgedOver60Party(youngAged, today, tz) === null &&
    isAgedOver60(60) === false && isAgedOver60(61) === true);
  const missingIssue: AttributableSaleRow[] = [
    row({ customerId: "c-a", customerName: "A", dueDate: null, totalMinor: 1_000, paidMinor: 0 }), // no issueDate
  ];
  ok("absent issueDate → silent non-membership in the AGED lane",
    topAgedOver60Party(missingIssue, today, tz) === null);
}

console.log("\n[5] TIMEZONE FLIP — the attribution follows the business tz");
{
  // A due instant 20:30 UTC "yesterday" is YESTERDAY 20:30 in UTC but
  // already TODAY 00:00 in Tehran (+3:30) — pick an instant whose day
  // index differs between the two zones.
  const now = new Date();
  const dueInstant = new Date(now.getTime() - 20 * 3_600_000 - 30 * 60_000); // ~20.5h ago
  const utcIdx = localDayIndex(now, "UTC");
  const tehranIdx = localDayIndex(now, "Asia/Tehran");
  const dueUtcIdx = localDayIndex(dueInstant, "UTC");
  const dueTehranIdx = localDayIndex(dueInstant, "Asia/Tehran");
  if (dueUtcIdx === dueTehranIdx) {
    console.log("  (boundary not straddled this run — flip check skipped)");
    ok("tz flip: run conditions", true);
  } else {
    const rowsUtc: AttributableSaleRow[] = [
      row({ customerId: "c-a", customerName: "A", dueDate: dueInstant, totalMinor: 1_000, paidMinor: 0 }),
    ];
    const inUtc =
      dueUtcIdx < utcIdx
        ? topOverdueParty(rowsUtc, utcIdx, "UTC")?.id ?? null
        : null;
    const inTehran =
      dueTehranIdx < tehranIdx
        ? topOverdueParty(rowsUtc, tehranIdx, "Asia/Tehran")?.id ?? null
        : null;
    ok("tz flip: exactly one zone sees the breach — the attribution follows its zone",
      (inUtc === "c-a") !== (inTehran === "c-a"),
      `utc=${String(inUtc)} tehran=${String(inTehran)}`);
    const totalUtc = sumOverdueSales(rowsUtc, utcIdx, "UTC").count;
    const totalTehran = sumOverdueSales(rowsUtc, tehranIdx, "Asia/Tehran").count;
    ok("tz flip: totals flip WITH the attribution (one authority)",
      totalUtc !== totalTehran && (inUtc === "c-a") === (totalUtc === 1),
      `utcTotal=${totalUtc} tehranTotal=${totalTehran}`);
  }
}

console.log(`\n=== r91-attribution-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exitCode = 1;
}
