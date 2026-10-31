/**
 * r173-quick-product-check.ts — the FOURTH quick-create intent.
 *
 * R173 Mandate 5: "new-product" joins the quick-create family, closing the
 * R172 scope law ("a fourth joins only when its view grows a useQuickIntent
 * hook"). Products-view now consumes the intent and opens its REAL create
 * dialog. The dashboard toolbar grew the SAME fourth tile, so the R172
 * one-law-two-surfaces shape holds: menu items == dashboard tiles == 4.
 *
 * Sections:
 *  [1] the fourth-intent law (store/hook unions, menu quartet, products
 *      consumer, dashboard tile, i18n EN+FA, tour copy honesty)
 *  [2] the one-law-two-surfaces equivalence (menu item set == tile set)
 *  [3] the group-separator law (data-driven startsGroup, one separator)
 *  [4] the re-pin law (r172 battery's honest RE-PINNED markers)
 *  [5] the 360px law (header icons + min-w-0 truncation survive the 4th
 *      surface — the R172 §3 risk #4 follow-up) + family census.
 *
 * Run: npx tsx scripts/r173-quick-product-check.ts  (static imports only —
 * the TLA/esbuild law).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const passed: string[] = [];
const failures: string[] = [];
let n = 0;
function ok(name: string, cond: boolean, info?: string) {
  n++;
  if (cond) passed.push(name);
  else failures.push(info ? `${name} — ${info}` : name);
}
function listTsx(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(ROOT, d))) {
      const rel = `${d}/${e}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (e.endsWith(".tsx")) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

// ==== [1] THE FOURTH-INTENT LAW =============================================

{
  console.log("\n[1] the fourth quick-create intent (Mandate 5)");

  const store = read("src/store/app-store.ts");
  ok(
    "1a the store's intent union grew the fourth member (state + fire signature)",
    store.includes('"new-sale" | "new-expense" | "new-payment" | "new-product"'),
  );

  const hook = read("src/hooks/use-quick-intent.ts");
  ok(
    "1b the useQuickIntent action union grew the fourth member",
    hook.includes('"new-sale" | "new-expense" | "new-payment" | "new-product"'),
  );

  const menu = read("src/modules/shell/quick-create-menu.tsx");
  ok(
    "1c the menu carries all FOUR action/module pairs",
    [
      'action: "new-sale", module: "sales"',
      'action: "new-payment", module: "payments"',
      'action: "new-expense", module: "expenses"',
      'action: "new-product", module: "products"',
    ].every((s) => menu.includes(s)),
  );
  ok(
    "1d the menu's type unions cover the fourth member",
    menu.includes('| "new-product"') &&
      menu.includes('"sales" | "payments" | "expenses" | "products"') &&
      menu.includes('"quickNewProduct"'),
  );

  const products = read("src/modules/products/products-view.tsx");
  ok(
    "1e products-view consumes the intent with openCreate (create-mode reset)",
    products.includes('useQuickIntent("new-product", openCreate)') &&
      /function openCreate\(\) \{[\s\S]{0,120}setEditing\(null\);[\s\S]{0,120}setDuplicateFrom\(null\);[\s\S]{0,120}setDialogOpen\(true\);/.test(
        products,
      ),
    "openCreate must reset edit/duplicate so the dialog opens in create mode",
  );
  ok(
    "1f the consumer imports the hook (static import — the TLA law)",
    products.includes('import { useQuickIntent } from "@/hooks/use-quick-intent";'),
  );

  const dash = read("src/modules/dashboard/dashboard-view.tsx");
  ok(
    "1g the dashboard fires the fourth intent and navigates to products",
    dash.includes('fireQuickIntent("new-product");') &&
      /fireQuickIntent\("new-product"\);[\s\S]{0,80}navigate\(\{\s*kind: "module",\s*module: "products"\s*\}\)/.test(
        dash,
      ),
  );
  ok(
    "1h the fourth tile follows the sibling tile shape (outline + sky family + Package icon + Plus affordance)",
    /variant="outline"[\s\S]{0,200}border-sky-600\/30 hover:bg-sky-600\/5[\s\S]{0,200}fireQuickIntent\("new-product"\)[\s\S]{0,300}Package className="size-4"[\s\S]{0,200}t\("quickNewProduct"\)/.test(
      dash,
    ),
  );
  ok(
    "1i the toolbar grid grew the fourth column honestly (1 / 2 / 4 across)",
    dash.includes('className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"'),
  );

  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");
  ok(
    "1j i18n parity: quickNewProduct exists in BOTH locales",
    en.includes('quickNewProduct: "New product"') && fa.includes('quickNewProduct: "محصول جدید"'),
  );
  ok(
    "1k the FA copy is pure Persian (no latin fallback)",
    /quickNewProduct: "[\u0600-\u06FF]/.test(fa),
  );
  ok(
    "1l the onboarding tour copy covers all four actions (the honesty law)",
    en.includes(
      "Create an invoice, record a payment, add an expense or a new product — right from the dashboard.",
    ) && fa.includes("هزینه یا محصول جدید اضافه کنید"),
  );
}

// ==== [2] ONE LAW, TWO SURFACES =============================================

{
  console.log("\n[2] the menu item set == the dashboard tile set");
  const menu = read("src/modules/shell/quick-create-menu.tsx");
  const dash = read("src/modules/dashboard/dashboard-view.tsx");

  const menuActions = [...menu.matchAll(/action: "(new-[a-z]+)"/g)].map((m) => m[1]).sort();
  const dashActions = [...dash.matchAll(/fireQuickIntent\("(new-[a-z]+)"\)/g)]
    .map((m) => m[1])
    .sort();
  ok(
    "2a the surfaces fire the SAME action set (R172's one-law shape, now four)",
    menuActions.length === 4 &&
      dashActions.length === 4 &&
      JSON.stringify(menuActions) === JSON.stringify(dashActions),
    `menu=${JSON.stringify(menuActions)} dash=${JSON.stringify(dashActions)}`,
  );

  ok(
    "2b exactly four quick-create testids render (no drift, no duplicates)",
    (menu.match(/data-testid=\{`quick-create-\$\{item\.action\}`\}/g) ?? []).length === 1,
  );

  const header = read("src/modules/shell/header.tsx");
  ok(
    "2c the header still renders the menu unchanged (import + JSX)",
    header.includes('from "./quick-create-menu"') && header.includes("<QuickCreateMenu />"),
  );
}

// ==== [3] THE GROUP-SEPARATOR LAW (Mandate 4a) ==============================

{
  console.log("\n[3] the menu's data-driven group separator");
  const menu = read("src/modules/shell/quick-create-menu.tsx");

  ok(
    "3a startsGroup is DATA-driven (a field on the item, not an index hack)",
    menu.includes("startsGroup?: boolean;") && /startsGroup: true[, }]/.test(menu),
  );
  ok(
    "3b exactly ONE item starts a group (the inventory entry)",
    (menu.match(/startsGroup: true/g) ?? []).length === 1,
  );
  ok(
    "3c the separator renders conditionally INSIDE the group wrapper",
    menu.includes("item.startsGroup ? <DropdownMenuSeparator aria-hidden=\"true\" /> : null"),
  );
  ok(
    "3d each item sits in a keyed group wrapper (Radix roving focus survives)",
    /<div key=\{item\.action\} data-testid=\{`quick-create-group-\$\{item\.action\}`\}>/.test(menu),
  );
  ok(
    "3e the separator import joined the vendored dropdown barrel",
    menu.includes("  DropdownMenuSeparator,\n"),
  );
}

// ==== [4] THE RE-PIN LAW ====================================================

{
  console.log("\n[4] the r172 battery's honest re-pins");
  const r172 = read("scripts/r172-quick-create-check.ts");

  ok(
    "4a the no-fourth pin was re-pinned to the quartet with an honest marker",
    r172.includes("RE-PINNED R173") && /action: "new-\/g\)?\)?\.length === 4|\.length === 4/.test(r172),
  );
  ok(
    "4b the consumers pin grew to exactly four with an honest marker",
    r172.includes("exactly its four module consumers") && r172.includes("consumers.length === 4"),
  );
  ok(
    "4c the dashboard-intents pin lists all four fires",
    ['fireQuickIntent("new-sale")', 'fireQuickIntent("new-payment")', 'fireQuickIntent("new-expense")', 'fireQuickIntent("new-product")'].every(
      (s) => r172.includes(s),
    ),
  );
  ok(
    "4d the i18n reuse pin covers quickNewProduct in both locales",
    r172.includes("quickNewProduct") && r172.includes('en.includes(k) && fa.includes(k)'),
  );
}

// ==== [5] THE 360PX LAW + FAMILY CENSUS ====================================

{
  console.log("\n[5] the 360px header law + family census");
  const header = read("src/modules/shell/header.tsx");

  ok(
    "5a the +New trigger keeps the shrink-0 guard (the R171 flex law)",
    header.includes("shrink-0"),
  );
  ok(
    "5b the business switcher (exported from header.tsx) keeps its min-w-0 truncation (the header's shock absorber)",
    /export function BusinessSwitcher/.test(header) &&
      /min-w-0 max-w-\[150px\] flex-1/.test(header),
  );

  const consumers = listTsx("src/modules").filter((p) => read(p).includes("use-quick-intent"));
  ok(
    "5c exactly four module consumers consume quick intents",
    consumers.length === 4 && consumers.some((p) => p.includes("products")),
    JSON.stringify(consumers),
  );
  ok(
    "5d the family census holds (no orphan view files)",
    listTsx("src/modules").length >= 22,
    `census ${listTsx("src/modules").length}`,
  );
}

console.log(`\n=== r173-quick-product-check: ${passed.length} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
