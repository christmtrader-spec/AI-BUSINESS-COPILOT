/**
 * scripts/r143-perf-chips-check.ts — R143 battery.
 *
 * Pins the perf action chips' RENDER WAVE (the R142 priority (1): wire the
 * battery-pinned pickPerfActionChips into the transcript) plus the two
 * companion fixes:
 *
 *   [1] DRIFT-FIX LAW — the client CopilotMeta.topProduct type carries the
 *       server's honest `unitsSold` name (merch-facts TopProductView), never
 *       the raw report field `qty`; the r100 fixtures agree.
 *   [2] PICKER REGRESSION — the r100 chip-picker law re-pinned live (order,
 *       gates, window authority, honest silence).
 *   [3] RENDER-SITE LAWS (copilot-view) — PerfActionChips mounts under
 *       `!m.failed && m.meta` AFTER the stock chips; container testid
 *       copilot-perf-chips; per-chip testids map 1:1 to the perf tokens;
 *       absent facts → null (honest silence).
 *   [4] NAVIGATION LAWS — the onClick navigates to module "reports" with the
 *       chip's param and the window ONLY as an all-or-nothing conditional
 *       spread (never an orphan boundary); NO direction is ever serialized
 *       (no meta fact names IN/OUT — the panel's honest default wins).
 *   [5] i18n PARITY — the 3 labels (existing) + 3 NEW titles EN/FA
 *       symmetric with byte-symmetric {name}/{money}/{category}/{count}
 *       placeholders and the «» quote law on both sides.
 *   [6] FORMATTING + STYLING LAWS — fmtMoney AND fmtCount formatted INSIDE
 *       the component (never raw ICU values in templates); the title and
 *       aria-label share ONE tooltip source; the violet focus-visible ring,
 *       transition-colors and the rtl chevron flip ride every chip.
 *   [7] PROFILE LOCALE LAW — the R141 observed flip is closed: the /me PATCH
 *       response locale may only drive the UI when the payload explicitly
 *       asked for a language change; the unconditional line is gone.
 *
 * Run: bun scripts/r143-perf-chips-check.ts
 */
export {};

import { readFileSync } from "node:fs";
import { pickPerfActionChips } from "../src/modules/copilot/copilot-view";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `actual=${a} expected=${e}`);
}

const view = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const profile = readFileSync("src/modules/settings/profile-view.tsx", "utf8");
const merch = readFileSync("src/lib/merch-facts.ts", "utf8");
const en = readFileSync("src/i18n/messages/en.ts", "utf8");
const fa = readFileSync("src/i18n/messages/fa.ts", "utf8");

// [1] DRIFT-FIX LAW --------------------------------------------------------------
// R153 re-pin — the type grew the ADDITIVE drill id (productId?: string |
// null; the unlinked mass stays null and the R153 picker refuses it). The
// unitsSold normalization law is untouched.
ok(
  "[1a] the client CopilotMeta.topProduct type says unitsSold (+ the R153 additive productId)",
  view.includes(
    "topProduct?: { name: string; unitsSold: number; revenueMinor: number; productId?: string | null } | null;",
  ),
);
ok(
  "[1b] the client meta type no longer says qty (the drift is dead)",
  !/topProduct\?: \{[^}]*qty/.test(view),
);
ok(
  "[1c] the server normalizes the report row to unitsSold (the wire truth)",
  merch.includes("unitsSold: first.qty"),
);

// [2] PICKER REGRESSION (r100 law re-pinned live) ---------------------------------
type MetaLike = Parameters<typeof pickPerfActionChips>[0];
const meta = (over: Record<string, unknown>): MetaLike =>
  ({
    days: 30,
    generatedAt: "2026-10-30T00:00:00.000Z",
    rangeFrom: "2026-10-01",
    rangeTo: "2026-10-30",
    sections: [],
    counts: {
      sales: 1, expenses: 1, openInvoices: 0, openBills: 0, activeProducts: 1,
      lowStock: 0, topProducts: 1, expenseCategories: 1, timelineDays: 30,
      recentPayments: 2,
    },
    topProduct: { name: "Akar Widget", unitsSold: 3, revenueMinor: 1000000 },
    topExpenseCategory: { category: "Rent", totalMinor: 400000 },
    ...over,
  }) as MetaLike;

eq(
  pickPerfActionChips(meta({})).map((c) => c.key),
  ["actionPerfProducts", "actionPerfExpenses", "actionPerfCashflow"],
  "[2a] three proven facts → three chips in the deterministic order",
);
ok(
  "[2b] the window is the meta's OWN range keys",
  pickPerfActionChips(meta({})).every((c) => c.from === "2026-10-01" && c.to === "2026-10-30"),
);
eq(
  pickPerfActionChips(meta({ topProduct: null, topExpenseCategory: null, counts: undefined })),
  [],
  "[2c] no proven fact → honest silence",
);
const badWindow = pickPerfActionChips(meta({ rangeFrom: "not-a-date" }));
ok(
  "[2d] a malformed range drops the WINDOW but never the chip",
  badWindow.length === 3 && badWindow.every((c) => c.from === null && c.to === null),
);
ok(
  "[2e] the params map kind→kind (the closed grammar)",
  pickPerfActionChips(meta({})).map((c) => c.param).join(",") === "perf-sales,perf-expenses,perf-cashflow",
);

// [3] RENDER-SITE LAWS -------------------------------------------------------------
ok(
  "[3a] PerfActionChips mounts under the same !m.failed && m.meta gate",
  /{!m\.failed && m\.meta \? \(\n\s*<PerfActionChips meta=\{m\.meta\} business=\{business\} \/>\n\s*\) : null}/.test(view),
);
ok(
  "[3b] the perf chips mount AFTER the stock chips (deterministic row order)",
  view.indexOf("<StockActionChips meta={m.meta} business={business} />") <
    view.indexOf("<PerfActionChips meta={m.meta} business={business} />"),
);
ok(
  "[3c] the container carries its testid",
  view.includes('data-testid="copilot-perf-chips"'),
);
ok(
  "[3d] per-chip testids map 1:1 to the perf tokens",
  view.includes('"copilot-action-perf-sales"') &&
    view.includes('"copilot-action-perf-expenses"') &&
    view.includes('"copilot-action-perf-cashflow"'),
);
ok(
  "[3e] absent facts → null (the honest-silence law, like StockActionChips)",
  /const chips = pickPerfActionChips\(meta\);\n\s*if \(chips\.length === 0\) return null;/.test(view),
);

// [4] NAVIGATION LAWS ---------------------------------------------------------------
ok(
  "[4a] the onClick navigates to module reports with the chip's param",
  /navigate\(\{\n\s*kind: "module",\n\s*module: "reports",\n\s*param: chip\.param,/.test(view),
);
ok(
  "[4b] the window is an ALL-OR-NOTHING conditional spread (never an orphan boundary)",
  view.includes("...(chip.from && chip.to ? { perfFrom: chip.from, perfTo: chip.to } : {}),"),
);
ok(
  "[4c] NO direction is ever serialized from a chip (no meta fact names IN/OUT)",
  !/perfDirection/.test(view.slice(view.indexOf("function PerfActionChips"), view.indexOf("// ---- Follow-up suggestions"))),
);

// [5] i18n PARITY --------------------------------------------------------------------
for (const key of [
  "actionPerfProducts",
  "actionPerfExpenses",
  "actionPerfCashflow",
  "actionPerfProductsTitle",
  "actionPerfExpensesTitle",
  "actionPerfCashflowTitle",
]) {
  const re = new RegExp(`    ${key}: "`);
  ok(`[5] ${key} exists in EN and FA`, re.test(en) && re.test(fa));
}
const enProd = en.match(/    actionPerfProductsTitle: "(.*)",/)?.[1] ?? "";
const faProd = fa.match(/    actionPerfProductsTitle: "(.*)",/)?.[1] ?? "";
const enExp = en.match(/    actionPerfExpensesTitle: "(.*)",/)?.[1] ?? "";
const faExp = fa.match(/    actionPerfExpensesTitle: "(.*)",/)?.[1] ?? "";
const enCash = en.match(/    actionPerfCashflowTitle: "(.*)",/)?.[1] ?? "";
const faCash = fa.match(/    actionPerfCashflowTitle: "(.*)",/)?.[1] ?? "";
ok(
  "[5a] the title placeholders are byte-symmetric EN/FA",
  enProd.includes("{name}") === faProd.includes("{name}") &&
    enProd.includes("{money}") === faProd.includes("{money}") &&
    enExp.includes("{category}") === faExp.includes("{category}") &&
    enExp.includes("{money}") === faExp.includes("{money}") &&
    enCash.includes("{count}") === faCash.includes("{count}"),
);
ok(
  "[5b] the «» quote law rides both locales' product/expense titles",
  enProd.includes("«{name}»") && faProd.includes("«{name}»") &&
    enExp.includes("«{category}»") && faExp.includes("«{category}»"),
);
ok(
  "[5c] the FA titles are pure Persian (no Latin content words)",
  !/[A-Za-z]{3,}/.test(faProd.replace(/\{[a-z]+\}/g, "")) &&
    !/[A-Za-z]{3,}/.test(faExp.replace(/\{[a-z]+\}/g, "")) &&
    !/[A-Za-z]{3,}/.test(faCash.replace(/\{[a-z]+\}/g, "")),
);

// [6] FORMATTING + STYLING LAWS --------------------------------------------------------
ok(
  "[6a] the tooltips format money INSIDE the component (fmtMoney, never raw minors)",
  /money: fmtMoney\(business, productFact\.revenueMinor\)/.test(view) &&
    /money: fmtMoney\(business, expenseFact\.totalMinor\)/.test(view),
);
ok(
  "[6b] the cashflow count rides the ONE-locale formatter (fmtCount)",
  view.includes("count: fmtCount(uiLocale, meta.counts?.recentPayments ?? 0)"),
);
ok(
  "[6c] fmtCount is imported from the ONE finance-kit source",
  view.includes('import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";'),
);
ok(
  "[6d] title and aria-label share ONE tooltip source",
  /title=\{tooltip\}\n\s*aria-label=\{tooltip\}/.test(view),
);
ok(
  "[6e] every perf chip rides the violet focus-visible ring",
  /focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600/.test(view),
);
ok(
  "[6f] transition-colors + the rtl chevron flip ride the chips",
  /inline-flex items-center gap-1 rounded-full border px-2 py-0\.5 text-\[11px\] font-medium leading-none transition-colors/.test(view) &&
    /size-3 shrink-0 opacity-60 rtl:-scale-x-100/.test(view),
);

// [7] PROFILE LOCALE LAW ----------------------------------------------------------------
ok(
  "[7a] the locale gate requires an EXPLICIT language change in the payload",
  profile.includes("if (payload.locale !== undefined && data.locale && data.locale !== locale) {"),
);
ok(
  "[7b] the old unconditional apply is gone",
  !profile.includes("if (data.locale && data.locale !== locale) setLocale("),
);
ok(
  "[7c] the law is documented at the site",
  profile.includes("R143 — the locale CONFIRMATION law") &&
    profile.includes("welcome-card restore PATCH carries the full /me body"),
);

// ---- summary -------------------------------------------------------------------
console.log(`\nr143-perf-chips-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
