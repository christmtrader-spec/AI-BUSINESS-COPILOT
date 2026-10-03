/**
 * scripts/aging-unit.ts — Payables/receivables AGING unit harness.
 *
 * Pure-function assertions over src/lib/aging.ts: fixed bucket edges,
 * negative-age clamping, day-index day-math in a real timezone (Asia/Tehran,
 * DST-free since 2022), past-due day-boundary semantics ("due Oct 5" becomes
 * overdue on Oct 6), party aggregation order determinism, integer math,
 * and the closed/open-item guard.
 *
 * Run: bun --preload ./scripts/lib/register-server-only-shim.ts scripts/aging-unit.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}${info && !cond ? ` — ${info}` : ""}`);
}

import {
  AGING_BUCKET_KEYS,
  AGING_TOP_PARTIES,
  agingBucketForAge,
  buildAgingSide,
  localDayIndex,
  localDayKey,
  type AgingItem,
} from "../src/lib/aging";

console.log("[1] bucket edges (closed ranges, negative clamped)");
ok("1a. 0 → D0_30", agingBucketForAge(0) === "D0_30");
ok("1b. 30 → D0_30 (inclusive)", agingBucketForAge(30) === "D0_30");
ok("1c. 31 → D31_60", agingBucketForAge(31) === "D31_60");
ok("1d. 60 → D31_60 (inclusive)", agingBucketForAge(60) === "D31_60");
ok("1e. 61 → D61_90", agingBucketForAge(61) === "D61_90");
ok("1f. 90 → D61_90 (inclusive)", agingBucketForAge(90) === "D61_90");
ok("1g. 91 → D90_PLUS", agingBucketForAge(91) === "D90_PLUS");
ok("1h. 10_000 → D90_PLUS", agingBucketForAge(10_000) === "D90_PLUS");
ok("1i. -5 clamps to D0_30", agingBucketForAge(-5) === "D0_30");
ok("1j. fractional floors", agingBucketForAge(30.9) === "D0_30" && agingBucketForAge(31.1) === "D31_60");

console.log("[2] day math — Asia/Tehran (+03:30 fixed, no DST since 2022)");
const TZ = "Asia/Tehran";
// 2026-10-03T12:00:00Z is 15:30 in Tehran on 2026-10-03.
const noonZ = new Date("2026-10-03T12:00:00.000Z");
ok("2a. localDayKey Tehran", localDayKey(noonZ, TZ) === "2026-10-03", localDayKey(noonZ, TZ));
ok("2b. localDayKey UTC", localDayKey(noonZ, "UTC") === "2026-10-03");
// 2026-10-03T20:30:00Z is 2026-10-04 00:00 in Tehran — day index must advance.
const lateZ = new Date("2026-10-03T20:30:00.000Z");
ok(
  "2c. Tehran rollover advances day index",
  localDayIndex(lateZ, TZ) === localDayIndex(noonZ, TZ) + 1,
);
ok("2d. UTC sees same day", localDayIndex(lateZ, "UTC") === localDayIndex(noonZ, "UTC"));
ok(
  "2e. day index is epoch-days of the LOCAL day",
  localDayIndex(new Date("2026-01-01T12:00:00Z"), "UTC") ===
    Math.floor(Date.UTC(2026, 0, 1) / 86_400_000),
);
ok("2f. invalid zone falls back to UTC", localDayKey(noonZ, "Not/AZone") === "2026-10-03");

console.log("[3] buildAgingSide — bucketing + totals (integer math)");
const now = noonZ; // Tehran 2026-10-03
const daysAgoTehranDay = (n: number) =>
  new Date(now.getTime() - n * 86_400_000); // 12:00Z minus n days → same Tehran wall time
const items: AgingItem[] = [
  { anchor: daysAgoTehranDay(10), balanceMinor: 100_000, party: "A" }, // D0_30
  { anchor: daysAgoTehranDay(45), balanceMinor: 200_000, party: "B" }, // D31_60
  { anchor: daysAgoTehranDay(75), balanceMinor: 300_000, party: "A" }, // D61_90
  { anchor: daysAgoTehranDay(120), balanceMinor: 400_000, party: "C" }, // D90_PLUS
];
const side = buildAgingSide(items, { timeZone: TZ, now });
ok("3a. total integer sum", side.totalMinor === 1_000_000, String(side.totalMinor));
ok("3b. openCount", side.openCount === 4);
ok("3c. exactly 4 buckets in closed order", side.buckets.length === 4 && side.buckets.every((b, i) => b.key === AGING_BUCKET_KEYS[i]));
ok("3d. D0_30 bucket", side.buckets[0].minor === 100_000 && side.buckets[0].count === 1);
ok("3e. D31_60 bucket", side.buckets[1].minor === 200_000 && side.buckets[1].count === 1);
ok("3f. D61_90 bucket", side.buckets[2].minor === 300_000 && side.buckets[2].count === 1);
ok("3g. D90_PLUS bucket", side.buckets[3].minor === 400_000 && side.buckets[3].count === 1);
ok(
  "3h. bucket sum equals total (invariant)",
  side.buckets.reduce((n, b) => n + b.minor, 0) === side.totalMinor,
);
ok(
  "3i. bucket count sum equals openCount",
  side.buckets.reduce((n, b) => n + b.count, 0) === side.openCount,
);

console.log("[4] party aggregation — merge, oldest-age, deterministic order");
const multi = buildAgingSide(
  [
    { anchor: daysAgoTehranDay(5), balanceMinor: 50, party: "A" },
    { anchor: daysAgoTehranDay(80), balanceMinor: 20, party: "A" }, // same party, oldest 80
    { anchor: daysAgoTehranDay(1), balanceMinor: 10, party: "B" },
    { anchor: daysAgoTehranDay(2), balanceMinor: 5, party: null },
  ],
  { timeZone: TZ, now },
);
const pa = multi.topParties.find((p) => p.name === "A");
ok("4a. same-party rows merged", pa?.openCount === 2 && pa?.balanceMinor === 70, JSON.stringify(pa));
ok("4b. oldest age wins", pa?.oldestDays === 80);
ok("4c. order: balance desc", multi.topParties[0]?.name === "A");
ok("4d. no-party kept and sorted after named", multi.topParties[multi.topParties.length - 1]?.name === null);
ok(
  "4e. tie-break by name asc",
  (() => {
    const s = buildAgingSide(
      [
        { anchor: daysAgoTehranDay(1), balanceMinor: 10, party: "Zeta" },
        { anchor: daysAgoTehranDay(1), balanceMinor: 10, party: "Alpha" },
      ],
      { timeZone: TZ, now },
    );
    return s.topParties[0].name === "Alpha" && s.topParties[1].name === "Zeta";
  })(),
);

console.log("[5] caps + guards");
const many = Array.from({ length: AGING_TOP_PARTIES + 5 }, (_, i) => ({
  anchor: daysAgoTehranDay(i + 1),
  balanceMinor: 100 - i,
  party: `P${i}`,
}));
ok("5a. topParties capped", buildAgingSide(many, { timeZone: TZ, now }).topParties.length === AGING_TOP_PARTIES);
ok(
  "5b. non-positive balances are ignored (closed/noise guard)",
  buildAgingSide(
    [
      { anchor: daysAgoTehranDay(1), balanceMinor: 0, party: "X" },
      { anchor: daysAgoTehranDay(1), balanceMinor: -5, party: "X" },
      { anchor: daysAgoTehranDay(1), balanceMinor: 7, party: "Y" },
    ],
    { timeZone: TZ, now },
  ).openCount === 1,
);
ok(
  "5c. fractional money truncated to integer (A08)",
  buildAgingSide([{ anchor: now, balanceMinor: 10.9, party: "F" }], { timeZone: TZ, now }).totalMinor === 10,
);

console.log("[6] past-due slice — day-boundary semantics (payables)");
const mk = (dueDaysFromNow: number, balance = 100): AgingItem => ({
  anchor: dueDaysFromNow >= 0 ? now : daysAgoTehranDay(-dueDaysFromNow),
  balanceMinor: balance,
  party: "S",
  dueDate: dueDaysFromNow >= 0 ? new Date(now.getTime() + dueDaysFromNow * 86_400_000) : daysAgoTehranDay(-dueDaysFromNow),
});
const past = buildAgingSide([mk(-1), mk(-10), mk(0), mk(5)], { timeZone: TZ, now, withPastDue: true });
ok("6a. due yesterday → past due", past.pastDueCount === 2, JSON.stringify({ c: past.pastDueCount, m: past.pastDueMinor }));
ok("6b. due TODAY is NOT past due (strictly after)", past.pastDueCount === 2 && past.pastDueMinor === 200);
ok("6c. due in future → not past due", past.pastDueCount === 2);
const noTerms = buildAgingSide(
  [
    { anchor: daysAgoTehranDay(50), balanceMinor: 100, party: "S" }, // no dueDate — never past due
  ],
  { timeZone: TZ, now, withPastDue: true },
);
ok("6d. no due date → never past due (honest)", noTerms.pastDueCount === 0 && noTerms.pastDueMinor === 0);
const noSlice = buildAgingSide([mk(-1)], { timeZone: TZ, now });
ok("6e. slice omitted without withPastDue", noSlice.pastDueMinor === undefined && noSlice.pastDueCount === undefined);

console.log("[7] anchor is date-based, not clock-based (§84 date-only)");
// Due 2026-10-02 (UTC midnoon). Today Tehran = 2026-10-03 → exactly 1 day old,
// regardless of the midnoon hour.
const dueOct2 = buildAgingSide(
  [{ anchor: new Date("2026-10-02T12:00:00.000Z"), balanceMinor: 10, party: "S", dueDate: new Date("2026-10-02T12:00:00.000Z") }],
  { timeZone: TZ, now, withPastDue: true },
);
ok("7a. exactly 1 day past due, aged into D0_30", dueOct2.pastDueCount === 1 && dueOct2.buckets[0].count === 1 && dueOct2.buckets[0].minor === 10, JSON.stringify(dueOct2.buckets));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
