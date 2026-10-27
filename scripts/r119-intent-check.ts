/**
 * R119 — pure battery for the ask-copilot intent law (NO DB / server / browser).
 *
 * The dashboard's copilot card surfaces the trend question ONLY when the
 * summary it already holds carries an honestly quotable percentage — the same
 * L8 law as the copilot's own pools (r118 battery), enforced on a third
 * surface through ONE shared pure function (src/modules/copilot/suggestions.ts
 * → dashboardTrendQuestion). Everything here runs under bun against the real
 * module — no mocks, no fixtures.
 *
 * Run: bun scripts/r119-intent-check.ts   (expect 10/10)
 */
import {
  dashboardTrendQuestion,
  type SummaryLite,
} from "../src/modules/copilot/suggestions";

let pass = 0;
let fail = 0;

function check(name: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} — expected ${expected}, got ${actual}`);
  }
}

console.log("A — dashboardTrendQuestion (the third-surface honesty law)");

// A1 — an honest percentage exists → the question may be asked.
check(
  "A1 pct=23 → chip exists",
  dashboardTrendQuestion({ trend: { revenueChangePct: 23 } }),
  true,
);

// A2 — a NEGATIVE percentage is still honest (down is a truth, not a gap).
check(
  "A2 pct=-4 → chip exists",
  dashboardTrendQuestion({ trend: { revenueChangePct: -4 } }),
  true,
);

// A3 — zero pct (flat windows) is a real number → chip exists.
check(
  "A3 pct=0 → chip exists",
  dashboardTrendQuestion({ trend: { revenueChangePct: 0 } }),
  true,
);

// A4 — L8 null (previous window zero/negative) → the chip MUST NOT exist.
check(
  "A4 pct=null → chip absent (would fabricate)",
  dashboardTrendQuestion({ trend: { revenueChangePct: null } }),
  false,
);

// A5 — the trend block missing entirely (pre-R115 cached payload) → absent.
// (Annotated variable — the REAL payload shape has more fields than the
// predicate reads; inline literals would trip excess-property checks.)
const preR115: SummaryLite = { kpis: { salesCount: 2 } };
check(
  "A5 trend block absent → chip absent",
  dashboardTrendQuestion(preR115),
  false,
);

// A6 — summary still loading → absent (no flash of an unearned question).
check(
  "A6 summary undefined → chip absent",
  dashboardTrendQuestion(undefined),
  false,
);

// A7 — summary null (error state) → absent.
check("A7 summary null → chip absent", dashboardTrendQuestion(null), false);

// A8 — trend block present but empty → absent.
check(
  "A8 trend={} → chip absent",
  dashboardTrendQuestion({ trend: {} }),
  false,
);

console.log("B — the dashboard payload shape (regression: real summary shape)");

// The REAL summary trend block carries prev values alongside the pcts (the
// predicate must ignore them, never require them). Annotated variables keep
// the shape honest without excess-property noise.
type TrendBlock = { revenueChangePct?: number | null; revenuePrevMinor?: number };
const withPct: { trend?: TrendBlock } = {
  trend: { revenueChangePct: 23, revenuePrevMinor: 20000 },
};
const withNull: { trend?: TrendBlock } = {
  trend: { revenueChangePct: null, revenuePrevMinor: -4000 },
};

// B1 — the actual reports/summary trend block shape the dashboard consumes
//      (pct + prev values together) keeps working.
check(
  "B1 full trend block with pct → chip exists",
  dashboardTrendQuestion(withPct),
  true,
);

// B2 — full block with null pct (negative net-cash baseline etc.) → absent.
check(
  "B2 full trend block pct=null → chip absent",
  dashboardTrendQuestion(withNull),
  false,
);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
