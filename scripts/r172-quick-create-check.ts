/**
 * scripts/r172-quick-create-check.ts — R172 ROUND BATTERY.
 *
 * Covers the round's workstreams:
 *  [1] THE GLOBAL QUICK-CREATE LAW (Mandate 5) — the header "+ New" menu
 *      lifts the dashboard quick-actions mechanism (fireQuickIntent +
 *      navigate, Prompt 52 §F2) out of the home module: the SAME three
 *      action/module pairs, the SAME dialogs via the target views'
 *      useQuickIntent hooks, the SAME data:write gate, and item labels
 *      that REUSE the dashboard namespace keys (one source — no drift).
 *      LIVE-proven this round: dashboard→New expense→dialog open;
 *      expenses→New invoice→sales dialog open; FA/RTL «ایجاد جدید…»;
 *      a real VIEWER member (seeded through the real invite flow) sees
 *      NEITHER the header menu NOR the dashboard toolbar.
 *  [2] THE BOTTOM-NAV FAMILY LAW (Mandate 4) — the R61 mobile nav was the
 *      LIVE instance of the deep audit's documented cn()-sibling composite
 *      blind spot (transition literal + hover state in sibling strings, so
 *      v1/v2 never correlated them): no keyboard focus ring, no reduced-
 *      motion escapes. Now it carries the R167-R171 sibling interaction
 *      family and the motion-reduce pairs on BOTH transition sites.
 *  [3] THE BUTTON BASE MOTION LAW (Mandate 4) — the vendored base Button
 *      ran `transition-all` and `active:scale-[0.99]` with NO reduced-
 *      motion escapes anywhere in the app's most-used primitive; both
 *      pairs now sit in their literals (additive only — the R170 ring-
 *      inheritance pin is untouched).
 *  [4] THE DASHBOARD SIBLING PIN (regression) — the original quick-actions
 *      toolbar keeps its gate/labels/intents; useQuickIntent keeps its
 *      three consumers; the store keeps the intent shape.
 *
 * Run: npx tsx scripts/r172-quick-create-check.ts
 * (static imports only — the documented TLA law)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";

let passed = 0;
let failed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, info = "") => {
  // The R168 lesson: record EVERY failure, with or without info.
  if (cond) passed++;
  else {
    failed++;
    failures.push(info ? `${name} — ${info}` : name);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}`);
};

const read = (p: string) => readFileSync(p, "utf8");
const listTsx = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = `${d}/${e}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) out.push(p);
    }
  };
  walk(dir);
  return out;
};

// ==== [1] THE GLOBAL QUICK-CREATE LAW =======================================

{
  console.log("\n[1] global quick-create menu (Mandate 5)");
  const src = read("src/modules/shell/quick-create-menu.tsx");

  ok(
    "1a the menu gates on data:write exactly like the dashboard toolbar",
    src.includes("can(asRole(") && src.includes('"data:write"') && src.includes("if (!writable) return null"),
  );
  ok(
    "1b exactly the dashboard's action/module pairs (R173 re-pin: 3→4, the fourth joins)",
    [
      'action: "new-sale", module: "sales"',
      'action: "new-payment", module: "payments"',
      'action: "new-expense", module: "expenses"',
      'action: "new-product", module: "products"',
    ].every((s) => src.includes(s)),
    "the quartet must mirror dashboard-view's intents",
  );
  ok(
    "1c no fifth quick action drifted in (RE-PINNED R173: was ===3 no-fourth, the product intent closed the R172 scope law)",
    (src.match(/action: "new-/g) ?? []).length === 4,
    `found ${(src.match(/action: "new-/g) ?? []).length}`,
  );
  ok(
    "1d one click fires the intent AND navigates (the dashboard's own call order)",
    src.includes("fireQuickIntent(item.action);") &&
      /navigate\(\{\s*kind: "module",\s*module: item\.module\s*\}\)/.test(src),
  );
  ok(
    "1e item labels REUSE the dashboard namespace (one source; R173 re-pin: +quickNewProduct)",
    src.includes('useTranslations("dashboard")') &&
      ["quickNewInvoice", "quickRecordPayment", "quickNewExpense", "quickNewProduct"].every((k) =>
        src.includes(k),
      ),
  );
  ok(
    "1f the trigger's aria-label and title come from ONE source (the R171 title-parity law)",
    /aria-label=\{tShell\("quickCreate"\)\}/.test(src) && /title=\{tShell\("quickCreate"\)\}/.test(src),
  );
  ok(
    "1g the trigger and items carry testids",
    src.includes('data-testid="quick-create"') && src.includes("data-testid={`quick-create-${item.action}`}"),
  );
  const header = read("src/modules/shell/header.tsx");
  ok(
    "1h the header renders the menu (import + JSX)",
    header.includes('from "./quick-create-menu"') && header.includes("<QuickCreateMenu />"),
  );
  ok(
    "1i the memberships query shares the switcher's cache key",
    src.includes('queryKey: ["businesses"]') && src.includes('api("/api/v1/businesses", { businessId: null })'),
  );
  ok(
    "1j the role comes from the ACTIVE membership (the store is a hint, the server re-verifies)",
    src.includes("list.find((m) => m.business.id === activeId) ?? list[0]") && src.includes("asRole(active.role)"),
  );

  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");
  ok(
    "1k i18n parity: quickCreate + quickCreateShort in EN and FA",
    ["quickCreate", "quickCreateShort"].every((k) => en.includes(k) && fa.includes(k)),
  );
  ok(
    "1l the FA copy is pure Persian",
    fa.includes('quickCreate: "ایجاد جدید…"') && fa.includes('quickCreateShort: "جدید"'),
  );
  ok(
    "1m the dashboard source keys still exist in both locales (the reuse source; R173 re-pin: +quickNewProduct)",
    ["quickNewInvoice", "quickRecordPayment", "quickNewExpense", "quickNewProduct"].every((k) =>
      en.includes(k) && fa.includes(k),
    ),
  );
}

// ==== [2] THE BOTTOM-NAV FAMILY LAW =========================================

{
  console.log("\n[2] bottom-nav interaction family (Mandate 4)");
  const src = read("src/modules/shell/bottom-nav.tsx");
  const family = [
    "focus-visible:outline-none",
    "focus-visible:ring-2",
    "focus-visible:ring-ring",
    "focus-visible:ring-offset-1",
    "focus-visible:ring-offset-background",
  ];
  ok(
    "2a the nav button carries the full sibling focus family",
    family.every((c) => src.includes(c)),
    family.filter((c) => !src.includes(c)).join(","),
  );
  ok(
    "2b motion-reduce:transition-none on BOTH transition sites",
    (src.match(/transition-colors/g) ?? []).length === 2 && (src.match(/motion-reduce:transition-none/g) ?? []).length === 2,
    `transition-colors=${(src.match(/transition-colors/g) ?? []).length}, escapes=${(src.match(/motion-reduce:transition-none/g) ?? []).length}`,
  );
  ok(
    "2c the icon chip has the press pair (active scale + its escape)",
    src.includes("active:scale-95") && src.includes("motion-reduce:active:scale-100"),
  );
  ok(
    "2d the state-styled hover still sits in the same cn() as the escape (the composite shape, now closed)",
    src.includes("hover:text-foreground") && src.indexOf("motion-reduce:transition-none") < src.indexOf("hover:text-foreground"),
  );
  ok(
    "2e the nav keeps its pure-navigation contract (no new state, no routing)",
    src.includes("navigate(item.view)") && src.includes("setOpenMobile(true)"),
  );
}

// ==== [3] THE BUTTON BASE MOTION LAW ========================================

{
  console.log("\n[3] button base motion-reduce honesty (Mandate 4)");
  const src = read("src/components/ui/button.tsx");
  const baseLine = src.split("\n").find((l) => l.includes("transition-all")) ?? "";
  ok(
    "3a the base literal carries transition-all WITH its reduced-motion escape",
    baseLine.includes("transition-all") && baseLine.includes("motion-reduce:transition-none"),
  );
  const defaultLine = src.split("\n").find((l) => l.includes("active:scale-[0.99]")) ?? "";
  ok(
    "3b the default variant's press scale has its escape in the SAME literal",
    defaultLine.includes("active:scale-[0.99]") && defaultLine.includes("motion-reduce:active:scale-100"),
  );
  ok(
    "3c the R170 ring-inheritance pin is untouched",
    baseLine.includes("focus-visible:ring-ring/50") && baseLine.includes("focus-visible:ring-[3px]"),
  );
  ok(
    "3d no variant grew a NEW bare transition (every transition-all/transition-* in the file is escaped or pre-existing)",
    (src.match(/transition-(?!none)[a-z-]*(?![^"\n]*motion-reduce)/g) ?? []).every((t) => t === "transition-all"),
    "scan: " + JSON.stringify(src.match(/transition-[a-z-]+/g)),
  );
}

// ==== [4] THE DASHBOARD SIBLING PIN (regression) ============================

{
  console.log("\n[4] dashboard sibling + intent plumbing pins");
  const dash = read("src/modules/dashboard/dashboard-view.tsx");
  ok(
    "4a the toolbar keeps its gate, role and tour anchor",
    dash.includes('can(role, "data:write")') &&
      dash.includes('role="toolbar"') &&
      dash.includes('aria-label={t("quickActions")}') &&
      dash.includes('data-tour="quick-actions"'),
  );
  ok(
    "4b the dashboard fires the four intents (R173 re-pin: 3→4, the product tile joined)",
    [
      'fireQuickIntent("new-sale")',
      'fireQuickIntent("new-payment")',
      'fireQuickIntent("new-expense")',
      'fireQuickIntent("new-product")',
    ].every((s) => dash.includes(s)),
  );
  const consumers = listTsx("src/modules").filter((p) => read(p).includes("use-quick-intent"));
  ok(
    "4c useQuickIntent keeps exactly its four module consumers (RE-PINNED R173: was 3, products-view grew the hook)",
    consumers.length === 4 && consumers.every((p) => /sales|payments|expenses|products/.test(p)),
    JSON.stringify(consumers),
  );
  const store = read("src/store/app-store.ts");
  ok(
    "4d the store keeps the intent shape and both functions (R173 re-pin: the union grew the fourth member)",
    store.includes('"new-sale" | "new-expense" | "new-payment" | "new-product"') &&
      store.includes("fireQuickIntent: (action)") &&
      store.includes("consumeQuickIntent: () =>"),
  );
  ok(
    "4e the menu file joins the family census (22 module views)",
    listTsx("src/modules").length >= 22,
    `census ${listTsx("src/modules").length}`,
  );
}

console.log(`\n=== r172-quick-create-check: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
