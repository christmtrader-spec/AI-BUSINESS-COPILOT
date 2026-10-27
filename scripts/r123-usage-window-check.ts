/**
 * R123 — PURE battery for the WEEKLY WINDOW + HONEST MIGRATION law
 * (bun, no DOM). Extends r121 (record/top/sanitize law) and r122 (the
 * quick-action vocabulary) into per-ISO-week buckets:
 *   A  constants + isoWeekId — ISO-8601 anchors incl. year boundaries
 *   B  the weekly window — badges read THIS week only; totals stay true
 *   C  v1 → v2 migration — totals survive, weekly badges never (no
 *      attribution), and a 99-press all-time giant cannot buy a badge
 *   D  prune + validate weeks — WEEKS_KEPT most recent kept, junk filtered,
 *      malformed week ids rejected
 *   E  per-bucket cap — one drop rule everywhere
 *   F  usageBreakdown — the honest-numbers readout shape
 *   G  purity + round-trip + cross-surface isolation through weekly buckets
 */
import {
  CHIP_USAGE_CAP,
  WEEKS_KEPT,
  TOP_CHIP_MIN_PRESS,
  QUICK_ACTION_KEYS,
  isoWeekId,
  recordChipUsage,
  topChipUsage,
  sanitizeChipUsage,
  usageBreakdown,
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

// Fixed weeks: 2026-W43 = Mon Oct 19 – Sun Oct 25, 2026-W44 = Mon Oct 26 – Sun Nov 1.
const WED = new Date("2026-10-21T12:00:00Z"); // W43
const SUN = new Date("2026-10-25T23:30:00Z"); // W43 (last minute of the ISO week's Sunday)
const MON = new Date("2026-10-26T00:30:00Z"); // W44 (first minutes of the next ISO week)
const NEXTWED = new Date("2026-10-28T12:00:00Z"); // W44

// ---- A  constants + isoWeekId --------------------------------------------------
console.log("A  constants + isoWeekId");
{
  check("A1 constants unchanged", WEEKS_KEPT === 8 && TOP_CHIP_MIN_PRESS === 2 && CHIP_USAGE_CAP === 32);
  check("A2 2026-01-01 (Thu) → 2026-W01", isoWeekId(new Date("2026-01-01T12:00:00Z")) === "2026-W01");
  check("A3 2025-12-29 (Mon) → ISO year 2026", isoWeekId(new Date("2025-12-29T12:00:00Z")) === "2026-W01");
  check("A4 Wed 2026-10-21 → 2026-W43", isoWeekId(WED) === "2026-W43");
  check("A5 Sunday still W43 (weeks end Sunday)", isoWeekId(SUN) === "2026-W43");
  check("A6 Monday 2026-10-26 → 2026-W44", isoWeekId(MON) === "2026-W44");
  check("A7 2027-01-01 (Fri) → 2026-W53 (53-week year)", isoWeekId(new Date("2027-01-01T12:00:00Z")) === "2026-W53");
  check("A8 2026-12-28 (Mon) → 2026-W53", isoWeekId(new Date("2026-12-28T12:00:00Z")) === "2026-W53");
  check("A9 2024-12-30 (Mon) → 2025-W01", isoWeekId(new Date("2024-12-30T12:00:00Z")) === "2025-W01");
  const ids = [WED, SUN, MON, NEXTWED].map(isoWeekId);
  check("A10 format zero-padded YYYY-Www", ids.every((id) => /^\d{4}-W\d{2}$/.test(id)));
}

// ---- B  the weekly window --------------------------------------------------------
console.log("B  the weekly window (badges read THIS week only)");
{
  const w43 = recordChipUsage(recordChipUsage(null, "new-sale", WED), "new-sale", WED);
  check("B1 two presses Wednesday → badge (W43)", topChipUsage(w43, QUICK_ACTION_KEYS, WED) === "new-sale");
  check("B2 same ISO week's Sunday → badge persists", topChipUsage(w43, QUICK_ACTION_KEYS, SUN) === "new-sale");
  check("B3 next Monday → NO badge (last week's presses expired)", topChipUsage(w43, QUICK_ACTION_KEYS, MON) === null);

  const oneThisWeek = recordChipUsage(w43, "new-sale", MON);
  check("B4 one press this week is below threshold", topChipUsage(oneThisWeek, QUICK_ACTION_KEYS, MON) === null);
  const twoThisWeek = recordChipUsage(oneThisWeek, "new-sale", MON);
  check("B5 two presses this week earn the badge again", topChipUsage(twoThisWeek, QUICK_ACTION_KEYS, MON) === "new-sale");

  const bd = usageBreakdown(twoThisWeek, MON);
  check(
    "B6 totals stay true across weeks (all-time = 4)",
    bd !== null && bd.total["new-sale"] === 4 && bd.week["new-sale"] === 2 && bd.weekId === isoWeekId(MON),
  );

  // A different key races the NEW week — sale already has 2 in W44, so
  // payment ×2 is a 2–2 TIE within one week: nothing decorated (the R121
  // law, now per-week).
  const payTied = recordChipUsage(recordChipUsage(twoThisWeek, "new-payment", NEXTWED), "new-payment", NEXTWED);
  check("B7 new week, new race: 2–2 tie THIS week → nothing decorated", topChipUsage(payTied, QUICK_ACTION_KEYS, NEXTWED) === null);
  const payLeads = recordChipUsage(payTied, "new-payment", NEXTWED);
  check(
    "B8 third payment breaks the tie; W43's window still answers new-sale",
    topChipUsage(payLeads, QUICK_ACTION_KEYS, NEXTWED) === "new-payment" &&
      topChipUsage(payLeads, QUICK_ACTION_KEYS, WED) === "new-sale",
  );
}

// ---- C  v1 → v2 migration (honest absence) ---------------------------------------
console.log("C  v1 migration — totals survive, weekly badges never");
{
  const migrated = sanitizeChipUsage({ v: 1, counts: { "new-sale": 5, "new-payment": 99 } });
  check("C1 v1 record migrates to v2", migrated !== null && migrated.v === 2);
  check("C2 all-time totals preserved exactly", migrated !== null && migrated.counts["new-sale"] === 5 && migrated.counts["new-payment"] === 99);
  check("C3 weeks start EMPTY (no attribution invented)", migrated !== null && Object.keys(migrated.weeks).length === 0);
  check("C4 migrated record → NO weekly badge (any week)", migrated !== null && topChipUsage(migrated, QUICK_ACTION_KEYS, WED) === null && topChipUsage(migrated, QUICK_ACTION_KEYS, MON) === null);

  const bd = usageBreakdown(migrated, WED);
  check(
    "C5 the readout still tells the truth (99 all-time, 0 this week)",
    bd !== null && bd.total["new-payment"] === 99 && (bd.week["new-payment"] ?? 0) === 0,
  );

  // THE migration honesty check: a 99-press all-time giant cannot buy this
  // week's badge from a fresh 2-press leader.
  let u: ChipUsage | null = migrated;
  u = recordChipUsage(u, "new-sale", WED);
  u = recordChipUsage(u, "new-sale", WED);
  check("C6 2 fresh presses beat a 99 all-time giant THIS week", topChipUsage(u, QUICK_ACTION_KEYS, WED) === "new-sale");
  check("C7 …and the giant keeps its all-time 99 in the readout", usageBreakdown(u, WED)?.total["new-payment"] === 99);

  // A future version stays rejected.
  check("C8 v3 record → null", sanitizeChipUsage({ v: 3, counts: { a: 1 } }) === null);
}

// ---- D  prune + validate weeks ----------------------------------------------------
console.log("D  prune + validate week buckets");
{
  const tenWeeks: ChipUsage = {
    v: 2,
    counts: { a: 10 },
    weeks: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`2026-W${30 + i}`, { a: i + 1 }]),
    ),
  };
  const pruned = sanitizeChipUsage(tenWeeks);
  check("D1 prune keeps exactly WEEKS_KEPT", pruned !== null && Object.keys(pruned.weeks).length === WEEKS_KEPT);
  check("D2 oldest weeks dropped (W30, W31)", pruned !== null && pruned.weeks["2026-W30"] === undefined && pruned.weeks["2026-W31"] === undefined);
  check("D3 newest weeks kept (W38, W39)", pruned !== null && pruned.weeks["2026-W38"]?.a === 9 && pruned.weeks["2026-W39"]?.a === 10);
  check("D4 totals never pruned", pruned !== null && pruned.counts.a === 10);

  // Recording into a full record prunes the OLDEST and keeps the current week.
  const recorded = recordChipUsage(pruned, "a", new Date("2026-11-02T12:00:00Z")); // W45
  check(
    "D5 record prunes oldest, admits the current week",
    Object.keys(recorded.weeks).length === WEEKS_KEPT &&
      recorded.weeks["2026-W32"] === undefined &&
      recorded.weeks["2026-W45"]?.a === 1,
  );

  check("D6 malformed week id → null", sanitizeChipUsage({ v: 2, counts: { a: 1 }, weeks: { "2026-13": { a: 1 } } }) === null);
  check("D7 non-object weeks → null", sanitizeChipUsage({ v: 2, counts: { a: 1 }, weeks: "nope" }) === null);
  const junkBucket = sanitizeChipUsage({ v: 2, counts: { a: 1 }, weeks: { "2026-W43": { b: -2, c: 1.5, d: 3 } } });
  check(
    "D8 junk values filtered inside buckets, good kept",
    junkBucket !== null && junkBucket.weeks["2026-W43"] !== undefined && junkBucket.weeks["2026-W43"].b === undefined && junkBucket.weeks["2026-W43"].d === 3,
  );
  check("D9 v2 record without weeks (hand-pruned) → accepted, weeks {}", (() => {
    const u = sanitizeChipUsage({ v: 2, counts: { a: 1 } });
    return u !== null && u.v === 2 && Object.keys(u.weeks).length === 0;
  })());
}

// ---- E  per-bucket cap -------------------------------------------------------------
console.log("E  per-bucket cap (one drop rule everywhere)");
{
  const letters = "abcdefghijklmnopqrstuvwxyz123456".split(""); // 32 keys
  let u: ChipUsage | null = null;
  for (const l of letters) u = recordChipUsage(u, `k-${l}`, WED);
  u = recordChipUsage(u, "k-extra", WED); // 33rd key → the cap must drop one
  const bd = usageBreakdown(u, WED);
  check("E1 all-time capped", u !== null && Object.keys(u.counts).length === CHIP_USAGE_CAP);
  check("E2 the week bucket capped identically", bd !== null && Object.keys(bd.week).length === CHIP_USAGE_CAP);
  check(
    "E3 tie-smallest victim (k-1) dropped in both, latest press kept",
    u !== null && u.counts["k-1"] === undefined && u.counts["k-extra"] === 1 && bd !== null && bd.week["k-1"] === undefined && bd.week["k-extra"] === 1,
  );

  const overBucket = sanitizeChipUsage({
    v: 2,
    counts: { a: 1 },
    weeks: { "2026-W43": Object.fromEntries(letters.map((l, i) => [`w-${l}`, i + 1])) },
  });
  check("E4 sanitize caps buckets on read", overBucket !== null && Object.keys(overBucket.weeks["2026-W43"] ?? {}).length === CHIP_USAGE_CAP);
}

// ---- F  usageBreakdown --------------------------------------------------------------
console.log("F  usageBreakdown (the readout shape)");
{
  check("F1 null → null", usageBreakdown(null, WED) === null);
  check("F2 v1-shaped → null", usageBreakdown({ v: 1, counts: { a: 1 } } as unknown as ChipUsage, WED) === null);
  const u = recordChipUsage(recordChipUsage(recordChipUsage(null, "new-sale", WED), "new-payment", WED), "new-payment", MON);
  const bd = usageBreakdown(u, MON);
  check(
    "F3 total vs week split is exact",
    bd !== null && bd.total["new-sale"] === 1 && bd.total["new-payment"] === 2 && (bd.week["new-sale"] ?? 0) === 0 && bd.week["new-payment"] === 1,
  );
  check("F4 weekId is the queried week", bd !== null && bd.weekId === isoWeekId(MON));
  check("F5 unknown-week query → empty week, totals intact", (() => {
    const far = usageBreakdown(u, new Date("2027-03-10T12:00:00Z"));
    return far !== null && Object.keys(far.week).length === 0 && far.total["new-payment"] === 2;
  })());
}

// ---- G  purity + round-trip + isolation ----------------------------------------------
console.log("G  purity, round-trip, cross-surface isolation");
{
  const base = recordChipUsage(recordChipUsage(null, "new-sale", WED), "new-sale", WED);
  const snapshot = JSON.stringify(base);
  topChipUsage(base, QUICK_ACTION_KEYS, WED);
  recordChipUsage(base, "new-payment", WED);
  check("G1 top/record leave their input untouched", JSON.stringify(base) === snapshot);

  const revived = sanitizeChipUsage(JSON.parse(JSON.stringify(base)));
  check("G2 JSON round-trip preserves the weekly badge", revived !== null && topChipUsage(revived, QUICK_ACTION_KEYS, WED) === "new-sale");

  // Cross-surface isolation, now through weekly buckets.
  const qaHeavy = recordChipUsage(recordChipUsage(recordChipUsage(null, "new-sale", WED), "new-sale", WED), "new-sale", WED);
  check("G3 QA presses never decorate a copilot chip (W43)", topChipUsage(qaHeavy, ["suggestionTrend", "suggestion1", "suggestion2"], WED) === null);
  const copilotHeavy = recordChipUsage(recordChipUsage(recordChipUsage(null, "suggestionTrend", WED), "suggestionTrend", WED), "suggestionTrend", WED);
  check("G4 copilot presses never decorate a quick action (W43)", topChipUsage(copilotHeavy, QUICK_ACTION_KEYS, WED) === null);
  check("G5 isolation is week-scoped, not global (W44 both null)", topChipUsage(qaHeavy, QUICK_ACTION_KEYS, MON) === null && topChipUsage(copilotHeavy, ["suggestionTrend", "suggestion1"], MON) === null);
}

console.log(`\nr123 weekly-window battery: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
