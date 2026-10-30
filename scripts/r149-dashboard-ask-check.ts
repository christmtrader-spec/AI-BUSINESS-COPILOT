/**
 * scripts/r149-dashboard-ask-check.ts — R149 harness.
 *
 * THE DASHBOARD JOINS THE FAMILY: the copilot teaser grows the FIFTH
 * ?ask= producer (ONE context-aware, data-gated question picked from the
 * dashboard's OWN live summary by pickDashboardAsk), and the At-a-glance
 * leader citation JOINS the R148 row-level drill (invQuery: head.name).
 *
 *   [1] the PICKER LAW (unit) — deterministic priority restock → debtor →
 *       stock → sales; each gate on ITS OWN proof; an empty book / absent
 *       summary → null (honest silence); the additive outstanding
 *       omission falls through honestly; purity (same input → same pick).
 *   [2] the PRODUCER LAW (dashboard source) — the pill navigates with
 *       ask: question (the R144 grammar verbatim), gated on copilot:use,
 *       the button text IS the composed question, ONE tooltip source
 *       (the generic askCopilotHint), testid dash-ask-copilot, summary
 *       absence renders nothing.
 *   [3] the LEADER-DRILL LAW (dashboard source) — the citation carries
 *       invQuery: head.name (the R148 grammar), motion-reduce joins the
 *       R148 unification family, the gate/share laws untouched.
 *   [4] the i18n LAW — 4 question keys EN/FA symmetric, pure Persian, no
 *       {placeholders} (a fake-window promise impossible by
 *       construction); the leader tooltip tail says SEARCH in both.
 *   [5] the REGRESSION PIN — the R144 ask grammar + 500 composer cap
 *       untouched, the R148 inventory seed consumer untouched, the r103
 *       D6 re-pin holds, the R147 outstanding navigation untouched.
 *
 * Run: npx tsx scripts/r149-dashboard-ask-check.ts
 */

import { readFileSync } from "node:fs";
import { pickDashboardAsk } from "../src/modules/dashboard/dashboard-view";

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

const dashSrc = readFileSync("src/modules/dashboard/dashboard-view.tsx", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const copilotSrc = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const valPanelSrc = readFileSync("src/modules/reports/inventory-valuation-panel.tsx", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

// The summary factory: a FULL Pick<ReportsSummary, …>-shaped slice for the
// picker (next build type-checks this file — the factory satisfies the
// parameter type honestly, zeros are the neutral absent-value).
function sum(parts: {
  lowStockCount?: number;
  receivableCount?: number;
  topValue?: number;
  salesCount?: number;
}): Parameters<typeof pickDashboardAsk>[0] {
  return {
    kpis: {
      revenueMinor: 0,
      salesCount: parts.salesCount ?? 0,
      collectedMinor: 0,
      expensesMinor: 0,
      expensesCount: 0,
      netCashMinor: 0,
    },
    inventory: {
      lowStockCount: parts.lowStockCount ?? 0,
      lowStockItems: [],
      ...(parts.topValue !== undefined
        ? { topValueProducts: [{ productId: "p1", name: "X", estimatedValueMinor: parts.topValue }] }
        : {}),
    },
    ...(parts.receivableCount !== undefined
      ? { outstanding: { receivableCount: parts.receivableCount } }
      : {}),
  };
}

section("[1] the PICKER LAW — deterministic priority, each gate on ITS OWN proof");
{
  ok("1a null → null (never a pill about nothing)", pickDashboardAsk(null) === null);
  ok("1b undefined → null (summary still loading — honest silence)", pickDashboardAsk(undefined) === null);
  ok("1c the EMPTY book → null (no gates pass)", pickDashboardAsk(sum({})) === null);
  ok("1d priority 1 — low stock wins over everything", pickDashboardAsk(sum({ lowStockCount: 2, receivableCount: 3, topValue: 500, salesCount: 4 })) === "dashAskRestock");
  ok("1e priority 2 — debtor wins when no low stock", pickDashboardAsk(sum({ receivableCount: 3, topValue: 500, salesCount: 4 })) === "dashAskDebtor");
  ok("1f priority 3 — stock value wins when no debt", pickDashboardAsk(sum({ topValue: 500, salesCount: 4 })) === "dashAskStock");
  ok("1g priority 4 — sales is the always-on fallback", pickDashboardAsk(sum({ salesCount: 4 })) === "dashAskSales");
  ok("1h the zero-stock gate NEVER fires (0 is not > 0)", pickDashboardAsk(sum({ lowStockCount: 0 })) === null || pickDashboardAsk(sum({ lowStockCount: 0, salesCount: 1 })) === "dashAskSales");
  ok("1i a ZERO-value head never claims the stock question", pickDashboardAsk(sum({ topValue: 0 })) === null);
  ok("1j a NEGATIVE-value head never claims the stock question", pickDashboardAsk(sum({ topValue: -5 })) === null);
  ok("1k the additive omission is honest — outstanding absent → debtor gate falls through", pickDashboardAsk(sum({ topValue: 500, salesCount: 4 })) === "dashAskStock");
  ok("1l an empty topValueProducts array → falls through to sales", (() => {
    const s = sum({ salesCount: 2 });
    if (!s) return false;
    s.inventory.topValueProducts = [];
    return pickDashboardAsk(s) === "dashAskSales";
  })());
  ok("1m a zero receivableCount never claims the debtor question", pickDashboardAsk(sum({ receivableCount: 0, salesCount: 2 })) === "dashAskSales");
  ok("1n PURE — same input, same pick (×3)", (() => {
    const s = sum({ lowStockCount: 1 });
    return pickDashboardAsk(s) === "dashAskRestock" && pickDashboardAsk(s) === "dashAskRestock" && pickDashboardAsk(s) === "dashAskRestock";
  })());
  ok("1o the picker is exported for the battery (unit-law visibility)", /export function pickDashboardAsk/.test(dashSrc));
  ok("1p the priority order is LITERALLY restock→debtor→stock→sales in source", (() => {
    const a = dashSrc.indexOf('return "dashAskRestock";');
    const b = dashSrc.indexOf('return "dashAskDebtor";');
    const c = dashSrc.indexOf('return "dashAskStock";');
    const d = dashSrc.indexOf('return "dashAskSales";');
    return a >= 0 && a < b && b < c && c < d;
  })());
}

section("[2] the PRODUCER LAW — the teaser pill rides the R144 grammar");
{
  ok("2a the pill navigates with ask: question (the R144 grammar verbatim)", /navigate\(\{ kind: "module", module: "copilot", ask: question \}\)/.test(dashSrc));
  ok("2b the pill is GATED on copilot:use (a seeded ask for a locked user is a lying affordance)", /if \(!askKey \|\| !can\(role, "copilot:use"\)\) return null;/.test(dashSrc));
  ok("2c the button text IS the composed question (the user sees what will be seeded)", /<span className="min-w-0 truncate" dir="auto">\s*\{question\}\s*<\/span>/.test(dashSrc.replace(/\n\s+/g, " ")));
  ok("2d ONE tooltip source — the generic seed-not-send askCopilotHint", /title=\{tAsk\("askCopilotHint"\)\}\s*aria-label=\{tAsk\("askCopilotHint"\)\}/.test(dashSrc.replace(/\n\s+/g, " ")));
  ok("2e the testid exists (dash-ask-copilot)", /data-testid="dash-ask-copilot"/.test(dashSrc));
  ok("2f the pick comes from the dashboard's OWN summary (never a second fetch)", /pickDashboardAsk\(summary\)/.test(dashSrc));
  ok("2g the question text rides the dashboard namespace keys", /const question = t\(askKey\);/.test(dashSrc));
  ok("2h the pill renders NOTHING when the summary is absent (the IIFE returns null)", /const askKey = pickDashboardAsk\(summary\);/.test(dashSrc));
}

section("[3] the LEADER-DRILL LAW — the citation joins the R148 seed grammar");
{
  ok("3a the citation carries invQuery: head.name (the leader's OWN name)", /invQuery: head\.name,/.test(dashSrc));
  ok("3b the landing is the SAME closed token (param: inventory)", (() => {
    const at = dashSrc.indexOf("function InventoryLeaderCitation");
    const block = at >= 0 ? dashSrc.slice(at, at + 3500) : "";
    return block.includes('module: "reports"') && block.includes('param: "inventory"') && block.includes("invQuery: head.name,");
  })());
  ok("3c motion-reduce joins the R148 unification family on the citation", /text-sky-700 transition-colors motion-reduce:transition-none hover:bg-sky-600\/10/.test(dashSrc.replace(/\n\s+/g, " ")));
  ok("3d the citation gate untouched (absent/non-positive head → honest silence)", /if \(!head \|\| !\(head\.estimatedValueMinor > 0\)\) return null;/.test(dashSrc));
  ok("3e the share rides the ONE helper (the r103 D5 law holds)", /stockSharePercent\(\s*head\.estimatedValueMinor,/.test(dashSrc.replace(/\n\s+/g, " ")));
  ok("3f the testid holds (leader-inventory)", /data-testid="leader-inventory"/.test(dashSrc));
}

section("[4] the i18n LAW — four questions EN/FA, pure Persian, SEARCH tails");
{
  const enKeys = ["dashAskRestock", "dashAskDebtor", "dashAskStock", "dashAskSales"];
  for (const k of enKeys) {
    ok(`4a EN has ${k}`, new RegExp(`\\b${k}: "`).test(enSrc));
  }
  const faTexts: Record<string, string> = {
    dashAskRestock: "کدام کالاها به شارژ مجدد نیاز دارند؟",
    dashAskDebtor: "الان کدام مشتری بیشترین بدهی را به من دارد؟",
    dashAskStock: "الان موجودی انبار من چقدر ارزش دارد؟",
    dashAskSales: "فروش اخیر من چطور بوده است؟",
  };
  for (const [k, v] of Object.entries(faTexts)) {
    ok(`4b FA has a pure-Persian ${k}`, faSrc.includes(`${k}: "${v}"`));
  }
  ok("4c no question key carries an ICU placeholder (a fake-window promise impossible by construction)", enKeys.every((k) => {
    const m = enSrc.match(new RegExp(`${k}: "([^"]*)"`));
    return m ? !m[1].includes("{") : false;
  }));
  ok("4d EN questions end with ? (they ARE questions)", enKeys.every((k) => {
    const m = enSrc.match(new RegExp(`${k}: "([^"]*)"`));
    return m ? m[1].endsWith("?") : false;
  }));
  ok("4e the EN leader tooltip tail says SEARCH (the R148 drill law wording)", /statInventoryLeaderTooltip: "[^"]*Search the detailed valuation for this product\."/.test(enSrc));
  ok("4f the FA leader tooltip tail says SEARCH (جستجو)", /statInventoryLeaderTooltip: "[^"]*جستجوی این کالا در ارزیابی تفصیلی\."/.test(faSrc));
  ok("4g the tooltip keeps the proven fact ({name} + {money} in both locales)", enSrc.includes('statInventoryLeaderTooltip: "Largest stock value: «{name}» at {money}') && faSrc.includes("statInventoryLeaderTooltip: \"بزرگ‌ترین ارزش موجودی: «{name}» به ارزش {money}"));
  ok("4h the generic hint is UNTOUCHED (one seed-not-send wording family-wide)", enSrc.includes('askCopilotHint: "Opens the Copilot with a ready question — edit it before sending."'));
}

section("[5] the REGRESSION PIN — the family laws this round must not disturb");
{
  ok("5a the R144 ask grammar survives (copilot branch in hashToView)", /path === "copilot" && query\.has\("ask"\)/.test(storeSrc));
  ok("5b the R144 canonical serialization survives", /#\$\{encodeURIComponent\(ask\)\}|ask=\$\{encodeURIComponent\(ask\)\}/.test(storeSrc) || storeSrc.includes("encodeURIComponent(ask)"));
  ok("5c the R148 inventory seed grammar survives (invQuery parse)", storeSrc.includes('query.get("q")'));
  ok("5d the R148 seed consumer survives (seededQRef identity gate)", /seededQRef/.test(valPanelSrc));
  ok("5e the R147 outstanding drill navigation untouched (stable partyId, no bucket)", /navigate\(\{ kind: "aging-details", side: chip\.side, partyId: chip\.partyId \}\)/.test(copilotSrc));
  ok("5f the r103 D6 re-pin holds in the r103 battery source", (() => {
    const r103 = readFileSync("scripts/r103-tile-unit.ts", "utf8");
    return r103.includes('block.includes("invQuery: head.name,")') && r103.includes("SEEDED with the leader name (R149)");
  })());
  ok("5g the composer cap is STILL the only 500 authority in the store", (storeSrc.match(/slice\(0, 500\)/g) ?? []).length === 1);
  ok("5h the dashboard does not grow a SECOND copilot navigation with ask (one producer per surface)", (dashSrc.match(/module: "copilot", ask:/g) ?? []).length === 1);
  ok("5i the teaser CTA itself stays UNSEEDED (the plain open is the no-context affordance)", /onClick=\{\(\) => navigate\(\{ kind: "module", module: "copilot" \}\)\}/.test(dashSrc));
  ok("5j the summary type grew ONLY additively (outstanding optional)", /outstanding\?: \{ receivableCount\?: number \};/.test(dashSrc));
}

console.log(`\nr149-dashboard-ask-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
