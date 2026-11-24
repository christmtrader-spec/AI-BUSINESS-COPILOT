/**
 * r179-preset-press-check.ts — the pressed-key disambiguation law.
 *
 * R179 Mandate (R178 §3 #4 banked polish): when two presets compute the
 * SAME window (last3Months === thisQuarter on every quarter-end Jalali
 * month), the window-equality find() highlighted the array-order winner and
 * the user's press read as "didn't register" (R178's live sample: Azar
 * 1405, press last3 → highlight thisQuarter). The cure: the PRESSED key
 * wins the highlight while its window still matches the applied value;
 * everything else (deep links, fresh visits, pager/custom windows) falls
 * back to the deterministic array-order find().
 *
 * Sections:
 *  [1] the pressed-key law in the component source (the local hint ref,
 *      the precedence, the press recording, the clear reset, the
 *      presentation-state boundary — no parent prop threading)
 *  [2] the aliasing math against the REAL jalali library (byte-identical
 *      windows at quarter-end months, distinct at mid-quarter, exactly the
 *      3/6/9/12 month law across the whole Jalali year, array order)
 *  [3] the one-source law (all three consumers render the SAME presets
 *      component; R179 changed NOTHING in the consumers)
 *  [4] the R176 guard re-pin (the adjacent pager still absents for preset
 *      windows — one pressed affordance per window)
 *  [5] the census + registration law
 *
 * Run: npx tsx scripts/r179-preset-press-check.ts
 */
import { readFileSync } from "node:fs";
import { familyCensus, assertRegistered } from "./family-census";
import { JALALI_PRESETS, jalaliPresetWindow, toJalali, toGregorian } from "../src/lib/jalali";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8");

const passed: string[] = [];
const failures: string[] = [];
function ok(name: string, cond: boolean, info?: string) {
  if (cond) passed.push(name);
  else failures.push(info ? `${name} — ${info}` : name);
}

// ==== [1] THE PRESSED-KEY LAW ================================================

{
  console.log("\n[1] the pressed-key law (src/components/shared/jalali-range-presets.tsx)");
  const c = read("src/components/shared/jalali-range-presets.tsx");

  ok(
    "1a the hint STATE exists and is TYPED as the pressed preset key (presentation state lives in the component — the WINDOW is query state and stays in the parent; state not ref: it drives the render output, react-hooks/refs forbids reading refs during render)",
    c.includes("const [pressedHint, setPressedHint] = useState<JalaliPresetKey | null>(null);") &&
      c.includes("The hint is STATE (not a ref)"),
  );
  ok(
    "1b the precedence law: the hint wins ONLY while its recomputed window still equals the applied value; otherwise the deterministic window find() decides",
    c.includes("pressedWindow &&") &&
      c.includes("pressedWindow.from === value.from &&") &&
      c.includes("pressedWindow.to === value.to") &&
      c.includes("? pressedHint") &&
      c.includes("presets.find((p) => p.window.from === value.from && p.window.to === value.to)"),
  );
  ok(
    "1c a press RECORDS its key before handing the window to the parent (setPressedHint inside onClick, before onChange — batched with the value update into ONE render)",
    /setPressedHint\(p\.key\);\s*\n\s*onChange\(\{ from: p\.window\.from, to: p\.window\.to \}\);/.test(c),
  );
  ok(
    "1d clear RESETS the hint (a stale press must never bias a later deep link that lands on the same coincident window)",
    c.includes("setPressedHint(null);") && c.includes("never bias a later deep link"),
  );
  ok(
    "1e the aliasing law is DOCUMENTED at the fix site (quarter-end months 3/6/9/12, four months a year, the R178 live sample)",
    c.includes("quarter-end month") &&
      c.includes("3/6/9/12") &&
      c.includes("Azar 1405") &&
      c.includes("didn't register"),
  );
  ok(
    "1f the presentation-state boundary held: the component gained NO new props and NO ref-during-render (zero parent/consumer changes — all three surfaces inherit the law for free)",
    !c.includes("pressedKey?:") &&
      !c.includes("useRef") &&
      !/function JalaliRangePresets\(\{[^}]*pressed/i.test(c),
  );
}

// ==== [2] THE ALIASING MATH (real library, real dates) =======================

{
  console.log("\n[2] the aliasing math (src/lib/jalali.ts behavior pins)");

  // Azar 1405 (month 9, a quarter-end month) — R178's live sample.
  const azar = new Date("2026-11-24T12:00:00Z");
  ok(
    "2a the sample date IS Azar 1405 (the R178 scenario, not a lucky guess)",
    toJalali(azar).jm === 9 && toJalali(azar).jy === 1405,
  );
  const l3 = jalaliPresetWindow("last3Months", azar);
  const q = jalaliPresetWindow("thisQuarter", azar);
  ok(
    "2b at the quarter-end sample the two windows are byte-identical (the aliasing is REAL, not cosmetic)",
    l3.from === q.from && l3.to === q.to,
  );

  // Aban 1405 (month 8, mid-quarter) — the windows must differ.
  const aban = new Date("2026-10-24T12:00:00Z");
  ok(
    "2c the mid-quarter sample IS Aban 1405",
    toJalali(aban).jm === 8 && toJalali(aban).jy === 1405,
  );
  const l3b = jalaliPresetWindow("last3Months", aban);
  const qb = jalaliPresetWindow("thisQuarter", aban);
  ok(
    "2d at mid-quarter the windows DIFFER (the aliasing only exists at quarter-end months)",
    l3b.from !== qb.from || l3b.to !== qb.to,
  );

  // The whole-Jalali-year law: coincident days are EXACTLY the days of
  // months 3/6/9/12 of 1405 (a non-leap Jalali year here — 1405 Esfand 29).
  let coincidentDays = 0;
  let coincidentMonths = new Set<number>();
  let day = new Date("2026-03-21T12:00:00Z"); // Farvardin 1, 1405
  const end = new Date("2027-03-20T12:00:00Z"); // Esfand 29, 1405
  while (day <= end) {
    const l = jalaliPresetWindow("last3Months", day);
    const t = jalaliPresetWindow("thisQuarter", day);
    if (l.from === t.from && l.to === t.to) {
      const jm = toJalali(day).jm;
      coincidentDays += 1;
      coincidentMonths.add(jm);
    }
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  const expected = [...coincidentMonths].sort((a, b) => a - b).join(",");
  ok(
    `2e the coincidence months across ALL of 1405 are exactly 3/6/9/12 (observed: ${expected}, ${coincidentDays} days/year alias)`,
    expected === "3,6,9,12" && coincidentDays > 0,
  );
  ok(
    "2f the aliasing is bounded: well under half the year reads ambiguous (honest scope for the polish)",
    coincidentDays <= 130,
  );

  ok(
    "2g the array-order fallback is deterministic: thisQuarter is listed BEFORE last3Months in JALALI_PRESETS (deep links keep the R178-documented highlight)",
    JALALI_PRESETS.indexOf("thisQuarter") < JALALI_PRESETS.indexOf("last3Months"),
  );
  ok(
    "2h the preset key union covers all seven buttons (no orphan key can be pressed into the ref)",
    JALALI_PRESETS.length === 7 &&
      JALALI_PRESETS.includes("last3Months") &&
      JALALI_PRESETS.includes("thisQuarter"),
  );
}

// ==== [3] THE ONE-SOURCE LAW =================================================

{
  console.log("\n[3] the one-source law (three consumers, zero R179 ripples)");
  const consumers = [
    "src/modules/reports/reports-view.tsx",
    "src/modules/reports/performance-panel.tsx",
    "src/modules/statements/statements-view.tsx",
  ];
  ok(
    "3a all three consumers render JalaliRangePresets (no second presets row anywhere)",
    consumers.every((f) => read(f).includes("<JalaliRangePresets")),
  );
  ok(
    "3b the consumers were NOT touched by the fix (the git worktree's R179 diff touches only the component + this battery's law)",
    consumers.every((f) => !read(f).includes("pressedHint") && !read(f).includes("setPressedHint")),
  );
}

// ==== [4] THE R176 GUARD RE-PIN ==============================================

{
  console.log("\n[4] the R176 adjacent-pager guard re-pin");
  const c = read("src/components/shared/jalali-range-presets.tsx");
  ok(
    "4a the adjacent pager still absents for preset windows (value && !activeKey — one pressed affordance per window; the disambiguation must not resurrect a second pager)",
    c.includes("value && !activeKey ? (") && c.includes("<AdjacentWindowButtons"),
  );
}

// ==== [5] THE CENSUS + REGISTRATION LAW ======================================

{
  console.log("\n[5] the census + registration law");
  const c = familyCensus();
  assertRegistered("r179-preset-press-check.ts");
  ok(
    "5a the tsx floor holds (the component grew, never shrank)",
    c.tsx >= 26,
  );
  ok(
    "5b this battery IS registered in run-family.sh (the join-day canary lives in the file that can forget)",
    read("scripts/run-family.sh").includes("r179-preset-press-check.ts"),
  );
}

// ==== VERDICT ================================================================

console.log(`\n=== r179-preset-press-check: ${passed.length} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("GREEN — the pressed key wins its own highlight; deep links stay deterministic.");
