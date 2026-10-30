/**
 * scripts/r151-lowstock-drill-check.ts — R151 harness.
 *
 * THE LOW-STOCK DRILL, BOTH LEVELS: the dashboard's amber alert AND the
 * low-stock notification CTA now land the REORDER SUGGESTIONS panel
 * (#/reports?reorder=1 — the Prompt 55 §X2 closed token, the surface that
 * EXISTS for restocking), not the generic products workspace. Legacy rows
 * keep "products" resolvable — never a dead CTA.
 *
 *   [1] the GRAMMAR LAW (store unit) — {module:"reports",param:"reorder"}
 *       serializes to #/reports?reorder=1; the inventory token still
 *       round-trips; the two tokens stay mutually exclusive.
 *   [2] the DASHBOARD LAW (source) — the alert button navigates
 *       param:"reorder", the label key says the honest destination, the
 *       motion-safety law rides the amber button, the gate unchanged.
 *   [3] the NOTIFICATION LAW — "reorder" in the closed ACTION_ROUTES +
 *       actionRoutePath + the dto map; "products" stays (legacy); the
 *       catalog entry carries "reorder" (text-law — the catalog module is
 *       server-only).
 *   [4] the i18n LAW — lowStockAlertAction + cta.reorder EN/FA symmetric,
 *       pure Persian.
 *   [5] the REGRESSION PIN — the R150 doors + R149 pill + R148 grammar
 *       untouched; the store keeps ONE 500 authority.
 *
 * Run: npx tsx scripts/r151-lowstock-drill-check.ts
 */

import { readFileSync } from "node:fs";
import { viewToHash, type AppView } from "../src/store/app-store";

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
const typesSrc = readFileSync("src/lib/notifications/types.ts", "utf8");
const dtoSrc = readFileSync("src/lib/notifications/dto.ts", "utf8");
const catalogSrc = readFileSync("src/lib/notifications/catalog.ts", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const searchSrc = readFileSync("src/modules/search/search-view.tsx", "utf8");
const paletteSrc = readFileSync("src/modules/shell/command-palette.tsx", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

section("[1] the GRAMMAR LAW — the reorder token round-trips (store unit)");
{
  const reorderView = { kind: "module", module: "reports", param: "reorder" } as AppView;
  ok("1a {reports, reorder} → #/reports?reorder=1", viewToHash(reorderView) === "#/reports?reorder=1", viewToHash(reorderView) ?? "null");
  const invView = { kind: "module", module: "reports", param: "inventory" } as AppView;
  ok("1b {reports, inventory} → #/reports?inventory=1", viewToHash(invView) === "#/reports?inventory=1", viewToHash(invView) ?? "null");
  const invSeeded = {
    kind: "module",
    module: "reports",
    param: "inventory",
    invQuery: "Persian Rug Mini",
  } as AppView;
  ok("1c the R148 q-seed still round-trips", viewToHash(invSeeded) === "#/reports?inventory=1&q=Persian%20Rug%20Mini", viewToHash(invSeeded) ?? "null");
  ok("1d the two tokens are mutually exclusive branches in source", storeSrc.indexOf('param === "reorder"') !== storeSrc.indexOf('param === "inventory"') && !storeSrc.includes('param === "reorder" && view.param === "inventory"'));
}

section("[2] the DASHBOARD LAW — the amber alert lands the restock surface");
{
  ok("2a the alert navigates {reports, reorder} (never products)", /navigate\(\{ kind: "module", module: "reports", param: "reorder" \}\)/.test(dashSrc));
  ok("2b the old products navigation is GONE from the alert", !/lowStockAlert[\s\S]{0,400}module: "products"/.test(dashSrc));
  ok("2c the motion-safety law rides the amber button", /border-amber-500\/40 text-amber-800 transition-colors motion-reduce:transition-none hover:bg-amber-500\/10/.test(dashSrc.replace(/\n\s+/g, " ")));
  ok("2d the alert gate unchanged (only when it exists — no fake urgency)", /lowStock\.length > 0 \? \(/.test(dashSrc));
  ok("2e the role=alert semantics kept", /role="alert"/.test(dashSrc));
}

section("[3] the NOTIFICATION LAW — the CTA joins the drill, legacy stays alive");
{
  // NOTE: the notifications modules are server-only — every law here is a
  // TEXT law on the source (the same style the catalog check uses).
  ok("3a reorder is in the closed ACTION_ROUTES", /"reorder",/.test(typesSrc) && /\"reorder\",\n[\s\S]{0,200}?\"support\",/.test(typesSrc));
  ok("3b the ActionRoute type rides the closed array (as const)", /ACTION_ROUTES = \[[\s\S]*?\] as const;/.test(typesSrc));
  ok("3c actionRoutePath(reorder) → #/reports?reorder=1", (() => {
    const at = typesSrc.indexOf('case "reorder":');
    if (at < 0) return false;
    const nextCase = typesSrc.indexOf('case "', at + 10);
    const block = typesSrc.slice(at, nextCase > 0 ? nextCase : undefined);
    return block.includes('return "#/reports?reorder=1";');
  })());
  ok("3d LEGACY products stays resolvable → #/products", (() => {
    const at = typesSrc.indexOf('case "products":');
    if (at < 0) return false;
    const nextCase = typesSrc.indexOf('case "', at + 10);
    const block = typesSrc.slice(at, nextCase > 0 ? nextCase : undefined);
    return block.includes('return "#/products";');
  })());
  ok("3e the dto map carries BOTH keys (the 38-F drift law)", dtoSrc.includes('reorder: "#/reports?reorder=1"') && dtoSrc.includes('products: "#/products"'));
  ok("3f the types switch carries BOTH cases", typesSrc.includes('case "reorder":') && typesSrc.includes('case "products":'));
  ok("3g the catalog's low-stock entry carries reorder (text-law, server-only module)", /BUSINESS_INVENTORY_LOW_STOCK: \{[\s\S]*?actionRoute: "reorder"/.test(catalogSrc));
  ok("3h the catalog keeps NO other entry on reorder (closed-scope law)", (catalogSrc.match(/actionRoute: "reorder"/g) ?? []).length === 1);
  ok("3i both maps name the drift comment (the 38-F law is written down)", dtoSrc.includes("38-F") && typesSrc.includes("reorder"));
}

section("[4] the i18n LAW — the honest destination named in both locales");
{
  ok("4a EN lowStockAlertAction says restock suggestions", enSrc.includes('lowStockAlertAction: "Open restock suggestions"'));
  ok("4b FA lowStockAlertAction pure Persian", faSrc.includes('lowStockAlertAction: "بازکردن پیشنهادهای سفارش مجدد"'));
  ok("4c EN cta.reorder present", enSrc.includes('reorder: "Open restock suggestions"'));
  ok("4d FA cta.reorder present", faSrc.includes('reorder: "بازکردن پیشنهادهای سفارش مجدد"'));
  ok("4e legacy cta.products stays (legacy rows)", enSrc.includes('products: "Open Products"') && faSrc.includes('products: "بازکردن محصولات"'));
  ok("4f no {placeholder} in the new keys", !/reorder: "[^"]*\{/.test(enSrc) && !/reorder: "[^"]*\{/.test(faSrc));
}

section("[5] the REGRESSION PIN — the family this round must not disturb");
{
  ok("5a the R150 search door untouched", /data-testid="search-ask-copilot"/.test(searchSrc) && /navigate\(\{ kind: "module", module: "copilot", ask: seed \}\)/.test(searchSrc));
  ok("5b the R150 palette door untouched", /data-testid="palette-ask-copilot"/.test(paletteSrc));
  ok("5c the R149 dashboard pill untouched", /data-testid="dash-ask-copilot"/.test(dashSrc) && (dashSrc.match(/module: "copilot", ask:/g) ?? []).length === 1);
  ok("5d the store keeps exactly ONE 500 slice authority", (storeSrc.match(/slice\(0, 500\)/g) ?? []).length === 1);
  ok("5e the R148 invQuery parse survives", storeSrc.includes('query.get("q")'));
  ok("5f the R144 ask grammar survives", /path === "copilot" && query\.has\("ask"\)/.test(storeSrc));
}

console.log(`\nr151-lowstock-drill-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
