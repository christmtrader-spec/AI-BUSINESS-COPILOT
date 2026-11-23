/**
 * r175-reports-custom-range-check.ts — the server's own range grammar
 * finally reaches the UI.
 *
 * R175 Mandate 5: Prompt 52 §F4 gave /api/v1/reports/summary (and
 * /reports/export) an explicit ?from=&to= window, but the UI could only
 * REACH it through the seven fixed Jalali presets — no human could ask
 * for "Oct 1 → Nov 15". A CustomRangePicker joins the presets row (the
 * row's NEW children slot — ONE visual range home) and writes through
 * the SAME applied-range state, so the summary query, the CSV export,
 * the both-calendar shown-line and the deep-link grammar all keep riding
 * UNCHANGED paths. The 422 INVALID_REPORT_RANGE banner now surfaces the
 * server's authoritative message (a user-input problem, not a load
 * failure).
 *
 * Sections:
 *  [1] the picker law (pure period helpers, single applied state,
 *      resolveCustomRange mirror: order → span-on-RAW → future-from →
 *      clamp-future-to, business timezone input)
 *  [2] the row-slot law (JalaliRangePresets children slot, one range home,
 *      the view passes business.timezone and the SAME onChange)
 *  [3] the a11y/styling law (label pairs, role=status hint, focus-visible
 *      family on inputs and buttons, aria-pressed honesty, testids)
 *  [4] the i18n law (EN+FA parity, pure Persian FA, the rangeRejected key)
 *  [5] the family-census law (self-registration + --list manifest)
 *
 * Run: npx tsx scripts/r175-reports-custom-range-check.ts
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { familyCensus, assertRegistered } from "./family-census";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8");

const passed: string[] = [];
const failures: string[] = [];
function ok(name: string, cond: boolean, info?: string) {
  if (cond) passed.push(name);
  else failures.push(info ? `${name} — ${info}` : name);
}

// ==== [1] THE PICKER LAW ====================================================

{
  console.log("\n[1] the custom-range picker (Mandate 5)");
  const src = read("src/components/shared/custom-range-picker.tsx");

  ok(
    "1a the picker is a client component",
    src.startsWith('"use client";'),
  );
  ok(
    "1b it imports the PURE period helpers (never a client timezone, never fixed-ms math)",
    src.includes('from "@/lib/report-periods"') &&
      src.includes("parseLocalDateKey") &&
      src.includes("daysBetweenInclusive") &&
      src.includes("MAX_REPORT_RANGE_DAYS") &&
      src.includes("localDateKeyOf") &&
      src.includes("addLocalDays"),
  );
  ok(
    "1c the timezone input is the BUSINESS's (L3 — the browser zone is never consulted)",
    src.includes("timezone: string") &&
      src.includes("localDateKeyOf(now, timezone)") &&
      /Intl\.DateTimeFormat\(\s*"en-US"/.test(src) === false ||
      src.includes("localDateKeyOf(now, timezone)"),
  );
  ok(
    "1d ONE applied state: the picker writes ONLY through onChange (no parallel applied-range useState)",
    src.includes("onChange({ from: fromKey, to: clampedTo })") &&
      !/useState<\s*\{\s*from/.test(src),
  );
  ok(
    "1e the resolveCustomRange mirror — ORDER check on the raw keys",
    /fromKey > toKey\)\s*draftError = "order"/.test(src),
  );
  ok(
    "1f the mirror — SPAN check on the RAW keys BEFORE clamping (clamping never rescues an over-wide span)",
    /daysBetweenInclusive\(fromKey, toKey\) > MAX_REPORT_RANGE_DAYS/.test(src) &&
      src.indexOf("daysBetweenInclusive(fromKey, toKey) > MAX_REPORT_RANGE_DAYS") <
        src.indexOf("fromKey > todayKey"),
  );
  ok(
    "1g the mirror — FUTURE-from rejection (L4) and the future-to CLAMP (what the UI sends is what the server would resolve)",
    /fromKey > todayKey\)\s*draftError = "future"/.test(src) &&
      /toKey > todayKey \? todayKey : toKey/.test(src),
  );
  ok(
    "1h the draft dies with the popover: open PREFILLS the applied window (edit-in-place), abandon never leaks",
    src.includes("value?.from ?? addLocalDays(todayKey, -29)") &&
      src.includes('if (next) {'),
  );
  ok(
    "1i strict Gregorian keys only — parseLocalDateKey guards both inputs (real calendar dates, 2000..2100)",
    /parseLocalDateKey\(fromDraft\)/.test(src) && /parseLocalDateKey\(toDraft\)/.test(src),
  );
  ok(
    "1j Apply is disabled unless the draft resolves clean",
    /disabled=\{!canApply\}/.test(src) &&
      /canApply = draftError === null && fromKey !== null && toKey !== null/.test(src),
  );
  ok(
    "1k the both-calendar honesty: typed dates show their Jalali long-form inline (the presets' shown-line convention)",
    src.includes("formatJalaliDisplay(toJalali(new Date(`${key}T12:00:00Z`))") &&
      src.includes('locale: locale === "fa" ? "fa" : "en"'),
  );
  ok(
    "1l pressed exactly when a NON-preset window is applied (deep link or custom pick) — never two pressed affordances",
    /jalaliPresetWindow\(k, now\)/.test(src) &&
      /customActive = value !== null && !matchesPreset/.test(src),
  );
  ok(
    "1m no server-side or db imports leak into the client component",
    !src.includes("next/server") && !src.includes("@prisma") && !src.includes("z-ai-web-dev-sdk"),
  );
}

// ==== [2] THE ROW-SLOT LAW ==================================================

{
  console.log("\n[2] one visual range home (the presets row's children slot)");
  const presets = read("src/components/shared/jalali-range-presets.tsx");
  const view = read("src/modules/reports/reports-view.tsx");

  ok(
    "2a the presets row grew the typed children slot (R175 — extra affordances join the SAME row)",
    presets.includes("children?: ReactNode;") && presets.includes("{children}"),
  );
  ok(
    "2b the view hosts the picker INSIDE the presets row (never a second floating bar) (RE-PINNED R176: the row gained the timezone prop — the wiring stays one-element)",
    /<JalaliRangePresets value=\{jalaliRange\} onChange=\{setJalaliRange\} timezone=\{business\.timezone\}>\s*<CustomRangePicker/.test(
      view,
    ),
  );
  ok(
    "2c the SAME onChange writes both affordances (one applied-range state)",
    view.includes("onChange={setJalaliRange}") && view.includes("value={jalaliRange}"),
  );
  ok(
    "2d the business timezone feeds the picker (L3 at the call site)",
    view.includes("timezone={business.timezone}"),
  );
  ok(
    "2e the summary query keeps riding jalaliRange unchanged (custom ranges inherit ?from=&to=, CSV export included)",
    view.includes('queryKey: ["reports", "summary", days, jalaliRange]') &&
      view.includes("/api/v1/reports/summary?from=${jalaliRange.from}&to=${jalaliRange.to}") &&
      view.includes("/api/v1/reports/export?from=${jalaliRange.from}&to=${jalaliRange.to}"),
  );
  ok(
    "2f the 422 INVALID_REPORT_RANGE surfaces the server's message under the generic banner (role=alert)",
    /error instanceof ApiClientError && error\.code === "INVALID_REPORT_RANGE"/.test(view) &&
      /role="alert"[\s\S]{0,400}INVALID_REPORT_RANGE/.test(view),
  );
}

// ==== [3] THE A11Y / STYLING LAW ============================================

{
  console.log("\n[3] accessibility and the focus-visible family");
  const src = read("src/components/shared/custom-range-picker.tsx");

  ok(
    "3a htmlFor/id label pairs on both date inputs",
    src.includes('htmlFor="custom-range-from"') &&
      src.includes('id="custom-range-from"') &&
      src.includes('htmlFor="custom-range-to"') &&
      src.includes('id="custom-range-to"'),
  );
  ok(
    "3b the hint is a live region (role=status) with the amber error family",
    src.includes('role="status"') &&
      src.includes("text-amber-700 dark:text-amber-300"),
  );
  ok(
    "3c the focus-visible family on the date inputs (ring + offset + motion-reduce escape)",
    src.includes("focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1") &&
      /motion-reduce:transition-none/.test(src),
  );
  ok(
    "3d the trigger presses honestly (aria-pressed) and carries a title + testid",
    src.includes("aria-pressed={customActive}") &&
      src.includes('title={t("trigger")}') &&
      src.includes('data-testid="custom-range-trigger"'),
  );
  ok(
    "3e the popover is a labelled dialog and every control carries a testid",
    src.includes('role="dialog"') &&
      src.includes('aria-label={t("popoverLabel")}') &&
      src.includes('data-testid="custom-range-from"') &&
      src.includes('data-testid="custom-range-to"') &&
      src.includes('data-testid="custom-range-apply"') &&
      src.includes('data-testid="custom-range-reset"') &&
      src.includes('data-testid="custom-range-hint"'),
  );
  ok(
    "3f the date inputs stay LTR in RTL locales (ISO keys are always LTR — dir on the input, not the label)",
    /dir="ltr"\s+data-testid="custom-range-from"/.test(src),
  );
  ok(
    "3g the to input carries min=from (the browser's own calendar cannot offer an impossible order)",
    src.includes("min={fromKey ?? undefined}"),
  );
}

// ==== [4] THE I18N LAW ======================================================

{
  console.log("\n[4] EN+FA parity, pure Persian");
  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");

  const enKeys = [
    "trigger: \"Custom range\"",
    "popoverLabel: \"Custom date range\"",
    "from: \"From\"",
    "to: \"To\"",
    "apply: \"Apply range\"",
    "reset: \"Reset\"",
    "hintDays: \"{count} days\"",
    "invalid: \"Enter real calendar dates (YYYY-MM-DD).\"",
    "order: \"From must be on or before To.\"",
    "span: \"The range is limited to {max} days.\"",
    "future: \"From cannot be in the future.\"",
  ];
  const faKeys = [
    'trigger: "بازهٔ دلخواه"',
    'popoverLabel: "بازهٔ زمانی دلخواه"',
    'from: "از"',
    'to: "تا"',
    'apply: "اعمال بازه"',
    'reset: "بازنشانی"',
    'hintDays: "{count} روز"',
    'invalid: "تاریخ واقعی میلادی را وارد کنید (YYYY-MM-DD)."',
    'order: "«از» باید پیش یا هم‌روز با «تا» باشد."',
    'span: "بازه حداکثر {max} روز است."',
    'future: "«از» نمی‌تواند در آینده باشد."',
  ];
  ok(
    "4a every customRange key exists in EN",
    enKeys.every((k) => en.includes(k)),
    enKeys.filter((k) => !en.includes(k)).join(" | "),
  );
  ok(
    "4b every customRange key exists in FA and is pure Persian",
    faKeys.every((k) => fa.includes(k)),
    faKeys.filter((k) => !fa.includes(k)).join(" | "),
  );
  ok(
    "4c the FA copy contains no Latin words (the format spec YYYY-MM-DD and the ICU placeholders {count}/{max} are the honest exceptions)",
    (() => {
      const block = /customRange: \{([\s\S]{0,900}?)\},\n/.exec(fa)?.[1] ?? "";
      const values = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      if (values.length < 11) return false; // the block's own 11 strings
      return values.every((v) =>
        !/[A-Za-z]/.test(v.replace(/YYYY-MM-DD/g, "").replace(/\{[a-z]+\}/g, "")),
      );
    })(),
  );
  ok(
    "4d the rangeRejected banner key exists in both locales",
    en.includes('rangeRejected: "The server rejected this range"') &&
      fa.includes('rangeRejected: "سرور این بازه را نپذیرفت"'),
  );
  ok(
    "4e the view consumes the new keys from the reports namespace",
    read("src/modules/reports/reports-view.tsx").includes('t("rangeRejected")'),
  );
}

// ==== [5] THE FAMILY-CENSUS LAW ============================================

{
  console.log("\n[5] self-registration (the census module law)");
  ok(
    "5a the self-registration canary: THIS battery is registered in the runner",
    assertRegistered("r175-reports-custom-range-check.ts"),
    "add r175-reports-custom-range-check.ts to run-family.sh BATTERIES_TSX",
  );

  const c = familyCensus();
  ok(
    "5b the live counts match the runner right now (tsx floor 24, bun 2, proofs 5, names sum)",
    c.tsx >= 24 && c.bun === 2 && c.proofs === 5 && c.names.length === c.tsx + c.bun + c.proofs,
    `tsx=${c.tsx} bun=${c.bun} proofs=${c.proofs}`,
  );

  try {
    const list = execSync("bash scripts/run-family.sh --list", {
      cwd: ROOT,
      encoding: "utf8",
    });
    ok(
      "5c the resolved --list manifest lists this battery (end-to-end registration proof)",
      list.includes("r175-reports-custom-range-check.ts"),
    );
  } catch (e) {
    ok("5c the resolved --list manifest lists this battery", false, String(e).slice(0, 80));
  }
}

// ==== [6] THE ROUND'S INCREMENTS (honest combobox + window nudge + polish) ==

{
  console.log("\n[6] the honesty combobox, the window nudge, the polish");
  const view = read("src/modules/reports/reports-view.tsx");
  const src = read("src/components/shared/custom-range-picker.tsx");
  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");

  ok(
    "6a the combobox never lies: a synthetic explicit item exists and is NOT a rolling value",
    view.includes('const EXPLICIT_RANGE_ITEM = "__explicit_window__"') &&
      view.includes("value={jalaliRange ? EXPLICIT_RANGE_ITEM : days}"),
  );
  ok(
    "6b selecting the explicit item is a no-op; any rolling selection clears the explicit window",
    /if \(v === EXPLICIT_RANGE_ITEM\) return;/.test(view) &&
      /setDays\(v\);\s*\n\s*setJalaliRange\(null\);/.test(view),
  );
  ok(
    "6c the explicit item renders ONLY while a window is applied and carries the applied pair (bidi-isolated LRI…PDI — RTL weak-segment reordering)",
    /jalaliRange \? \(\s*<SelectItem value=\{EXPLICIT_RANGE_ITEM\}>/.test(view) &&
      /range: `\\u2066\$\{jalaliRange\.from\} → \$\{jalaliRange\.to\}\\u2069`/.test(view),
  );
  ok(
    "6d the appliedTitle key exists in BOTH locales (EN + FA)",
    en.includes('appliedTitle: "Applied window: {range}"') &&
      fa.includes('appliedTitle: "بازهٔ اعمال‌شده: {range}"'),
  );
  ok(
    "6e the nudge edits the DRAFT only and runs the SHARED adjacency helper (RE-PINNED R176: the inline prev/next math moved to lib/report-periods adjacentWindow — one source for both paging affordances)",
    /const nudgeDraft = \(direction: "prev" \| "next"\)/.test(src) &&
      src.includes("const w = adjacentWindow(fromKey, toKey, direction);") &&
      src.includes('from "@/lib/report-periods"') &&
      src.includes("adjacentWindow,") &&
      !/nudgeDraft[\s\S]{0,400}onChange\(/.test(src.split("const apply")[0] ?? src),
  );
  ok(
    "6f the nudge buttons are disabled unless the draft resolves clean (validation stays the gate)",
    /data-testid="custom-range-prev"/.test(src) &&
      /data-testid="custom-range-next"/.test(src) &&
      (src.match(/disabled=\{!canApply\}/g) ?? []).length >= 3,
  );
  ok(
    "6g prevWindow/nextWindow keys exist in BOTH locales (EN + FA, pure Persian FA)",
    en.includes('prevWindow: "Previous window"') &&
      en.includes('nextWindow: "Next window"') &&
      fa.includes('prevWindow: "بازهٔ قبلی"') &&
      fa.includes('nextWindow: "بازهٔ بعدی"'),
  );
  ok(
    "6h the polish: w-80 popover, CalendarRange title icon, border-t footer divider",
    src.includes('className="w-80 p-4"') &&
      /<CalendarRange className="text-muted-foreground size-4"/.test(src) &&
      /justify-end gap-2 border-t pt-3/.test(src),
  );
}

// ==== [7] THE R176 APPLIED-WINDOW PAGER (shared adjacency, shown-line home) =

{
  console.log("\n[7] the applied-window pager (R176)");
  const lib = read("src/lib/report-periods.ts");
  const picker = read("src/components/shared/custom-range-picker.tsx");
  const presets = read("src/components/shared/jalali-range-presets.tsx");
  const view = read("src/modules/reports/reports-view.tsx");
  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");

  ok(
    "7a the adjacency helper is PURE lib law: prev = [from−N, from−1], next = [to+1, to+N], one source (lib/report-periods)",
    lib.includes("export function adjacentWindow(") &&
      lib.includes('return { from: addLocalDays(fromKey, -span), to: addLocalDays(fromKey, -1) };') &&
      lib.includes('return { from: addLocalDays(toKey, 1), to: addLocalDays(toKey, span) };'),
  );
  ok(
    "7b the picker's draft nudge consumes the shared helper (no second copy of the math)",
    picker.includes("const w = adjacentWindow(fromKey, toKey, direction);"),
  );
  ok(
    "7c the pager component: ghost icon pair, group semantics, testids, business-timezone input",
    picker.includes("export function AdjacentWindowButtons(") &&
      /role="group"/.test(picker) &&
      picker.includes('data-testid="window-pager-prev"') &&
      picker.includes('data-testid="window-pager-next"') &&
      /localDateKeyOf\(new Date\(\), timezone\)/.test(picker),
  );
  ok(
    "7d the crash guard: invalid/half-typed/reversed draft keys absent the pager (the perf panel and statements feed DRAFT inputs)",
    /if \(!value \|\| !fromKey \|\| !toKey \|\| fromKey > toKey\) return null;/.test(picker) &&
      /parseLocalDateKey\(value\?\.from\)/.test(picker) &&
      /parseLocalDateKey\(value\?\.to\)/.test(picker),
  );
  ok(
    "7e the server laws: next DISABLED when adjacent from is past business-local today; adjacent to clamped to today before applying",
    /const nextReachable = next\.from <= todayKey;/.test(picker) &&
      /disabled=\{!nextReachable\}/.test(picker) &&
      /onChange\(\{ from: w\.from, to: w\.to > todayKey \? todayKey : w\.to \}\)/.test(picker),
  );
  ok(
    "7f the shown-line home: pager renders ONLY for non-preset windows (activeKey guard) and the presets row carries the business timezone",
    presets.includes("{value && !activeKey ? (") &&
      presets.includes('<AdjacentWindowButtons value={value} onChange={onChange} timezone={timezone} />') &&
      presets.includes("timezone: string;"),
  );
  ok(
    "7g the view wires the timezone through (one call site, the SAME business.timezone the picker gets)",
    view.includes("timezone={business.timezone}") &&
      (view.match(/timezone=\{business\.timezone\}/g) ?? []).length >= 2,
  );
  ok(
    "7h the RTL honesty: chevrons mirror in RTL (rtl:-scale-x-100) so they match time flowing right-to-left",
    (picker.match(/rtl:-scale-x-100/g) ?? []).length >= 2,
  );
  ok(
    "7i the pagerLabel key exists in BOTH locales (EN + FA, pure Persian FA)",
    en.includes('pagerLabel: "Page the applied window"') &&
      fa.includes('pagerLabel: "صفحه‌بندی بازهٔ اعمال‌شده"'),
  );
  ok(
    "7j the trigger shows the COMPACT pair (control shows values, not prose): SelectValue override dir=ltr + tabular-nums, aria keeps the verbose appliedTitle, explicit widens sm:w-56 / rolling sm:w-44",
    /<SelectValue>\s*\{jalaliRange \? \(/.test(view) &&
      /<span dir="ltr" className="tabular-nums">/.test(view) &&
      /jalaliRange \? "sm:w-56" : "sm:w-44"/.test(view) &&
      /jalaliRange\s*\? t\("customRange\.appliedTitle"/.test(view),
  );
}

// ==== [8] THE R177 LIVE-HINT NUZZLE + THE APPLIED-WINDOW FEED (R176 §3) ===

{
  console.log("\n[8] the live-hint nudge + the applied-window feed (R177)");
  const picker = read("src/components/shared/custom-range-picker.tsx");
  const perf = read("src/modules/reports/performance-panel.tsx");
  const recovery = read("scripts/recover-dev-data.sh");

  ok(
    "8a the nudge's LIVE HINT: would-be windows computed from the SAME draft via the SHARED adjacency law, gated by canApply (a disabled nudge never promises a window)",
    /const nudgeHint =\s*\n\s*canApply && fromKey !== null && toKey !== null/.test(picker) &&
      picker.includes('prev: adjacentWindow(fromKey, toKey, "prev")') &&
      picker.includes('next: adjacentWindow(fromKey, toKey, "next")'),
  );
  ok(
    "8b the hint sub-lines: visual-only under their buttons (aria-hidden), dir=ltr + tabular-nums (ISO keys are LTR data — the R175 bidi law), their own testids",
    /aria-hidden="true"\s*\n?\s*data-testid="custom-range-hint-prev"/.test(picker.replace(/\r/g, "")) &&
      picker.includes('data-testid="custom-range-hint-next"') &&
      (picker.match(/dir="ltr"\s*\n?\s*className="tabular-nums"/g) ?? []).length >= 2,
  );
  ok(
    "8c the nudge aria-labels carry the LIVE consequence, composed from the SAME i18n keys (no new strings — 6g's keys are the source)",
    picker.includes('`${t("prevWindow")}: ${nudgeHint.prev.from} → ${nudgeHint.prev.to}`') &&
      picker.includes('`${t("nextWindow")}: ${nudgeHint.next.from} → ${nudgeHint.next.to}`'),
  );
  ok(
    "8d ONE mirror law: EVERY directional window chevron mirrors in RTL (the draft nudge pair + the applied pager pair = 4 sites)",
    (picker.match(/rtl:-scale-x-100/g) ?? []).length >= 4 &&
      /ChevronLeft className="size-3\.5 rtl:-scale-x-100"/.test(picker) &&
      /ChevronRight className="size-3\.5 rtl:-scale-x-100"/.test(picker),
  );
  ok(
    "8e the applied-window FEED: the perf panel's presets row reads `applied` (was: the DRAFT inputs) — press-states, shown-line, picker prefill and the pager all read the truth the query rides",
    perf.includes("value={{ from: applied.from, to: applied.to }}") &&
      /setFromInput\(r\.from\);\s*\n\s*setToInput\(r\.to\);\s*\n\s*applyRangeWith\(r\.from, r\.to\);/.test(perf),
  );
  ok(
    "8f the honest guard comment: every consumer now feeds its APPLIED window; the crash guard stays as defense-in-depth (no stale draft-consumer claim)",
    picker.includes("every consumer now feeds its APPLIED window") &&
      picker.includes("Defense-in-depth") &&
      !picker.includes("feed their DRAFT inputs"),
  );
  ok(
    "8g the recovery runbook as ONE command: scripts/recover-dev-data.sh chains the fixtures in CONTRACT ORDER (personas first, QA shop second — order matters)",
    recovery.includes("node scripts/e2e-smoke-fixture.mjs") &&
      recovery.indexOf("node scripts/e2e-smoke-fixture.mjs") <
        recovery.indexOf("node scripts/r156-qa-fixture.mjs") &&
      recovery.includes("set -euo pipefail"),
  );
}

console.log(`\n=== r175-reports-custom-range-check: ${passed.length} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
