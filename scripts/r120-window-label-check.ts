/**
 * R120 — pure battery for the copilot snapshot's window range labels
 * (NO DB / server / browser).
 *
 * The FA live QA catch that motivated this module: with raw `YYYY-MM-DD`
 * bounds the model converted calendars ITSELF and narrated invented month
 * names ("از ۲۶ این تا ۲۴ شهریتم"). The server now ships pre-formatted
 * labels (src/lib/window-label.ts) and prompt rule 6e forbids re-deriving
 * them. Everything here runs under bun against the real module.
 *
 * Run: bun scripts/r120-window-label-check.ts   (expect 11/11)
 */
import { formatWindowLabel } from "../src/lib/window-label";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

const SEP25 = "2026-09-25";
const OCT24 = "2026-10-24";

console.log("A — FA labels (Jalali, Persian digits, the language the model answers in)");

// A1 — the exact R119 QA window: Gregorian Sep→Oct spans Mehr→Aban 1405.
check(
  "A1 FA 2026-09-25→2026-10-24",
  formatWindowLabel(SEP25, OCT24, "fa"),
  "۳ مهر ۱۴۰۵ تا ۲ آبان ۱۴۰۵",
);

// A2 — same window, EN (Gregorian) — Persian NEVER leaks into EN labels.
check(
  "A2 EN same window",
  formatWindowLabel(SEP25, OCT24, "en"),
  "25 Sep 2026 to 24 Oct 2026",
);

// A3 — single-day window: the date renders ONCE (no "X to X").
check(
  "A3 FA single-day",
  formatWindowLabel(SEP25, SEP25, "fa"),
  "۳ مهر ۱۴۰۵",
);
check(
  "A4 EN single-day",
  formatWindowLabel(SEP25, SEP25, "en"),
  "25 Sep 2026",
);

console.log("B — Jalali conversion correctness (known anchors)");

// B1 — Nowruz 1405: 2026-03-21 is 1 Farvardin 1405.
check(
  "B1 FA Nowruz anchor",
  formatWindowLabel("2026-03-21", "2026-03-21", "fa"),
  "۱ فروردین ۱۴۰۵",
);

// B2 — leap-year Esfand 30 (1403 is a leap Jalali year: 1403/12/30 exists,
//      = 2025-03-20 Gregorian).
check(
  "B2 FA leap Esfand 30",
  formatWindowLabel("2025-03-20", "2025-03-20", "fa"),
  "۳۰ اسفند ۱۴۰۳",
);

// B3 — year boundary: 2026-03-20 (last day of 1404) → 2026-03-21 (1 Farvardin 1405).
check(
  "B3 FA year-boundary pair",
  formatWindowLabel("2026-03-20", "2026-03-21", "fa"),
  "۲۹ اسفند ۱۴۰۴ تا ۱ فروردین ۱۴۰۵",
);

console.log("C — defensive honesty (bad input → null, label omitted)");

// C1 — non-ISO garbage → null (never a malformed label in the snapshot).
check("C1 garbage input", formatWindowLabel("not-a-date", OCT24, "fa"), null);
check("C2 garbage to", formatWindowLabel(SEP25, "", "en"), null);

// C3 — datetime strings (NOT the report key format) → null; the snapshot
//      contract is strict YYYY-MM-DD business-local keys.
check(
  "C3 datetime rejected",
  formatWindowLabel("2026-09-25T12:00:00Z", OCT24, "fa"),
  null,
);

console.log("D — reversed window still renders (server pairs are ordered, but no crash)");

// D1 — to before from: both parse, so the label renders (ordering is the
//      report engine's contract; the label never fabricates its own).
check(
  "D1 FA reversed pair renders",
  formatWindowLabel(OCT24, SEP25, "fa"),
  "۲ آبان ۱۴۰۵ تا ۳ مهر ۱۴۰۵",
);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
