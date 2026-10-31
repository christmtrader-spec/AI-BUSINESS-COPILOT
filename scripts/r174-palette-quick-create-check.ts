/**
 * r174-palette-quick-create-check.ts — the quick-create family's THIRD
 * surface + the census module that ends the re-pin ritual.
 *
 * R174 Mandate 5: the ⌘K command palette's own subtitle promised "run a
 * quick action" but the palette had none (found LIVE in this round's QA).
 * A QUICK CREATE group joins: the SAME four intents rendered from the
 * menu's newly exported QUICK_CREATE_ITEMS (ONE source), the SAME
 * data:write gate, firing the SAME cross-view intent (§1 intact — the
 * palette still never executes mutations; the module's REAL dialog opens).
 *
 * R174 tooling (R173 §3 priority #1): scripts/family-census.ts — the
 * family's suite counts are READ from the runner's arrays at battery-run
 * time; r170 3e imports it; each new battery pins its OWN registration
 * (the join-day canary moved to the file that can actually forget).
 *
 * Sections:
 *  [1] the palette quick-create law (import/gate/order/testids/labels/
 *      tones/i18n/§1 honesty)
 *  [2] the one-source law (menu exports, palette consumes, three-surface
 *      equality with the dashboard's tiles)
 *  [3] the tone law (one hue map, dark variants, two consumers, tiles
 *      keep their pinned hues)
 *  [4] the family-census module law (exports, first consumer, live
 *      counts, the self-registration canary)
 *
 * Run: npx tsx scripts/r174-palette-quick-create-check.ts
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

// ==== [1] THE PALETTE QUICK-CREATE LAW ======================================

{
  console.log("\n[1] the palette's quick-create group (Mandate 5)");
  const pal = read("src/modules/shell/command-palette.tsx");

  ok(
    "1a the palette renders from the menu's exported array (ONE source, no copy)",
    pal.includes('from "./quick-create-menu"') &&
      pal.includes("QUICK_CREATE_ITEMS.map((item)"),
  );
  ok(
    "1b the group carries the SAME data:write gate (role from the palette's membership prop) and is NOT nav-mode-gated (typed access — cmdk client-filters the values)",
    /can\(role, "data:write"\) \?/.test(pal) &&
      !/can\(role, "data:write"\) && !searchActive/.test(pal),
  );
  ok(
    "1c the command closes the palette, fires the intent, then navigates (the header menu's call order)",
    /setOpen\(false\);[\s\S]{0,60}fireQuickIntent\(action\);[\s\S]{0,60}navigate\(\{\s*kind: "module",\s*module \}\)/.test(
      pal,
    ),
  );
  ok(
    "1d the items carry palette-quick-create-<action> testids",
    pal.includes("data-testid={`palette-quick-create-${item.action}`}"),
  );
  ok(
    "1e the labels reuse the dashboard namespace (the family's one label source)",
    pal.includes('useTranslations("dashboard")') && pal.includes("tDashboard(item.labelKey)"),
  );
  ok(
    "1f the §1 honesty holds: the palette never executes mutations — the comment records the intent nuance",
    pal.includes("never executes mutations") &&
      pal.includes("Prompt 52 §F2") &&
      pal.includes("the record is still authored by"),
  );

  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");
  ok(
    "1g i18n parity: palette.groups.quickCreate in EN and FA",
    en.includes('quickCreate: "Quick create"') && fa.includes('quickCreate: "ایجاد سریع"'),
  );
  ok(
    "1h the FA copy is pure Persian",
    /groups: \{[\s\S]{0,200}quickCreate: "[\u0600-\u06FF]/.test(fa),
  );
  ok(
    "1i the subtitle's promise now has a group to honor it",
    en.includes('"Jump to a module or run a quick action"') &&
      fa.includes("پرش به ماژول یا اجرای کنش سریع"),
  );
}

// ==== [2] THE ONE-SOURCE LAW ================================================

{
  console.log("\n[2] one source, three surfaces");
  const menu = read("src/modules/shell/quick-create-menu.tsx");
  const pal = read("src/modules/shell/command-palette.tsx");
  const dash = read("src/modules/dashboard/dashboard-view.tsx");

  ok(
    "2a the menu file exports the shared array with all four pairs",
    menu.includes("export const QUICK_CREATE_ITEMS") &&
      ['action: "new-sale"', 'action: "new-payment"', 'action: "new-expense"', 'action: "new-product"'].every(
        (s) => menu.includes(s),
      ),
  );
  ok(
    "2b the palette defines NO second items array (zero action literals)",
    (pal.match(/action: "new-/g) ?? []).length === 0,
    `found ${(pal.match(/action: "new-/g) ?? []).length}`,
  );
  ok(
    "2c the menu renders the shared array (no local copy left)",
    menu.includes("QUICK_CREATE_ITEMS.map((item)") && !/const ITEMS\b/.test(menu),
  );

  const sharedActions = [...menu.matchAll(/action: "(new-[a-z]+)"/g)].map((m) => m[1]).sort();
  const dashActions = [...dash.matchAll(/fireQuickIntent\("(new-[a-z]+)"\)/g)]
    .map((m) => m[1])
    .sort();
  ok(
    "2d the shared array's action set == the dashboard tiles' set (three-surface equality via the shared source)",
    sharedActions.length === 4 &&
      dashActions.length === 4 &&
      JSON.stringify(sharedActions) === JSON.stringify(dashActions),
    `shared=${JSON.stringify(sharedActions)} dash=${JSON.stringify(dashActions)}`,
  );
}

// ==== [3] THE TONE LAW (Mandate 4) ==========================================

{
  console.log("\n[3] the family's one hue map");
  const menu = read("src/modules/shell/quick-create-menu.tsx");
  const pal = read("src/modules/shell/command-palette.tsx");
  const dash = read("src/modules/dashboard/dashboard-view.tsx");

  ok(
    "3a the tone map covers exactly the four family hues",
    (menu.match(/export const QUICK_CREATE_TONES/) ?? []).length === 1 &&
      ["invoice", "payment", "expense", "product"].every((t) =>
        menu.includes(`${t}: "text-`),
      ),
  );
  ok(
    "3b every tone carries a dark: variant (the tiles' contrast law)",
    (menu.match(/dark:text-/g) ?? []).length >= 4,
  );
  ok(
    "3c BOTH the menu and the palette consume the one map",
    menu.includes("QUICK_CREATE_TONES[item.tone]") && pal.includes("QUICK_CREATE_TONES[item.tone]"),
  );
  ok(
    "3d the dashboard tiles keep their own pinned hues (the R173 1h pins untouched)",
    dash.includes("border-rose-600/30 hover:bg-rose-600/5") &&
      dash.includes("border-sky-600/30 hover:bg-sky-600/5") &&
      dash.includes("bg-gradient-to-r from-emerald-600 to-teal-600"),
  );
}

// ==== [4] THE FAMILY-CENSUS MODULE LAW ======================================

{
  console.log("\n[4] the shared family census (the re-pin ritual ENDS)");
  const censusSrc = read("scripts/family-census.ts");

  ok(
    "4a the module exports the parser and the self-registration canary",
    censusSrc.includes("export function familyCensus") &&
      censusSrc.includes("export function assertRegistered"),
  );
  ok(
    "4b the module parses the runner's OWN arrays (counts are the runner, never a copy)",
    censusSrc.includes('shPath = "scripts/run-family.sh"') &&
      censusSrc.includes("BATTERIES_TSX") &&
      censusSrc.includes("BATTERIES_BUN") &&
      censusSrc.includes("PROOFS"),
  );

  const r170 = read("scripts/r170-repeat-family-check.ts");
  ok(
    "4c r170 3e imports the module and no longer hard-codes the exact family size",
    r170.includes('from "./family-census"') &&
      r170.includes("familyCensus()") &&
      !r170.includes('grab("BATTERIES_TSX") === 23'),
  );

  const c = familyCensus();
  ok(
    "4d the live counts match the runner right now (tsx floor 23, bun 2, proofs 5, names sum)",
    c.tsx >= 23 && c.bun === 2 && c.proofs === 5 && c.names.length === c.tsx + c.bun + c.proofs,
    `tsx=${c.tsx} bun=${c.bun} proofs=${c.proofs}`,
  );

  ok(
    "4e the self-registration canary: THIS battery is registered in the runner",
    assertRegistered("r174-palette-quick-create-check.ts"),
    "add r174-palette-quick-create-check.ts to run-family.sh BATTERIES_TSX",
  );

  // The resolved manifest (the runner's --list, the R171 law) must list this
  // battery END-TO-END — the same arrays the execution path iterates.
  try {
    const list = execSync("bash scripts/run-family.sh --list", {
      cwd: ROOT,
      encoding: "utf8",
    });
    ok(
      "4f the resolved --list manifest lists this battery (end-to-end registration proof)",
      list.includes("r174-palette-quick-create-check.ts"),
    );
  } catch (e) {
    ok("4f the resolved --list manifest lists this battery", false, String(e).slice(0, 80));
  }
}

console.log(`\n=== r174-palette-quick-create-check: ${passed.length} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
