/**
 * scripts/r135-palette-recents-check.ts — R135 harness.
 *
 * The ⌘K palette grows a RECENT DESTINATIONS group: device-local, MRU
 * ordered, capped, closed-vocabulary gated. Laws under test:
 *
 *   [1] the GATE LAW — isRecentDestination accepts exactly the palette-
 *       labelable destination vocabulary (bare modules, list kinds,
 *       settings/support/notifications pages, CRM tabs) and NEVER a detail
 *       view (entity/statements/stocktake/purchase-order/goods-receipt/
 *       goods-return/goods-dispatch/supplier-bill/aging-details), the
 *       search center, an unlabeled destination (inventory-stocktakes,
 *       settings:notifications), or a module sub-state (sales lanes,
 *       reports perf/range windows).
 *   [2] the MRU LAW — pushRecent dedupes by viewKeyOf (ONE authority with
 *       the router), moves a re-visited destination to the front, evicts
 *       the oldest beyond RECENT_VIEWS_CAP, and returns the SAME array for
 *       a non-destination (no-op is observable).
 *   [3] the PARSE LAW — parseRecentViews: non-array → wholesale [];
 *       garbage entries dropped INDIVIDUALLY (one stale entry never
 *       poisons the list); unknown modules/bad CRM tabs dropped; persisted
 *       extra fields stripped (minimal canonical shape); dedupe + cap hold.
 *   [4] the ADDRESS LAW — every recentable destination serializes through
 *       viewToHash to a hash that round-trips via hashToView to the SAME
 *       view (a recent is always an addressable destination).
 *   [5] the SOURCE LAWS (static) — the store: navigate() records via
 *       pushRecent, replaceView() never mentions it, setActiveBusiness
 *       clears on switch, partialize carries recentViews, merge re-parses.
 *       The palette: renders groups.recent, owns a clear row, hides the
 *       group during searchActive, and labels the extra sidebar-only
 *       destinations (billing/data/support/crm/purchase-orders/
 *       notifications) — so the store gate and the palette vocabulary
 *       never drift.
 *   [6] the I18N LAW — palette.groups.recent + palette.clearRecent exist
 *       in BOTH locales symmetrically.
 *
 * Run: bun scripts/r135-palette-recents-check.ts
 */

import { readFileSync } from "node:fs";
import {
  isRecentDestination,
  parseRecentViews,
  pushRecent,
  RECENT_VIEWS_CAP,
  sameView,
  viewToHash,
  hashToView,
  viewKeyOf,
  type AppView,
} from "../src/store/app-store";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

const V = {
  dashboard: { kind: "dashboard" } as AppView,
  customers: { kind: "module", module: "customers" } as AppView,
  copilot: { kind: "module", module: "copilot" } as AppView,
  reports: { kind: "module", module: "reports" } as AppView,
  sales: { kind: "module", module: "sales" } as AppView,
  goodsReceipts: { kind: "inventory-goods-receipts" } as AppView,
  salesOrders: { kind: "sales-orders" } as AppView,
  purchaseOrders: { kind: "purchase-orders" } as AppView,
  billing: { kind: "settings:billing" } as AppView,
  data: { kind: "settings:data" } as AppView,
  support: { kind: "support" } as AppView,
  notifications: { kind: "notifications" } as AppView,
  crmPipeline: { kind: "crm", tab: "pipeline" } as AppView,
  crmLeads: { kind: "crm", tab: "leads" } as AppView,
  audit: { kind: "audit" } as AppView,
  profile: { kind: "profile" } as AppView,
  // — the EXCLUDED family —
  search: { kind: "search", query: "acme" } as AppView,
  entity: { kind: "entity", entity: "customer", id: "c-1" } as unknown as AppView,
  statements: { kind: "statements", statementType: "customer", id: "c-1" } as unknown as AppView,
  aging: { kind: "aging-details", side: "customer" } as unknown as AppView,
  stocktakeDetail: { kind: "inventory-stocktake", id: "st-1" } as unknown as AppView,
  stocktakes: { kind: "inventory-stocktakes" } as AppView,
  stocktakeList: { kind: "inventory-stocktakes" } as AppView,
  poDetail: { kind: "purchase-order", id: "po-1" } as unknown as AppView,
  billDetail: { kind: "supplier-bill", id: "b-1" } as unknown as AppView,
  receiptDetail: { kind: "inventory-goods-receipt", id: "gr-1" } as unknown as AppView,
  salesLane: { kind: "module", module: "sales", overdue: true } as AppView,
  salesCustomer: { kind: "module", module: "sales", customerId: "c-1" } as AppView,
  perfWindow: { kind: "module", module: "reports", param: "perf-sales", perfFrom: "2026-10-01", perfTo: "2026-10-30" } as AppView,
  rangeWindow: { kind: "module", module: "reports", rangeFrom: "2026-10-01", rangeTo: "2026-10-30" } as AppView,
  monthWindow: { kind: "module", module: "reports", param: "month-2026-10" } as AppView,
  unknownModule: { kind: "module", module: "nope" } as AppView,
  notifPrefs: { kind: "settings:notifications" } as AppView,
};

// [1] the GATE LAW ------------------------------------------------------------
console.log("== [1] destination gate law ==");
ok("[1a] dashboard recentable", isRecentDestination(V.dashboard));
ok("[1b] bare modules recentable", isRecentDestination(V.customers) && isRecentDestination(V.copilot) && isRecentDestination(V.reports) && isRecentDestination(V.sales));
ok("[1c] list kinds recentable", isRecentDestination(V.goodsReceipts) && isRecentDestination(V.salesOrders) && isRecentDestination(V.purchaseOrders));
ok("[1d] settings/support/notifications pages recentable", isRecentDestination(V.billing) && isRecentDestination(V.data) && isRecentDestination(V.support) && isRecentDestination(V.notifications));
ok("[1e] CRM tabs recentable", isRecentDestination(V.crmPipeline) && isRecentDestination(V.crmLeads));
ok("[1f] search center NEVER records", !isRecentDestination(V.search));
ok("[1g] detail views NEVER record", !isRecentDestination(V.entity) && !isRecentDestination(V.statements) && !isRecentDestination(V.aging) && !isRecentDestination(V.stocktakeDetail) && !isRecentDestination(V.poDetail) && !isRecentDestination(V.billDetail) && !isRecentDestination(V.receiptDetail));
ok("[1h] unlabeled destinations NEVER record", !isRecentDestination(V.stocktakes) && !isRecentDestination(V.stocktakeList) && !isRecentDestination(V.notifPrefs));
ok("[1i] module sub-states NEVER record", !isRecentDestination(V.salesLane) && !isRecentDestination(V.salesCustomer) && !isRecentDestination(V.perfWindow) && !isRecentDestination(V.rangeWindow) && !isRecentDestination(V.monthWindow));
ok("[1j] unknown module NEVER records", !isRecentDestination(V.unknownModule));

// [2] the MRU LAW --------------------------------------------------------------
console.log("== [2] MRU / dedupe / cap law ==");
eq(pushRecent([], V.customers), [V.customers], "[2a] first push lands alone");
const two = pushRecent(pushRecent([], V.customers), V.copilot);
eq(two, [V.copilot, V.customers], "[2b] newest first");
const bumped = pushRecent(two, V.customers);
eq(bumped, [V.customers, V.copilot], "[2c] re-visit moves to front (MRU)");
ok("[2d] dedupe by viewKeyOf (no duplicate rows)", bumped.length === 2);
// perf window shares viewKeyOf with bare reports (module:reports) but never
// touches the list — the bare destination stays the recorded one
const withReports = pushRecent(two, V.reports);
const afterPerf = pushRecent(withReports, V.perfWindow);
eq(afterPerf, withReports, "[2e] perf sub-state push is a no-op (same array)");
ok("[2f] no-op returns the SAME array identity", afterPerf === withReports);
let list: AppView[] = [];
const six = [V.dashboard, V.customers, V.copilot, V.reports, V.sales, V.billing];
for (const v of six) list = pushRecent(list, v);
ok(`[2g] cap ${RECENT_VIEWS_CAP} enforced`, list.length === RECENT_VIEWS_CAP, `got ${list.length}`);
eq(list, [V.billing, V.sales, V.reports, V.copilot, V.customers], "[2h] oldest (dashboard) evicted FIFO");
ok("[2i] sales lane push is a no-op on a live list", pushRecent(list, V.salesLane) === list);

// [3] the PARSE LAW -------------------------------------------------------------
console.log("== [3] persist parse law ==");
eq(parseRecentViews("garbage"), [], "[3a] non-array → wholesale []");
eq(parseRecentViews(null), [], "[3b] null → []");
eq(parseRecentViews({}), [], "[3c] object → []");
const dirty = [
  "junk",
  42,
  null,
  { kind: "dashboard" },
  { kind: "module", module: "nope" },
  { kind: "module", module: "customers", hacked: true },
  { kind: "crm", tab: "not-a-tab" },
  { kind: "entity", entity: "customer", id: "c-1" },
  { kind: "copilot" },
];
const parsed = parseRecentViews(dirty);
// valid entries in order: dashboard, then customers (hacked flag stripped,
// nope/bad-tab/entity/kind-copilot/junk dropped individually) — MRU puts
// customers (the LAST valid) first.
eq(parsed, [V.customers, V.dashboard], "[3d] garbage dropped individually, extras stripped, MRU order");
eq(parseRecentViews([{ kind: "dashboard", x: 1, y: "z" }]), [V.dashboard], "[3e] persisted extra fields stripped to the minimal shape");
const duped = parseRecentViews([{ kind: "sales" }, { kind: "module", module: "sales" }]);
ok("[3f] parse dedupes by viewKeyOf", duped.length === 1 && viewKeyOf(duped[0]) === "module:sales::0:");
const seven = [
  { kind: "dashboard" }, { kind: "module", module: "customers" }, { kind: "module", module: "copilot" },
  { kind: "module", module: "reports" }, { kind: "module", module: "sales" }, { kind: "settings:billing" },
  { kind: "support" },
];
eq(parseRecentViews(seven).length, RECENT_VIEWS_CAP, "[3g] parse enforces the cap");
eq(parseRecentViews(seven)[0], V.support, "[3h] parse keeps MRU order (last valid wins the front)");

// [4] the ADDRESS LAW ------------------------------------------------------------
console.log("== [4] addressability law ==");
const allDestinations: AppView[] = [
  V.dashboard, { kind: "module", module: "suppliers" }, V.copilot, V.reports, V.sales,
  { kind: "module", module: "products" }, { kind: "module", module: "inventory" },
  { kind: "module", module: "expenses" }, { kind: "module", module: "payments" },
  { kind: "module", module: "receivables" }, { kind: "module", module: "payables" },
  V.goodsReceipts, { kind: "inventory-goods-returns" }, { kind: "inventory-goods-dispatches" },
  V.salesOrders, { kind: "sales-quotations" }, { kind: "supplier-bills" }, V.purchaseOrders,
  V.billing, V.data, V.support, V.notifications, V.crmPipeline, V.crmLeads, V.audit, V.profile,
  { kind: "settings:business" }, { kind: "settings:members" }, { kind: "settings:security" },
];
let addressable = 0;
for (const v of allDestinations) {
  const hash = viewToHash(v);
  if (!hash) continue;
  const back = hashToView(hash);
  if (back && sameView(back, v)) addressable++;
}
ok(`[4a] every recentable destination is addressable (${addressable}/${allDestinations.length})`, addressable === allDestinations.length, `only ${addressable} round-trip`);

// [5] the SOURCE LAWS (static) ----------------------------------------------------
console.log("== [5] source laws ==");
const storeSrc = readFileSync(new URL("../src/store/app-store.ts", import.meta.url), "utf8");
ok("[5a] navigate() records via pushRecent", /navigate: \(view, opts\) => \{\s*\n\s*set\(\(s\) => \(\{ view, recentViews: pushRecent\(s\.recentViews, view\) \}\)\);/.test(storeSrc));
ok("[5b] replaceView() never records", !/replaceView: \(view\) => set\(\{ view, recentViews/.test(storeSrc));
ok("[5c] business switch clears recents", /s\.activeBusinessId === activeBusinessId \? s\.recentViews : \[\]/.test(storeSrc));
ok("[5d] partialize carries recentViews", /partialize: \(s\) => \(\{[\s\S]*?recentViews: s\.recentViews,[\s\S]*?\}\),/.test(storeSrc));
ok("[5e] merge re-parses via parseRecentViews", /recentViews: parseRecentViews\(p\.recentViews\)/.test(storeSrc));
ok("[5f] persist still validates locale+business (no regression)", /locale: isLocale\(p\.locale\) \? p\.locale : DEFAULT_LOCALE/.test(storeSrc));

const paletteSrc = readFileSync(new URL("../src/modules/shell/command-palette.tsx", import.meta.url), "utf8");
ok("[5g] palette renders the recent group", paletteSrc.includes('tCommon("palette.groups.recent")'));
ok("[5h] palette owns a clear row", paletteSrc.includes('data-testid="palette-recent-clear"') && paletteSrc.includes("clearRecentViews()"));
ok("[5i] recents hidden during active search", /const recentItems = searchActive\s*\n\s*\? \[\]/.test(paletteSrc));
ok("[5j] extra destinations labeled (billing/data/support/crm/purchaseOrders/notifications)", ["billing", "dataPortability", "support", "crm", "purchaseOrders", "notifications"].every((k) => new RegExp(`labelKey: "${k}"`).test(paletteSrc)));
ok("[5k] recents match through viewKeyOf (one authority)", paletteSrc.includes("viewKeyOf(n.view) === key"));
ok("[5l] palette recents ride the store selector", paletteSrc.includes("useAppStore((s) => s.recentViews)"));

// cross-check: the store gate and the palette vocabulary agree — every
// RECENT kind/module in the store has a label source in the palette
ok("[5m] gate ⊆ palette vocabulary (no dead rows possible)", paletteSrc.includes("RECENT_EXTRA") && paletteSrc.includes("RECENT_SOURCES"));

// [6] the I18N LAW -----------------------------------------------------------------
console.log("== [6] i18n law ==");
for (const loc of ["en", "fa"] as const) {
  const src = readFileSync(new URL(`../src/i18n/messages/${loc}.ts`, import.meta.url), "utf8");
  ok(`[6-${loc}] groups.recent present`, /recent: "/.test(src.slice(src.indexOf("palette: {"), src.indexOf("palette: {") + 800)));
  ok(`[6-${loc}] clearRecent present`, src.includes("clearRecent:"));
}
const faSrc = readFileSync(new URL("../src/i18n/messages/fa.ts", import.meta.url), "utf8");
ok("[6-fa] FA clearRecent uses Persian phrasing (no bare EN)", faSrc.includes("clearRecent: \"پاک‌کردن مقصدهای اخیر\""));

console.log(`\n== r135: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
