/**
 * scripts/r153-product-drill-check.ts — R153 harness.
 *
 * THE BEST-SELLER MEETS ITS OWN SURFACE: the copilot's proven topProduct
 * fact grows the STABLE catalog id (server: TopProductView + topProductOf
 * pass the report's own aggregation key VERBATIM — additive, r98's shape
 * law re-pinned to 4 fields), and ONE primary-hued chip under a grounded
 * answer opens the product's OWN page (the R152 destination — the entity
 * detail hosting the StockDialog). The id law is absolute: navigation
 * rides the stable productId, NEVER the name (R147 verbatim); the
 * unlinked mass (null id) is carried but never drilled (the R96 mass-row
 * law). Plus: the follow-up suggestion chips join the motion-safety
 * unification (the last chip family without the escape).
 *
 *   [1] the EXTRACTION law (unit) — topProductOf passes the id verbatim;
 *       null/missing/ill-typed ids degrade to null WITHOUT killing the
 *       fact; the guards still hold.
 *   [2] the PICKER law (unit) — pickProductActionChip gates: the id (the
 *       hard gate), the name, the positive values; old persisted metas
 *       stay honest; ONE chip max.
 *   [3] the COMPONENT law (source) — the chip navigates through the
 *       store's entity authority (never a hand-built hash), ONE tooltip
 *       source, the family geometry + motion-safety, the Package nav
 *       icon, the render site after the outstanding chips.
 *   [4] the i18n LAW — actionProduct + actionProductTitle EN/FA, FA pure
 *       Persian, placeholder parity.
 *   [5] the REGRESSION PIN — R152's row drill + R148/R147/R143 chips +
 *       the store authority + the server's ONE extractor + the ZERO-
 *       IMPORT merch law + the follow-up chips' motion-safety join.
 *
 * Run: npx tsx scripts/r153-product-drill-check.ts
 */

import { readFileSync } from "node:fs";
import { topProductOf } from "../src/lib/merch-facts";
import { pickProductActionChip } from "../src/modules/copilot/copilot-view";

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
const merchSrc = readFileSync("src/lib/merch-facts.ts", "utf8");
const snapSrc = readFileSync("src/lib/ai/snapshot.ts", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const reorderSrc = readFileSync("src/modules/reports/reorder-panel.tsx", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

const metaOf = (topProduct: unknown) => ({ topProduct }) as Parameters<typeof pickProductActionChip>[0];

section("[1] the EXTRACTION law — the report's own aggregation key rides verbatim");
{
  const rows = [{ name: "Persian Rug Mini", qty: 2, revenueMinor: 37_000, productId: "prod_abc" }];
  const got = topProductOf(rows);
  ok("1a a string id rides VERBATIM", got !== null && got.productId === "prod_abc", JSON.stringify(got));
  ok("1b a null id (the unlinked mass) stays null — the FACT survives",
    topProductOf([{ name: "X", qty: 1, revenueMinor: 5, productId: null }])?.productId === null &&
    topProductOf([{ name: "X", qty: 1, revenueMinor: 5, productId: null }])?.name === "X");
  ok("1c a MISSING id (old rows) degrades to null", topProductOf([{ name: "X", qty: 1, revenueMinor: 5 }])?.productId === null);
  ok("1d an ill-typed id (number) degrades to null", topProductOf([{ name: "X", qty: 1, revenueMinor: 5, productId: 42 }])?.productId === null);
  ok("1e a blank id degrades to null", topProductOf([{ name: "X", qty: 1, revenueMinor: 5, productId: "   " }])?.productId === null);
  ok("1f the guards still hold (empty/unnamed/non-finite → null)",
    topProductOf([]) === null &&
    topProductOf([{ name: " ", qty: 1, revenueMinor: 5 }]) === null &&
    topProductOf([{ name: "X", qty: Number.NaN, revenueMinor: 5 }]) === null);
  ok("1g a bad id NEVER kills the fact (name/units/revenue intact)",
    (() => { const f = topProductOf([{ name: "Y", qty: 3, revenueMinor: 900 }]); return f !== null && f.name === "Y" && f.unitsSold === 3 && f.revenueMinor === 900; })());
}

section("[2] the PICKER law — ONE chip, the id is the hard gate");
{
  ok("2a null/undefined meta → null", pickProductActionChip(null) === null && pickProductActionChip(undefined) === null);
  ok("2b no topProduct fact → null", pickProductActionChip(metaOf(null)) === null && pickProductActionChip(metaOf(undefined)) === null);
  ok("2c a non-object fact → null", pickProductActionChip(metaOf("garbage")) === null);
  ok("2d the OLD persisted meta (no productId key) → null (honest)",
    pickProductActionChip(metaOf({ name: "Old", unitsSold: 2, revenueMinor: 100 })) === null);
  ok("2e a null/blank id NEVER drills (the R96 mass law)",
    pickProductActionChip(metaOf({ name: "X", unitsSold: 1, revenueMinor: 5, productId: null })) === null &&
    pickProductActionChip(metaOf({ name: "X", unitsSold: 1, revenueMinor: 5, productId: "  " })) === null);
  ok("2f a nameless fact never drills",
    pickProductActionChip(metaOf({ name: "", unitsSold: 1, revenueMinor: 5, productId: "p1" })) === null);
  ok("2g zero/negative units or revenue → no chip about nothing",
    pickProductActionChip(metaOf({ name: "X", unitsSold: 0, revenueMinor: 5, productId: "p1" })) === null &&
    pickProductActionChip(metaOf({ name: "X", unitsSold: 1, revenueMinor: 0, productId: "p1" })) === null &&
    pickProductActionChip(metaOf({ name: "X", unitsSold: -1, revenueMinor: 5, productId: "p1" })) === null);
  const good = pickProductActionChip(metaOf({ name: "Persian Rug Mini", unitsSold: 2, revenueMinor: 37_000, productId: "prod_9" }));
  ok("2h a valid fact yields the EXACT chip object (id verbatim)",
    good !== null && good.productId === "prod_9" && good.name === "Persian Rug Mini" && good.unitsSold === 2 && good.revenueMinor === 37_000,
    JSON.stringify(good));
  ok("2i the client type grew the ADDITIVE id (old metas tolerated)",
    /topProduct\?: \{ name: string; unitsSold: number; revenueMinor: number; productId\?: string \| null \} \| null;/.test(viewSrc));
}

section("[3] the COMPONENT law — the chip opens the product's OWN surface");
{
  ok("3a the navigation rides the STABLE id through the store's entity grammar",
    /navigate\(\{ kind: "entity", entity: "product", id: chip\.productId \}\)/.test(viewSrc));
  ok("3b NO hand-built product hash in the view's chip (the store authority)", !/["'`]#\/products/.test(viewSrc));
  ok("3c title = aria-label = ONE tooltip source",
    /title=\{tooltip\}\s*\n\s*aria-label=\{tooltip\}/.test(viewSrc.replace(/\n\s+/g, "\n")));
  ok("3d the chip's testids (container + action)", viewSrc.includes('data-testid="copilot-product-chips"') && viewSrc.includes('data-testid="copilot-action-product"'));
  ok("3e the family geometry byte-pattern (rounded-full px-2 text-[11px]) + motion-safety",
    /"inline-flex items-center gap-1 rounded-full border px-2 py-0\.5 text-\[11px\] font-medium leading-none transition-colors motion-reduce:transition-none",/.test(viewSrc));
  ok("3f the primary identity (the R152 open-the-surface hue) + focus-visible outline",
    viewSrc.includes('"border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"') &&
    /focus-visible:outline-primary/.test(viewSrc));
  ok("3g the Package icon (the app's OWN products nav iconography)", /<Package className="size-3 shrink-0" aria-hidden="true" \/>/.test(viewSrc));
  ok("3h the honest-silence gate (absent/undrillable fact → null) + the failed/meta guards at the render site",
    viewSrc.includes("if (!chip) return null;") &&
    /<ProductActionChip meta=\{m\.meta\} business=\{business\} \/>/.test(viewSrc));
  ok("3i the chip renders AFTER the outstanding chips (deterministic family order)",
    viewSrc.indexOf("<OutstandingActionChips") < viewSrc.indexOf("<ProductActionChip"));
  ok("3j the tooltip formats money + count INSIDE the component (never a raw template)",
    /fmtCount\(uiLocale, chip\.unitsSold\)/.test(viewSrc) && /fmtMoney\(business, chip\.revenueMinor\)/.test(viewSrc));
}

section("[4] the i18n LAW — the destination named in both locales");
{
  ok("4a EN actionProduct present exactly once", (enSrc.match(/actionProduct:/g) ?? []).length === 1 && enSrc.includes('actionProduct: "The product\'s page"'));
  ok("4b FA actionProduct pure Persian", (faSrc.match(/actionProduct:/g) ?? []).length === 1 && faSrc.includes('actionProduct: "صفحهٔ خودِ کالا"'));
  ok("4c EN actionProductTitle carries the fact + the destination",
    enSrc.includes('actionProductTitle: "Best seller in this window: «{name}» — {count} units at {money}. Open the product\'s own page."'));
  ok("4d FA actionProductTitle pure Persian (ICU param names excepted — the family law)", (() => {
    const m = faSrc.match(/actionProductTitle: "([^"]+)"/);
    return m !== null && !/[A-Za-z]/.test(m[1].replace(/\{\w+\}/g, ""));
  })());
  ok("4e placeholder parity EN↔FA exactly {count},{money},{name}", (() => {
    const ph = (src: string) => { const m = src.match(/actionProductTitle: "([^"]+)"/); return m ? [...m[1].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",") : "?"; };
    return ph(enSrc) === "count,money,name" && ph(faSrc) === "count,money,name";
  })());
}

section("[5] the REGRESSION PIN — the family this round must not disturb");
{
  ok("5a R152's reorder row drill intact", /onRowClick=\{\(r\) =>/.test(reorderSrc) && reorderSrc.includes('entity: "product"'));
  ok("5b the store keeps the ONE entityToHash authority", storeSrc.includes("return entityToHash(view.entity, view.id);") && (storeSrc.match(/slice\(0, 500\)/g) ?? []).length === 1);
  ok("5c the R148 stock chips + R147 outstanding chips + R143 perf chips still exported",
    viewSrc.includes("export function pickStockActionChips") &&
    viewSrc.includes("export function pickOutstandingActionChips") &&
    viewSrc.includes("export function pickPerfActionChips"));
  ok("5d the snapshot keeps the ONE extractor (zero new queries)", snapSrc.includes("topProductOf(report.topProducts)") && !/topProduct:\s*await/.test(snapSrc));
  ok("5e the merch law: ZERO imports (client-safe by construction)", !/^import\s/m.test(merchSrc));
  ok("5f the follow-up chips join the motion-safety unification (the styling mandate)",
    /rounded-full border px-3 py-1\.5 text-xs font-medium transition-colors motion-reduce:transition-none/.test(viewSrc));
  ok("5g the server type carries the id as nullable (the unlinked mass stays honest)",
    /productId: string \| null;/.test(merchSrc));
}

console.log(`\nr153-product-drill-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
