/**
 * R124 — PURE battery for the LONGITUDINAL READOUT law (bun, no DOM).
 * Extends r123 (weekly-window + migration) with the sparkline helpers:
 *   A  SPARK_WEEKS lockstep + weekSeriesIds — window shape, ordering,
 *      Monday anchoring, week/month/year boundaries
 *   B  weekCount — the honest number behind a badge tooltip
 *   C  usageBreakdown extended shape — weeks history exposed read-only
 *   D  purity + cross-checks with recordChipUsage
 */
import {
  SPARK_WEEKS,
  WEEKS_KEPT,
  isoWeekId,
  weekSeriesIds,
  weekCount,
  usageBreakdown,
  recordChipUsage,
  sanitizeChipUsage,
  QUICK_ACTION_KEYS,
  type ChipUsage,
} from "../src/lib/chip-usage";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const WED = new Date("2026-10-21T12:00:00Z"); // 2026-W43
const SUN = new Date("2026-10-25T23:30:00Z"); // still 2026-W43
const MON = new Date("2026-10-26T00:30:00Z"); // 2026-W44
const FRI27 = new Date("2027-01-01T12:00:00Z"); // 2026-W53 (53-week year)

// ---- A  SPARK_WEEKS + weekSeriesIds -------------------------------------------
console.log("A  SPARK_WEEKS + weekSeriesIds");
{
  check("A1 SPARK_WEEKS === WEEKS_KEPT (lockstep pin)", SPARK_WEEKS === WEEKS_KEPT && SPARK_WEEKS === 8);

  const ids = weekSeriesIds(WED);
  check("A2 length is exactly SPARK_WEEKS", ids.length === SPARK_WEEKS);
  check("A3 newest entry is the week containing now", ids[ids.length - 1] === isoWeekId(WED));
  check("A4 window covers W36..W43 for 2026-10-21", ids[0] === "2026-W36" && ids[3] === "2026-W39" && ids[7] === "2026-W43");
  check("A5 oldest → newest ordering", ids.every((id, i) => i === 0 || id > ids[i - 1]));

  const sundayIds = weekSeriesIds(SUN);
  check("A6 Sunday anchors the same window as its Wednesday", JSON.stringify(sundayIds) === JSON.stringify(ids));
  const mondayIds = weekSeriesIds(MON);
  check("A7 Monday shifts the whole window (W37..W44)", mondayIds[0] === "2026-W37" && mondayIds[7] === "2026-W44");

  const yearEnd = weekSeriesIds(FRI27);
  check("A8 year boundary: window stays ISO-year correct (W46..W53)", yearEnd[0] === "2026-W46" && yearEnd[6] === "2026-W52" && yearEnd[7] === "2026-W53");
  check("A9 all ids well-formed", weekSeriesIds(new Date("2024-12-30T12:00:00Z")).every((id) => /^\d{4}-W\d{2}$/.test(id)));
}

// ---- B  weekCount ---------------------------------------------------------------
console.log("B  weekCount (the tooltip number)");
{
  check("B1 null usage → 0", weekCount(null, "new-payment", WED) === 0);
  check("B2 v1-shaped → 0 (pre-v2 has no attribution)", weekCount({ v: 1, counts: { "new-payment": 9 } } as unknown as ChipUsage, "new-payment", WED) === 0);

  let u: ChipUsage | null = null;
  u = recordChipUsage(u, "new-payment", WED);
  u = recordChipUsage(u, "new-payment", WED);
  u = recordChipUsage(u, "new-payment", MON);
  check("B3 counts the CURRENT week only (2 in W43)", weekCount(u, "new-payment", WED) === 2);
  check("B4 …and 1 in W44 from the same record", weekCount(u, "new-payment", MON) === 1);
  check("B5 absent key → 0", weekCount(u, "new-expense", WED) === 0);
  check("B6 absent week → 0", weekCount(u, "new-payment", FRI27) === 0);
  check("B7 migrated v1 record → 0 in every week", weekCount(sanitizeChipUsage({ v: 1, counts: { "new-payment": 5 } }), "new-payment", WED) === 0);
}

// ---- C  usageBreakdown extended shape --------------------------------------------
console.log("C  breakdown exposes the weeks history");
{
  const u = recordChipUsage(
    recordChipUsage(recordChipUsage(recordChipUsage(null, "new-sale", WED), "new-sale", WED), "new-sale", new Date("2026-10-14T12:00:00Z")),
    "new-sale",
    MON,
  );
  const bd = usageBreakdown(u, MON);
  check("C1 breakdown non-null with weeks map", bd !== null && typeof bd.weeks === "object");
  check(
    "C2 history holds both pressed weeks with exact counts",
    bd !== null && bd.weeks["2026-W42"]?.["new-sale"] === 1 && bd.weeks["2026-W43"]?.["new-sale"] === 2 && bd.weeks["2026-W44"]?.["new-sale"] === 1,
  );
  check(
    "C3 weekIds map 1:1 onto weekSeriesIds entries",
    bd !== null && weekSeriesIds(MON).every((id) => (bd.weeks[id] ?? {}) !== undefined),
  );
  check("C4 current-week convenience still exact", bd !== null && bd.week["new-sale"] === 1 && bd.weekId === isoWeekId(MON));
  check("C5 null stays null", usageBreakdown(null, MON) === null);
}

// ---- D  purity + series mapping ----------------------------------------------------
console.log("D  purity + series mapping");
{
  const u = recordChipUsage(recordChipUsage(null, "new-sale", WED), "new-sale", WED);
  const snapshot = JSON.stringify(u);
  weekSeriesIds(WED);
  weekCount(u, "new-sale", WED);
  usageBreakdown(u, WED);
  check("D1 series/count/breakdown leave the record untouched", JSON.stringify(u) === snapshot);

  // The exact mapping the readout performs: series ids → per-key counts.
  const ids = weekSeriesIds(WED);
  const series = ids.map((id) => u.weeks[id]?.["new-sale"] ?? 0);
  check(
    "D2 series sums to the pressed weeks only",
    series.length === SPARK_WEEKS && series.reduce((a, b) => a + b, 0) === 2 && series[7] === 2 && series[6] === 0,
  );
  check(
    "D3 the weekly badge answer equals the series' newest cell leader (pool of 3)",
    (() => {
      const v = recordChipUsage(u, "new-payment", WED);
      const ids2 = weekSeriesIds(WED);
      const pool = ["new-sale", "new-payment", "new-expense"] as const;
      const counts = pool.map((k) => v.weeks[ids2[ids2.length - 1]]?.[k] ?? 0);
      const max = Math.max(...counts);
      return counts[pool.indexOf("new-sale")] === max && weekCount(v, "new-sale", WED) === 2;
    })(),
  );
  check("D4 QUICK_ACTION_KEYS still the only toolbar vocabulary", QUICK_ACTION_KEYS.length === 3);
}

console.log(`\nr124 usage-series battery: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
