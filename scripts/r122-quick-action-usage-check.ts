/**
 * R122 — PURE battery for the quick-action badge law (bun, no DOM).
 *
 * The pure core (recordChipUsage / topChipUsage / sanitizeChipUsage) is
 * already pinned by r121-chip-usage-check (40 checks); this battery pins
 * the NEW R122 surface on top of it:
 *   A  QUICK_ACTION_KEYS — the exact dashboard toolbar vocabulary
 *   B  badge law over the quick-action pool — threshold, strict lead,
 *      ties, foreign keys, single-press honesty
 *   C  end-to-end press flows — realistic sequences, purity of the input
 *   D  sanitize interplay — malformed stored record → no badge, ever
 *   E  cross-surface isolation — copilot keys and quick-action keys can
 *      never elect each other's chips (separate counters, same law)
 *
 * R123: the record is v2 (counts + weekly buckets) and the badge reads the
 * CURRENT week only. All rec()/top() calls share ONE fixed instant
 * (2026-W43) for determinism; the v1-migration expectations in D reflect
 * the honest law — totals survive, weekly badges never. The weekly-window
 * law itself is pinned by r123-usage-window-check (49 checks).
 */
import {
  QUICK_ACTION_KEYS,
  recordChipUsage,
  topChipUsage,
  sanitizeChipUsage,
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

// One fixed instant → every rec()/top() pair lands in the same ISO week (2026-W43).
const NOW = new Date("2026-10-21T12:00:00Z");
const rec = (u: Parameters<typeof recordChipUsage>[0], k: string) => recordChipUsage(u, k, NOW);
const top = (u: Parameters<typeof topChipUsage>[0], keys: readonly string[]) => topChipUsage(u, keys, NOW);

// ---- A  the vocabulary -------------------------------------------------------
console.log("A  QUICK_ACTION_KEYS");
{
  check("A1 exactly three actions", QUICK_ACTION_KEYS.length === 3);
  check(
    "A2 exact keys in toolbar order",
    QUICK_ACTION_KEYS[0] === "new-sale" &&
      QUICK_ACTION_KEYS[1] === "new-payment" &&
      QUICK_ACTION_KEYS[2] === "new-expense",
  );
  check(
    "A3 no key collides with a copilot subject",
    !QUICK_ACTION_KEYS.includes("followUpTrend" as never),
  );
}

// ---- B  the badge law over the toolbar pool ----------------------------------
console.log("B  badge law over QUICK_ACTION_KEYS");
{
  check("B1 zero presses → no badge", top(null, QUICK_ACTION_KEYS) === null);
  check(
    "B2 single press → no badge (threshold honest)",
    top(rec(null, "new-sale"), QUICK_ACTION_KEYS) === null,
  );
  const sale2 = rec(rec(null, "new-sale"), "new-sale");
  check("B3 two presses on one action → badge", top(sale2, QUICK_ACTION_KEYS) === "new-sale");
  const tied = rec(rec(sale2, "new-payment"), "new-payment");
  check("B4 2–2 tie → nothing decorated", top(tied, QUICK_ACTION_KEYS) === null);
  const paymentLeads = rec(tied, "new-payment");
  check("B5 third press breaks the tie", top(paymentLeads, QUICK_ACTION_KEYS) === "new-payment");
  check(
    "B6 copilot presses in the SAME record never elect a quick action",
    top(
      rec(rec(rec(sale2, "followUpTrend"), "followUpTrend"), "followUpTrend"),
      QUICK_ACTION_KEYS,
    ) === "new-sale",
  );
  check(
    "B7 copilot-heavy record with NO real action presses → no badge",
    top(
      rec(rec(null, "followUpTrend"), "followUpTrend"),
      QUICK_ACTION_KEYS,
    ) === null,
  );
  // Retired action (a future key removed from the toolbar) sits inert.
  const retired = rec(rec(rec(sale2, "new-refund"), "new-refund"), "new-refund");
  check(
    "B8 retired action key can never win while invisible",
    top(retired, QUICK_ACTION_KEYS) === "new-sale",
  );
}

// ---- C  end-to-end press flows -----------------------------------------------
console.log("C  end-to-end press flows");
{
  // A realistic week: sale, payment, sale, payment, sale, expense.
  let u: ChipUsage | null = null;
  for (const k of ["new-sale", "new-payment", "new-sale", "new-payment", "new-sale", "new-expense"] as const) {
    u = rec(u, k);
  }
  check("C1 leader after a mixed week = new-sale", top(u, QUICK_ACTION_KEYS) === "new-sale");
  const before = JSON.stringify(u);
  top(u, QUICK_ACTION_KEYS);
  check("C2 reading the badge never mutates the record", JSON.stringify(u) === before);

  // Purity: record never mutates its input (the dashboard setState relies on it).
  const base = rec(rec(null, "new-expense"), "new-expense");
  const snapshot = JSON.stringify(base);
  rec(base, "new-sale");
  check("C3 recordChipUsage leaves its input untouched", JSON.stringify(base) === snapshot);

  // Badge follows the LIVE leader as presses accumulate.
  let v: ChipUsage | null = null;
  v = rec(v, "new-payment");
  v = rec(v, "new-payment");
  check("C4 payment leads early", top(v, QUICK_ACTION_KEYS) === "new-payment");
  for (let i = 0; i < 3; i++) v = rec(v, "new-expense");
  check("C5 badge MOVES when expense overtakes", top(v, QUICK_ACTION_KEYS) === "new-expense");
}

// ---- D  sanitize interplay -----------------------------------------------------
console.log("D  sanitize interplay (malformed storage → no badge)");
{
  const junk: unknown[] = [
    null,
    undefined,
    42,
    "new-sale",
    {},
    { v: 3, counts: { "new-sale": 9 } },
    { v: 2, counts: { "new-sale": 9 }, weeks: 42 },
    { v: 2, counts: { "new-sale": 9 }, weeks: { "2026-13": { "new-sale": 1 } } },
    { v: 1, counts: "nope" },
    { v: 1, counts: { "new-sale": "many" } },
    { v: 1, counts: { "new-sale": 0 } },
    { v: 1, counts: { "": 5 } },
  ];
  let allNull = true;
  for (const j of junk) {
    if (sanitizeChipUsage(j) !== null) allNull = false;
  }
  check("D1 every malformed shape sanitizes to null", allNull);
  check(
    "D2 null record → no badge",
    top(sanitizeChipUsage("{broken"), QUICK_ACTION_KEYS) === null,
  );
  // R123 migration law: a v1 flat record keeps its totals but has NO week
  // attribution — it must never claim a weekly badge (honest absence).
  const migrated = sanitizeChipUsage({ v: 1, counts: { "new-sale": 5, "new-payment": 1 } });
  check(
    "D3 v1 record migrates: totals survive, weeks empty",
    migrated !== null && migrated.v === 2 && migrated.counts["new-sale"] === 5 && Object.keys(migrated.weeks).length === 0,
  );
  check(
    "D3a migrated record earns NO weekly badge (any week)",
    migrated !== null && top(migrated, QUICK_ACTION_KEYS) === null,
  );
  // Once THIS week has real presses, the badge law is back in business.
  const reearned = rec(rec(migrated, "new-sale"), "new-sale");
  check(
    "D3b two fresh presses this week earn the badge again",
    top(reearned, QUICK_ACTION_KEYS) === "new-sale",
  );
  // Junk values filtered but valid ones kept — the readout stays truthful.
  const filtered = sanitizeChipUsage({ v: 1, counts: { "new-sale": 3, "new-payment": -2, bogus: 7 } });
  check(
    "D4 junk counts filtered, honest totals kept",
    filtered !== null &&
      filtered.counts["new-sale"] === 3 &&
      filtered.counts["new-payment"] === undefined &&
      filtered.counts["bogus"] === 7,
  );
}

// ---- E  cross-surface isolation ------------------------------------------------
console.log("E  cross-surface isolation");
{
  // The copilot's OWN pool must never be elected by quick-action presses.
  const qaHeavy = rec(
    rec(rec(null, "new-sale"), "new-sale"),
    "new-sale",
  );
  const copilotPool = ["suggestionTrend", "suggestion1", "suggestion2", "suggestion3"] as const;
  check(
    "E1 quick-action presses never decorate a copilot chip",
    top(qaHeavy, copilotPool) === null,
  );
  // And the toolbar never decorates a copilot subject.
  const copilotHeavy = rec(
    rec(rec(null, "suggestionTrend"), "suggestionTrend"),
    "suggestionTrend",
  );
  check(
    "E2 copilot presses never decorate a quick action",
    top(copilotHeavy, QUICK_ACTION_KEYS) === null,
  );
}

console.log(`\nr122 quick-action usage battery: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
