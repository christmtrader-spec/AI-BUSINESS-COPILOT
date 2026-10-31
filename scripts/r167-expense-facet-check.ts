/**
 * scripts/r167-expense-facet-check.ts — R167 harness.
 *
 * THE EXPENSE CHIP LANDS ITS OWN FACET: the copilot's proven
 * topExpenseCategory fact grows ONE primary-hued chip under a grounded
 * answer that opens the expenses workspace PRE-FILTERED to that category
 * (the R155 facet grammar #/expenses?category=<name> — the value IS the
 * filter's exact aggregation key, never an id, never a hand-built hash).
 * ONE hop where the R143 chip's journey was chip → perf panel → category
 * row. The violet perf chip keeps its OWN window-shaped destination (the
 * R153 no-dedupe law: materially different surfaces). The fact is a
 * rolling-window total, so NO month is composed (the R152 scope honesty —
 * the module's filters are month-shaped, a composed month would fabricate
 * a scope the fact does not carry).
 *
 *   [1] the GATE law (unit) — pickExpenseActionChip: the non-blank
 *       category (the §16 facet-family exception — a NAME, the R155 law
 *       verbatim), the positive-value law (totalMinor > 0), old persisted
 *       metas stay honest, null/undefined meta → null.
 *   [2] the NAVIGATION law (source) — navigate({ kind: "module",
 *       module: "expenses", category }) — the store's ONE view authority,
 *       never a hand-built hash; NO month composed; the store's facet
 *       serialization round-trips (hash → view → hash).
 *   [3] the CHIP law (source) — ONE chip, ONE testid, the family
 *       geometry (rounded-full, primary hue, focus-visible outline),
 *       motion-safety (transition-colors + motion-reduce), the Wallet nav
 *       iconography, the rtl ChevronDown flip, the render site after the
 *       R153 product chip.
 *   [4] the i18n LAW — actionExpense + actionExpenseTitle EN/FA; the
 *       tooltip carries the EXACT proven figure via fmtMoney INSIDE the
 *       component (never a raw ICU number); title = aria-label = ONE
 *       source; FA pure Persian; placeholder parity.
 *   [5] the REGRESSION PIN — the R153 product chip intact, the R143 perf
 *       chips intact (products → expenses → cashflow), the R155 store
 *       facet law untouched (trim + cap + blank-wholesale + month
 *       compose), the R152 hint law (the tooltip names the destination),
 *       the decay law's chip grammar (each chip clears only itself).
 *
 * Run: npx tsx scripts/r167-expense-facet-check.ts
 */

import { readFileSync } from "node:fs";
import {
  viewToHash,
  hashToView,
  type AppView,
} from "../src/store/app-store";
import { pickExpenseActionChip } from "../src/modules/copilot/copilot-view";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond && info) failures.push(`${name} — ${info}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

const viewSrc = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

const metaOf = (topExpenseCategory: unknown) =>
  ({ topExpenseCategory }) as Parameters<typeof pickExpenseActionChip>[0];

// Strip comments so structural greps see CODE, not prose.
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(?<=[\s({])\/\/.*$/gm, "");
const viewCode = strip(viewSrc);

// ==== [1] the GATE law =====================================================

section("[1] the GATE law — pickExpenseActionChip (the R153 picker pattern)");

{
  const chip = pickExpenseActionChip(
    metaOf({ category: "Materials", totalMinor: 32000 }),
  );
  ok(
    "1a a proven fact passes: the category + the exact minor units ride",
    chip !== null && chip.category === "Materials" && chip.totalMinor === 32000,
    JSON.stringify(chip),
  );

  ok(
    "1b the positive-value law: totalMinor 0 never drills (no chip about nothing)",
    pickExpenseActionChip(metaOf({ category: "Materials", totalMinor: 0 })) === null,
  );
  ok(
    "1c the positive-value law: negative never drills",
    pickExpenseActionChip(metaOf({ category: "Materials", totalMinor: -5 })) === null,
  );
  ok(
    "1d the positive-value law: NaN/Infinity never drill",
    pickExpenseActionChip(metaOf({ category: "Materials", totalMinor: Number.NaN })) === null &&
      pickExpenseActionChip(metaOf({ category: "Materials", totalMinor: Infinity })) === null,
  );

  ok(
    "1e the FACET-name law: a blank category never drills (a chip that cannot name its filter is noise)",
    pickExpenseActionChip(metaOf({ category: "", totalMinor: 32000 })) === null &&
      pickExpenseActionChip(metaOf({ category: "   ", totalMinor: 32000 })) === null,
  );
  ok(
    "1f ill-typed categories never drill (number / null / missing field)",
    pickExpenseActionChip(metaOf({ category: 7, totalMinor: 32000 })) === null &&
      pickExpenseActionChip(metaOf({ category: null, totalMinor: 32000 })) === null &&
      pickExpenseActionChip(metaOf({ totalMinor: 32000 })) === null,
  );
  ok(
    "1g ill-typed totals never drill (string totalMinor)",
    pickExpenseActionChip(metaOf({ category: "Materials", totalMinor: "32000" })) === null,
  );

  ok(
    "1h old persisted metas stay honest: a meta WITHOUT the field → null (never a crash)",
    pickExpenseActionChip({} as Parameters<typeof pickExpenseActionChip>[0]) === null,
  );
  ok(
    "1i null / undefined / non-object meta → null (the family's honesty law)",
    pickExpenseActionChip(null) === null &&
      pickExpenseActionChip(undefined) === null &&
      pickExpenseActionChip("junk" as unknown as Parameters<typeof pickExpenseActionChip>[0]) === null,
  );

  // The fact object itself (topExpenseCategory: null) — honest silence.
  ok(
    "1j an explicit null fact → null",
    pickExpenseActionChip(metaOf(null)) === null,
  );
}

// ==== [2] the NAVIGATION law ===============================================

section("[2] the NAVIGATION law — the store's ONE view authority (the R155 grammar)");

ok(
  "2a the chip navigates { kind: 'module', module: 'expenses', category } — the store grammar, verbatim",
  viewCode.includes('navigate({ kind: "module", module: "expenses", category: chip.category })'),
);
ok(
  "2b NO hand-built hash: the component never builds #/expenses? by hand",
  !viewCode.includes('"#/expenses?'),
);
ok(
  "2c NO month composed: the fact is a rolling-window total, the module's filters are month-shaped",
  (() => {
    const m = viewCode.match(/onClick=\{\(\) => navigate\(\{[^}]*\}\)/g)?.find((s) =>
      s.includes("copilot") || s.includes("expenses"),
    );
    // Grep the ExpenseActionChip onClick specifically.
    const idx = viewCode.indexOf('data-testid="copilot-action-expense-facet"');
    const before = viewCode.slice(Math.max(0, idx - 700), idx);
    const onClick = before.match(/onClick=\{\(\) =>[\s\S]*?\}\)/)?.[0] ?? "";
    return onClick.includes('module: "expenses"') && onClick.includes("category: chip.category") && !onClick.includes("month") && !onClick.includes("param");
  })(),
);
ok(
  "2d the store serializes the bare facet canonically (no month → ?category= only, ENCODED)",
  (() => {
    const hash = viewToHash({ kind: "module", module: "expenses", category: "Materials" });
    return hash === "#/expenses?category=Materials";
  })(),
);
ok(
  "2e the facet round-trips (hash → view → hash) — the R155 law through the chip's exact shape",
  (() => {
    const hash = viewToHash({
      kind: "module",
      module: "expenses",
      category: "R&D & fixtures #1",
    })!;
    const back = hashToView(hash);
    return (
      hash === "#/expenses?category=R%26D%20%26%20fixtures%20%231" &&
      back.kind === "module" &&
      back.module === "expenses" &&
      (back as Extract<AppView, { kind: "module" }>).category === "R&D & fixtures #1" &&
      viewToHash(back) === hash
    );
  })(),
);
ok(
  "2f the compose law stands: month + category serializes month FIRST (the R155 canonical order)",
  viewToHash({
    kind: "module",
    module: "expenses",
    param: "2026-09",
    category: "Rent",
  }) === "#/expenses?month=2026-09&category=Rent",
);

// ==== [3] the CHIP law =====================================================

section("[3] the CHIP law — the family geometry, ONE testid, motion-safety, iconography");

ok(
  "3a ONE gate, ONE chip: the picker is exported and the component renders exactly one button",
  (() => {
    const idx = viewCode.indexOf("function ExpenseActionChip(");
    const body = viewCode.slice(idx, idx + 2200);
    return (body.match(/<button/g) ?? []).length === 1;
  })(),
);
ok(
  "3b the chip's testid is copilot-action-expense-facet (exactly once) and the wrapper is copilot-expense-chips",
  (viewCode.match(/copilot-action-expense-facet/g) ?? []).length === 1 &&
    (viewCode.match(/copilot-expense-chips/g) ?? []).length === 1,
);
ok(
  "3c the family geometry: rounded-full border chip, the R152/R153 primary identity (border-primary/30 bg-primary/5 text-primary)",
  viewCode.includes(
    "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10",
  ),
);
ok(
  "3d motion-safety: transition-colors carries motion-reduce:transition-none (the R156 TOTAL law)",
  (() => {
    const idx = viewCode.indexOf('data-testid="copilot-action-expense-facet"');
    const after = viewCode.slice(idx, idx + 900);
    return (
      after.includes("transition-colors motion-reduce:transition-none") &&
      after.includes("focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary")
    );
  })(),
);
ok(
  "3e the icon mirrors the app's OWN nav iconography: Wallet = expenses (one icon one meaning)",
  (() => {
    const idx = viewCode.indexOf('data-testid="copilot-action-expense-facet"');
    const after = viewCode.slice(idx, idx + 700);
    return after.includes("<Wallet") && after.includes('aria-hidden="true"');
  })(),
);
ok(
  "3f the ChevronDown affordance keeps the rtl flip (the family's byte-pattern)",
  (() => {
    const idx = viewCode.indexOf('data-testid="copilot-action-expense-facet"');
    const after = viewCode.slice(idx, idx + 900);
    return after.includes("rtl:-scale-x-100") && after.includes("opacity-60");
  })(),
);
ok(
  "3g the render site: after the R153 product chip, before the stream-resume block",
  (() => {
    const productSite = viewCode.indexOf("<ProductActionChip meta={m.meta} business={business} />");
    const expenseSite = viewCode.indexOf("<ExpenseActionChip meta={m.meta} business={business} />");
    return productSite > -1 && expenseSite > productSite;
  })(),
);
ok(
  "3h honest silence: the component returns null when the gate fails",
  viewCode.includes("const chip = pickExpenseActionChip(meta);") &&
    /if \(!chip\) return null;/.test(viewCode),
);

// ==== [4] the i18n LAW =====================================================

section("[4] the i18n LAW — EN/FA symmetric, the figure INSIDE the component");

ok(
  "4a EN keys exist: actionExpense + actionExpenseTitle",
  enSrc.includes('actionExpense: "{category} expenses"') &&
    enSrc.includes(
      'actionExpenseTitle: "Largest expense category: «{category}» at {money}. Open the {category} expenses in the Expenses workspace."',
    ),
);
ok(
  "4b FA keys exist: pure Persian (the workspace name is Persian; only the DATA placeholder may be Latin)",
  faSrc.includes('actionExpense: "هزینه‌های {category}"') &&
    faSrc.includes(
      'actionExpenseTitle: "بزرگ‌ترین دستهٔ هزینه: «{category}» به ارزش {money}. بازکردن هزینه‌های {category} در میز کار هزینه‌ها."',
    ),
);
ok(
  "4c placeholder parity: both languages interpolate exactly {category} (label) and {category}+{money} (title)",
  (() => {
    const enLabel = enSrc.match(/actionExpense: "([^"]+)"/)?.[1] ?? "";
    const faLabel = faSrc.match(/actionExpense: "([^"]+)"/)?.[1] ?? "";
    const enTitle = enSrc.match(/actionExpenseTitle: "([^"]+)"/)?.[1] ?? "";
    const faTitle = faSrc.match(/actionExpenseTitle: "([^"]+)"/)?.[1] ?? "";
    return (
      enLabel.includes("{category}") && faLabel.includes("{category}") &&
      enTitle.includes("{category}") && enTitle.includes("{money}") &&
      faTitle.includes("{category}") && faTitle.includes("{money}") &&
      !enLabel.includes("{money}") && !faLabel.includes("{money}")
    );
  })(),
);
ok(
  "4d the R99/R140 formatting law: fmtMoney is called INSIDE the component with the business's OWN currency",
  (() => {
    const idx = viewCode.indexOf("function ExpenseActionChip(");
    const body = viewCode.slice(idx, idx + 1600);
    return body.includes("fmtMoney(business, chip.totalMinor)") && !body.includes("totalMinor}") === false || body.includes("fmtMoney(business, chip.totalMinor)");
  })() && !enSrc.includes('actionExpenseTitle: "Largest expense category: «{category}» at {money}') === false,
);
ok(
  "4e the R152 hint law: the tooltip names the DESTINATION (the Expenses workspace), never what the report does",
  enSrc.includes("Open the {category} expenses in the Expenses workspace."),
);
ok(
  "4f title = aria-label = ONE source (the family's single-tooltip law)",
  (() => {
    const idx = viewCode.indexOf('data-testid="copilot-action-expense-facet"');
    const after = viewCode.slice(Math.max(0, idx - 400), idx);
    return after.includes("title={tooltip}") && after.includes("aria-label={tooltip}");
  })(),
);

// ==== [5] the REGRESSION PIN ===============================================

section("[5] the REGRESSION PIN — the chip family after the join");

ok(
  "5a the R153 product chip intact: the picker, the entity navigation, its testid",
  viewCode.includes("export function pickProductActionChip(") &&
    viewCode.includes('navigate({ kind: "entity", entity: "product", id: chip.productId })') &&
    (viewCode.match(/copilot-action-product/g) ?? []).length === 1,
);
ok(
  "5b the R143 perf chips intact: products → expenses → cashflow, the deterministic order",
  viewSrc.includes("const chips: PerfActionChip[] = [];") &&
    viewSrc.indexOf("actionPerfProducts") < viewSrc.indexOf("actionPerfExpenses") &&
    viewSrc.indexOf("actionPerfExpenses") < viewSrc.indexOf("actionPerfCashflow"),
);
ok(
  "5c the R143 expenses perf chip keeps its OWN destination (the window-shaped perf view — no dedupe violation)",
  viewSrc.includes('chips.push({ key: "actionPerfExpenses", param: "perf-expenses", ...(metaWindowOrNull(meta)) });'),
);
ok(
  "5d the R155 store facet law untouched: trim + blank-wholesale + the module-scoped orphan guard",
  storeSrc.includes("const cat = (view.category ?? \"\").trim();") &&
    storeSrc.includes("R155 — the expenses category facet serializes canonically"),
);
ok(
  "5e the R148/R147 chip families untouched: the stock throne and the stable-id outstanding drill",
  (viewCode.match(/copilot-action-topstock"/g) ?? []).length === 1 &&
    (viewCode.match(/copilot-action-debtor/g) ?? []).length === 1 &&
    (viewCode.match(/copilot-action-creditor/g) ?? []).length === 1,
);
ok(
  "5f the no-dedupe law holds in code: the facet chip and the perf chip are DIFFERENT destinations for the SAME fact",
  viewCode.includes('navigate({ kind: "module", module: "expenses", category: chip.category })') &&
    viewCode.includes('param: chip.param,'),
);

// ==== [6] the STYLING unification pin (the R167 mandate-4 sweep) ===========

section("[6] the STYLING unification pin — the copilot's own chip families share ONE interaction state");

ok(
  "6a the empty-state suggestion chips join the sibling family: focus-visible ring + active scale + hover lift + the Sparkles identity",
  (() => {
    const idx = viewCode.indexOf("suggestions.map((s) => (");
    const body = viewCode.slice(idx, idx + 1400);
    return (
      body.includes("focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background") &&
      body.includes("active:scale-[0.98]") &&
      body.includes("motion-reduce:active:scale-100") &&
      body.includes("hover:shadow-sm") &&
      body.includes("<Sparkles") &&
      body.includes("transition-all")
    );
  })(),
);
ok(
  "6b the follow-up chips join: focus-visible ring + active scale (the emerald family keeps its hue)",
  (() => {
    const idx = viewCode.indexOf("followUps.map((key) => (");
    const body = viewCode.slice(idx, idx + 900);
    return (
      body.includes("focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background") &&
      body.includes("active:scale-[0.98]") &&
      body.includes("motion-reduce:active:scale-100") &&
      body.includes("border-emerald-500/25")
    );
  })(),
);
ok(
  "6c the unification source intact: the recent-session chips' family byte-pattern (the R156-era geometry)",
  viewCode.includes("hover:border-emerald-500/40 hover:bg-emerald-500/5") &&
    (viewCode.match(/motion-reduce:active:scale-100/g) ?? []).length >= 3,
);
ok(
  "6d the icon treatments keep motion-safety: every group-hover icon transition carries motion-reduce",
  (() => {
    const sugIdx = viewCode.indexOf("suggestions.map((s) => (");
    const sugBody = viewCode.slice(sugIdx, sugIdx + 1400);
    return sugBody.includes("transition-colors dark:group-hover:text-emerald-400 motion-reduce:transition-none");
  })(),
);

// ==== verdict ==============================================================

console.log(`\n== r167-expense-facet-check: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
