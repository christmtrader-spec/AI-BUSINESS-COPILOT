/**
 * scripts/r170-repeat-family-check.ts — R170 ROUND BATTERY.
 *
 * Covers the round's three workstreams:
 *  [1] THE PICKER RING FIX — the R169 deep-fix misplacement bug: the PO
 *      supplier picker's focus-visible ring had landed on the INNER <span>
 *      (unfocusable → the ring could NEVER render); it now lives on the
 *      <button role="option"> itself, matching the six sibling pickers'
 *      byte-pattern. LIVE-verified: Tab focus → computed boxShadow ring +
 *      emerald pixel (24,163,73) at the row edge.
 *  [2] THE REPEAT EXPENSE FEATURE — duplicate-as-new on the expenses list
 *      AND the expense detail page: a create-mode dialog prefilled from a
 *      past expense (category/amount/note/supplier), with the ORIGINAL
 *      bill's due date + reference deliberately NOT copied and the fresh
 *      expense landing UNPAID for today. The i18n family (EN+FA) and the
 *      wire source (toRow.supplierId) pinned.
 *  [3] THE FAMILY RUNNER — scripts/run-family.sh: ONE command for the
 *      regression family (the R169 §3 priority #3): 19 tsx batteries +
 *      2 TLA-pinned bun batteries + 5 react-server proofs + 3 audits,
 *      with --with-smoke/--with-types/--all extensions and an attributable
 *      summary table.
 *  [4] THE STYLING DETAILS — the actions cell joins the hover-discoverability
 *      parity (title on all four icon buttons) + the ≤360px wrap law.
 *
 * Run: npx tsx scripts/r170-repeat-family-check.ts
 */

import { readFileSync, statSync } from "node:fs";

let passed = 0;
let failed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, info = "") => {
  if (cond) passed++;
  else {
    failed++;
    failures.push(info ? `${name} — ${info}` : name);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}`);
};

const read = (p: string) => readFileSync(p, "utf8");

// ==== [1] THE PICKER RING FIX ==============================================
console.log("\n== [1] the PO supplier picker ring fix ==");
{
  const picker = read("src/modules/purchase-orders/purchase-order-supplier-picker.tsx");
  const buttonBlock = picker.slice(picker.indexOf('<button\n              key={s.id}'), picker.indexOf('</button>'));
  ok(
    "1a the ring byte-pattern rides the <button role=option> itself",
    buttonBlock.includes('role="option"') &&
      buttonBlock.includes(
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      ),
  );
  ok(
    "1b the inner <span> no longer carries the (never-focusable) ring classes",
    !/<span className="min-w-0 focus-visible:/.test(picker),
  );
  ok("1c the span keeps its truncation base class", picker.includes('<span className="min-w-0">'));
  // The six sibling line pickers already carry the ring on their buttons —
  // the family stays whole (the R169 byte-pattern, re-asserted).
  const siblings = [
    "src/modules/supplier-bills/supplier-bill-line-picker.tsx",
    "src/modules/sales-orders/sales-order-product-picker.tsx",
    "src/modules/sales-quotations/sales-quotation-product-picker.tsx",
    "src/modules/inventory/goods-receipts/goods-receipt-line-picker.tsx",
    "src/modules/inventory/goods-dispatches/goods-dispatch-line-picker.tsx",
    "src/modules/inventory/goods-returns/goods-return-line-picker.tsx",
  ];
  ok(
    "1d all six sibling pickers keep the ring on their option buttons",
    siblings.every((f) => {
      const src = read(f);
      const i = src.indexOf('role="option"');
      return i > -1 && src.slice(i, i + 600).includes("focus-visible:ring-2");
    }),
  );
}

// ==== [2] THE REPEAT EXPENSE FEATURE =======================================
console.log("\n== [2] the repeat-expense feature ==");
{
  const dlg = read("src/modules/expenses/expense-form-dialog.tsx");
  ok(
    "2a the duplicate source type: the four repeating details + name-only supplier",
    dlg.includes("export type ExpenseDuplicateSource =") &&
      /category: string;[\s\S]*amountMinor: number;[\s\S]*note: string \| null;[\s\S]*supplierId: string \| null;[\s\S]*supplierName: string \| null;/.test(
        dlg.slice(dlg.indexOf("export type ExpenseDuplicateSource ="), dlg.indexOf("function formFrom(")),
      ),
  );
  const dupBranch = dlg.slice(dlg.indexOf("if (dup) {"), dlg.indexOf("return { supplierId: presetSupplierId ?? \"\", category: \"\""));
  ok(
    "2b the dup prefill branch: supplier carried, BLANK due date + reference",
    dupBranch.includes("supplierId: presetSupplierId ?? \"\"") &&
      dupBranch.includes("category: dup.category") &&
      dupBranch.includes("amount: String(fromMinor(dup.amountMinor, precision))") &&
      dupBranch.includes("dueDate: \"\"") &&
      dupBranch.includes("reference: \"\"") &&
      dupBranch.includes("note: dup.note ?? \"\""),
  );
  ok(
    "2c the honest-copy law is DOCUMENTED at the type",
    /the ORIGINAL bill's due date and reference are deliberately NOT copied/.test(dlg),
  );
  ok(
    "2d the title/description switch: duplicateTitle/duplicateDesc ONLY in create mode",
    dlg.includes('duplicateFrom ? t("duplicateTitle") : t("addExpense")') &&
      dlg.includes("duplicateFrom && !editing ? t(\"duplicateDesc\") : t(\"formDescription\")"),
  );
  ok(
    "2e repeat is a CREATE: the mutation keys on editing alone (POST for dup)",
    dlg.includes("editing\n        ? api(`/api/v1/expenses/${editing.id}`, { method: \"PATCH\", body })") &&
      dlg.includes('api("/api/v1/expenses", { method: "POST", body })'),
  );
  ok(
    "2f the preset merge covers the dup supplier (one list, both entry points)",
    dlg.includes("const preset = presetSupplier ?? dupPreset;") &&
      /supplierOptions[\s\S]*?some\(\(s\) => s\.id === preset\.id\)/.test(dlg),
  );

  const view = read("src/modules/expenses/expenses-view.tsx");
  ok(
    "2g the list wiring: dupSource state + mutual exclusion with editing",
    view.includes("const [dupSource, setDupSource] = useState<ExpenseDuplicateSource | null>(null);") &&
      view.includes("setEditing(null);\n    setDupSource(null);") &&
      view.includes("setEditing(e);\n    setDupSource(null);"),
  );
  ok(
    "2h openDuplicate carries the source row's supplier identity",
    /openDuplicate\(e: ExpenseRow\) [\s\S]*?supplierId: e\.supplierId,[\s\S]*?supplierName: e\.supplierName,/.test(view),
  );
  ok(
    "2i the row action: Copy icon, testid, bilingual label as BOTH aria-label and title",
    view.includes('data-testid="expense-duplicate"') &&
      view.includes('aria-label={t("duplicate")}') &&
      view.includes('title={t("duplicate")}'),
  );
  ok("2j the list row type carries supplierId (the wire's own field)", /type ExpenseRow = \{[\s\S]*?supplierId: string \| null;/.test(view));
  ok("2k the dialog receives duplicateFrom={dupSource}", view.includes("duplicateFrom={dupSource}"));

  const detail = read("src/modules/entities/expense-detail-view.tsx");
  ok(
    "2l the detail page: a SECOND dialog instance in create mode (dupOpen)",
    detail.includes("const [dupOpen, setDupOpen] = useState(false);") &&
      /open=\{dupOpen\}[\s\S]*?editing=\{null\}[\s\S]*?duplicateFrom=\{\{/.test(detail),
  );
  ok(
    "2m the detail repeat source comes from the loaded expense (supplierName incl.)",
    detail.includes("category: e.category,") && detail.includes("supplierName: e.supplierName,"),
  );
  ok('2n the detail trigger carries its testid', detail.includes('data-testid="expense-detail-repeat"'));

  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");
  ok(
    "2o i18n EN: duplicate / duplicateTitle / duplicateDesc present",
    en.includes('duplicate: "Repeat",') &&
      en.includes('duplicateTitle: "Repeat expense",') &&
      en.includes("the original due date and bill reference are not copied."),
  );
  ok(
    "2p i18n FA: the symmetric pure-Persian family",
    fa.includes('duplicate: "تکرار",') &&
      fa.includes('duplicateTitle: "تکرار هزینه",') &&
      fa.includes("سررسید و شماره سندِ قبلی کپی نمی‌شوند."),
  );

  const api = read("src/app/api/v1/expenses/route.ts");
  ok(
    "2q the wire source: toRow exposes supplierId (the feature's data line)",
    /function toRow\(e: ExpenseRowInput\) \{[\s\S]*?supplierId: e\.supplierId,/.test(api),
  );
}

// ==== [3] THE FAMILY RUNNER ================================================
console.log("\n== [3] scripts/run-family.sh ==");
{
  let sh = "";
  let mode = 0;
  try {
    sh = read("scripts/run-family.sh");
    mode = statSync("scripts/run-family.sh").mode & 0o777;
  } catch {
    ok("3a the runner exists", false, "scripts/run-family.sh missing");
  }
  if (sh) {
    ok("3a the runner exists and is executable", (mode & 0o111) !== 0, `mode ${mode.toString(8)}`);
    ok(
      "3b the three runner groups: tsx batteries, TLA-pinned bun batteries, react-server proofs",
      sh.includes("BATTERIES_TSX=(") && sh.includes("BATTERIES_BUN=(") && sh.includes("PROOFS=("),
    );
    ok(
      "3c the TLA law: r138/r141 pinned to bun (the R168 convention)",
      /BATTERIES_BUN=\([\s\S]*?r138-copilot-time-check\.ts[\s\S]*?r141-search-highlight-check\.ts[\s\S]*?\)/.test(sh),
    );
    ok(
      "3d the R169 runner law: proofs run under bun --conditions react-server",
      sh.includes('run_suite "$p" bun --conditions react-server "scripts/$p"'),
    );
    ok(
      "3e the family census: 23 tsx + 2 bun + 5 proofs = 30 suite entries (RE-PINNED R173: was 22, the quick-product battery joined)",
      (() => {
        const grab = (name: string) => {
          const m = sh.match(new RegExp(`${name}=\\([\\s\\S]*?\\)`));
          return m ? (m[0].match(/\br\d+-[a-z-]+\.ts\b/g) ?? []).length : -1;
        };
        return grab("BATTERIES_TSX") === 23 && grab("BATTERIES_BUN") === 2 && grab("PROOFS") === 5;
      })(),
    );
    ok(
      "3f real-HTTP suites bootstrap the server first (the ensure-dev law)",
      /SKIP_PROOFS -eq 0 \] \|\| \[ \$WITH_SMOKE -eq 1/.test(sh) && sh.includes("bash scripts/ensure-dev.sh"),
    );
    ok(
      "3g the flags: --skip-proofs / --with-smoke / --with-types / --all",
      sh.includes("--skip-proofs") && sh.includes("--with-smoke") && sh.includes("--with-types") &&
        sh.includes("--all)"),
    );
    ok(
      "3h the attributable summary: per-suite PASS/FAIL + failure tails + exit law",
      sh.includes("SUITE_RESULTS") && sh.includes("tail -12") &&
        sh.includes("FAMILY GREEN ✓") && sh.includes("exit 1"),
    );
    ok(
      "3i the audits ride the family: i18n + motion v1 + motion --deep",
      sh.includes("bun scripts/i18n-audit.ts") &&
        sh.includes("python3 scripts/r156-motion-audit.py") &&
        sh.includes("python3 scripts/r156-motion-audit.py --deep"),
    );
  }
}

// ==== [4] THE STYLING DETAILS ==============================================
console.log("\n== [4] the actions-cell styling details ==");
{
  const view = read("src/modules/expenses/expenses-view.tsx");
  ok(
    "4a the ≤360px wrap law: flex-wrap on the actions cell",
    view.includes("flex flex-wrap items-center justify-end gap-1"),
  );
  ok(
    "4b hover-discoverability parity: all four icon buttons carry title",
    view.includes('title={t("pay")}') &&
      view.includes('title={tCommon("edit")}') &&
      view.includes('title={t("duplicate")}') &&
      view.includes('title={tCommon("delete")}'),
  );
  // The family focus law: the ghost buttons inherit the shadcn base ring.
  const btn = read("src/components/ui/button.tsx");
  ok(
    "4c the Button base keeps its focus-visible ring (the family inheritance)",
    btn.includes("focus-visible:ring-[3px]"),
  );
  const detail = read("src/modules/entities/expense-detail-view.tsx");
  ok(
    "4d the detail Repeat button joins the outline action family",
    /data-testid="expense-detail-repeat"[\s\S]*?<Copy className="size-4"[\s\S]*?\{tExpenses\("duplicate"\)\}/.test(detail),
  );
}

// ==== verdict ==============================================================
console.log(`\n== r170-repeat-family-check: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
