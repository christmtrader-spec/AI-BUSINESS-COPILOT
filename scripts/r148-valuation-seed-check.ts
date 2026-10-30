/**
 * scripts/r148-valuation-seed-check.ts — R148 harness.
 *
 * The STOCK-THRONE ROW-LEVEL DRILL: the copilot's Crown/Medal chips now
 * seed the valuation panel's search box (#/reports?inventory=1&q=<name>),
 * so the crowned table opens ALREADY filtered to the product's row. AND
 * the chip family's motion-safety unification (R147's deferred item).
 *
 *   [1] the GRAMMAR LAW (store unit) — ?inventory=1&q=… parses (trim,
 *       slice to the input's own 80 cap, blank drops WHOLESALE, literal
 *       "%" survives the single decode); viewToHash re-serializes
 *       canonically; sameView: a DIFFERENT seed re-enters, the SAME seed
 *       is structurally equal (one seed per navigation); the token never
 *       leaks into other sub-views (reorder/perf ignore q).
 *   [2] the SEED-CONSUMER LAW (panel source) — the view selector, the
 *       seededQRef identity gate, seed-wins-then-never-replays, the seed
 *       rides the SAME debounce (no second fetch path), the input's
 *       maxLength 80 is the cap authority.
 *   [3] the CHIP LAW (copilot source) — both stock chips navigate with
 *       invQuery: fact.name; ONE tooltip source; the motion-safety law
 *       now rides ALL THREE chip families (stock + perf + outstanding).
 *   [4] the i18n LAW — the updated tooltips say SEARCH (not a bare
 *       panel-open) in EN + pure-Persian FA; {name}/{money} symmetry.
 *   [5] the REGRESSION PIN — the R144 ask grammar spot re-run (the q seed
 *       must not disturb the ask token), the R147 outstanding drill
 *       navigation untouched (no bucket/pastDue), the composer cap.
 *
 * Run: bun scripts/r148-valuation-seed-check.ts
 */

import { readFileSync } from "node:fs";
import { hashToView, viewToHash, sameView, type AppView } from "../src/store/app-store";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

const STORE = readFileSync("src/store/app-store.ts", "utf8");
const PANEL = readFileSync("src/modules/reports/inventory-valuation-panel.tsx", "utf8");
const VIEW = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const EN = readFileSync("src/i18n/messages/en.ts", "utf8");
const FA = readFileSync("src/i18n/messages/fa.ts", "utf8");

// ==== [1] the GRAMMAR LAW =====================================================

console.log("\n[1] GRAMMAR LAW (unit)");

{
  const v = hashToView("#/reports?inventory=1&q=" + encodeURIComponent("Lapis Coaster Set"));
  ok(
    "[1a] inventory=1&q= parses into the search seed",
    v.kind === "module" && (v as { invQuery?: string }).invQuery === "Lapis Coaster Set" &&
      (v as { param?: string }).param === "inventory",
  );
  const fa = hashToView("#/reports?inventory=1&q=" + encodeURIComponent("میخ کوب برقی"));
  ok("[1b] a Persian product name round-trips byte-exact", (fa as { invQuery?: string }).invQuery === "میخ کوب برقی");
  const pct = hashToView("#/reports?inventory=1&q=" + encodeURIComponent("100% Oak"));
  ok("[1c] a literal % survives (single decode — no corruption)", (pct as { invQuery?: string }).invQuery === "100% Oak");
  const padded = hashToView("#/reports?inventory=1&q=" + encodeURIComponent("  Padded Name  "));
  ok("[1d] the seed trims", (padded as { invQuery?: string }).invQuery === "Padded Name");
  const long = hashToView("#/reports?inventory=1&q=" + encodeURIComponent("x".repeat(200)));
  ok("[1e] the input's own 80 cap is the authority", ((long as { invQuery?: string }).invQuery?.length ?? 0) === 80);
  const blank = hashToView("#/reports?inventory=1&q=" + encodeURIComponent("   "));
  ok(
    "[1f] a blank seed drops WHOLESALE (bare ?inventory=1)",
    (blank as { invQuery?: string }).invQuery === undefined &&
      (blank as { param?: string }).param === "inventory",
  );
  const bare = hashToView("#/reports?inventory=1");
  ok("[1g] the bare token stays seedless", (bare as { invQuery?: string }).invQuery === undefined);
  const reorder = hashToView("#/reports?reorder=1&q=" + encodeURIComponent("sneaky"));
  ok("[1h] the q token NEVER leaks into the reorder sub-view", (reorder as { invQuery?: string }).invQuery === undefined && (reorder as { param?: string }).param === "reorder");
  const perf = hashToView("#/reports?perf=sales&q=" + encodeURIComponent("sneaky"));
  ok("[1i] the q token NEVER leaks into the perf sub-view", (perf as { invQuery?: string }).invQuery === undefined);
}
{
  const seedView: AppView = { kind: "module", module: "reports", param: "inventory", invQuery: "Lapis Coaster Set" };
  ok(
    "[1j] viewToHash re-serializes the seed canonically",
    viewToHash(seedView) === "#/reports?inventory=1&q=" + encodeURIComponent("Lapis Coaster Set"),
  );
  const bareView: AppView = { kind: "module", module: "reports", param: "inventory" };
  ok("[1k] a seedless view serializes the bare token", viewToHash(bareView) === "#/reports?inventory=1");
  ok(
    "[1l] sameView — the SAME seed is structurally equal (no re-entry, no replay)",
    sameView(seedView, { kind: "module", module: "reports", param: "inventory", invQuery: "Lapis Coaster Set" }) === true,
  );
  ok(
    "[1m] sameView — a DIFFERENT seed re-enters (Crown then Medal seed different products)",
    sameView(seedView, { kind: "module", module: "reports", param: "inventory", invQuery: "Other Product" }) === false,
  );
  ok(
    "[1n] sameView — seed vs seedless differ (a seeded link is a NEW navigation)",
    sameView(seedView, bareView) === false,
  );
}

// ==== [2] the SEED-CONSUMER LAW ===============================================

console.log("\n[2] SEED-CONSUMER LAW (panel source)");

ok(
  "[2a] the panel reads the ONE store view",
  PANEL.includes("const view = useAppStore((s) => s.view);"),
);
{
  const effect = PANEL.match(/const seededQRef = useRef<string \| null>\(null\);[\s\S]*?\}, \[view\]\);/)?.[0] ?? "";
  ok("[2b] the identity gate exists (seededQRef — one seed per value)", effect.includes("seededQRef.current === seed"));
  ok("[2c] the seed only rides the inventory sub-view", effect.includes('view.param === "inventory"') && effect.includes('view.invQuery ?? ""'));
  ok("[2d] a blank seed never fires", effect.includes("if (!seed || seededQRef.current === seed) return;"));
  ok("[2e] the seed fills the SEARCH BOX (setSearchInput) — never a fetch, never a send", effect.includes("setSearchInput(seed);") && !/api\(|fetch\(|send/i.test(effect));
  ok("[2f] the ref pins BEFORE the state write (no replay loop)", effect.indexOf("seededQRef.current = seed;") < effect.indexOf("setSearchInput(seed);"));
}
ok(
  "[2g] the search input's 80 cap is the parser authority (maxLength={80})",
  PANEL.includes("maxLength={80}"),
);
ok(
  "[2h] the seed rides the SAME debounce (the box's own 300ms law — no second fetch path)",
  /const \[searchInput, setSearchInput\] = useState\(""\);[\s\S]*?setQ\(trimmed === "" \? null : trimmed\);/.test(PANEL),
);

// ==== [3] the CHIP LAW ========================================================

console.log("\n[3] CHIP LAW (copilot source)");

{
  const chips = VIEW.match(/function StockActionChips\(\{[\s\S]*?\n\}\n\n\/\/ ---- Perf action chips/)?.[0] ?? "";
  ok(
    "[3a] BOTH stock chips navigate with the row-level seed (invQuery: fact.name)",
    /param: "inventory",/.test(chips) && chips.includes("invQuery: fact.name"),
  );
  ok(
    "[3b] ONE tooltip source (title = aria-label = the same variable)",
    chips.includes("title={tooltip}") && chips.includes("aria-label={tooltip}"),
  );
  ok(
    "[3c] the honest gates survive (proof + value > 0 — the R102 law untouched)",
    VIEW.includes("meta.topStockProduct && meta.topStockProduct.valueMinor > 0"),
  );
}
ok(
  "[3d] the motion-safety law now rides ALL THREE chip families",
  (VIEW.match(/transition-colors motion-reduce:transition-none/g) ?? []).length >= 3,
);

// ==== [4] the i18n LAW ========================================================

console.log("\n[4] i18n LAW");

{
  const enCrown = EN.match(/actionTopStockTitle: "([^"]+)"/)?.[1] ?? "";
  const enMedal = EN.match(/actionTopStockRunnerUpTitle: "([^"]+)"/)?.[1] ?? "";
  const faCrown = FA.match(/actionTopStockTitle: "([^"]+)"/)?.[1] ?? "";
  const faMedal = FA.match(/actionTopStockRunnerUpTitle: "([^"]+)"/)?.[1] ?? "";
  ok(
    "[4a] BOTH EN tooltips say SEARCH (the drill's honest semantics — a seeded search, not a fake jump)",
    enCrown.includes("Search the detailed valuation") && enMedal.includes("Search the detailed valuation"),
  );
  ok(
    "[4b] BOTH FA tooltips say جستجو (search) in pure Persian",
    faCrown.includes("جستجو") && faMedal.includes("جستجو") &&
      !/[A-Za-z]/.test(faCrown.replace(/\{[^}]+\}/g, "")) &&
      !/[A-Za-z]/.test(faMedal.replace(/\{[^}]+\}/g, "")),
  );
  ok(
    "[4c] the {name}/{money} placeholders survive in all four strings",
    ["{name}", "{money}"].every((p) => enCrown.includes(p) && enMedal.includes(p) && faCrown.includes(p) && faMedal.includes(p)),
  );
}

// ==== [5] the REGRESSION PIN ==================================================

console.log("\n[5] REGRESSION PIN");

{
  const v = hashToView("#/copilot?ask=" + encodeURIComponent("How much is my inventory worth?"));
  ok("[5a] the R144 ask grammar is untouched by the q seed", (v as { ask?: string }).ask === "How much is my inventory worth?");
  const askView: AppView = { kind: "module", module: "copilot", ask: "How much is my inventory worth?" };
  ok("[5b] the ask serialization still canonical", viewToHash(askView) === "#/copilot?ask=" + encodeURIComponent("How much is my inventory worth?"));
}
{
  const outChips = VIEW.match(/function OutstandingActionChips\(\{[\s\S]*?\n\}\n\n\/\/ ---- View/)?.[0] ?? "";
  ok(
    "[5c] the R147 outstanding drill is untouched (aging-details + partyId, no bucket/pastDue)",
    /navigate\(\{ kind: "aging-details", side: chip\.side, partyId: chip\.partyId \}\)/.test(outChips) &&
      !outChips.includes("bucket") && !outChips.includes("pastDue"),
  );
}
ok(
  "[5d] the composer cap authority untouched",
  VIEW.includes("maxLength={500}"),
);
ok(
  "[5e] the ask seed effect untouched (no send verb)",
  (() => {
    const seed = VIEW.match(/const ask =\s*\n?\s*view\.kind === "module" && view\.module === "copilot"[\s\S]*?\}, \[view, activeStreamId, input\]\);/)?.[0] ?? "";
    return seed.includes("setInput(ask)") && !/send|stream\(/i.test(seed);
  })(),
);
ok(
  "[5f] the R147 balances producer untouched (the fourth ?ask= gate)",
  readFileSync("src/modules/balances/balances-view.tsx", "utf8").includes("!error && data?.topLeader ? ("),
);

// ---- summary -----------------------------------------------------------------

console.log(`\nr148-valuation-seed-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
