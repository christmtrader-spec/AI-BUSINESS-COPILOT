/**
 * scripts/r171-duplicate-placement-check.ts — R171 ROUND BATTERY.
 *
 * Covers the round's four workstreams:
 *  [1] THE DEEP-AUDIT v2 PLACEMENT LAW (R170 §3 priority #1) — the v1 deep
 *      focus check searched a 900-char WINDOW after role="…", so a
 *      focus-visible ring on a CHILD <span> satisfied it while the ring was
 *      behaviorally DEAD on the keyboard path (the R170 PO-picker bug
 *      shape). v2 resolves the JSX OPENING TAG (a quote- and brace-aware
 *      walk) and requires focus-visible INSIDE that tag; a child-window
 *      ring is reported as deep-m MISPLACED. LIVE-proven this round: the
 *      very first v2 run caught the REAL pricing-tab dead ring.
 *  [2] THE PRICING TAB FIX — the R169 deep-fix had landed the ring on the
 *      currency-selector wrapper <div> (never focusable) instead of the
 *      role="tab" buttons; the tabs now carry the sibling family's ring +
 *      active pair + motion-reduce escapes, the dead classes are gone.
 *  [3] THE RUNNER --list FLAG (R170 §3 priority #2) — the resolved suite
 *      manifest printed from the SAME arrays the execution path uses
 *      (one source, no drift), run NOTHING, exit 0.
 *  [4] THE PRODUCT DUPLICATE (Mandate 5, the R170 Repeat-expense sibling)
 *      — duplicate-as-new on the products list: the honest-copy law (unit/
 *      prices/low-stock threshold repeat; the name is marked "(copy)" via
 *      i18n, the SKU stays BLANK, stock starts at 0), the dialog source is
 *      `duplicateFrom ?? editing` (the QA-caught bug), edit mode can never
 *      inherit, and the i18n family is EN+FA pure-Persian.
 *  [5] THE TITLE-PARITY SWEEP (Mandate 4) — every size="icon" Button with
 *      an aria-label now carries the SAME label as title (hover
 *      discoverability), except the R140-pinned tour close; the multi-
 *      button actions cells wrap at ≤360px.
 *
 * Run: npx tsx scripts/r171-duplicate-placement-check.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";

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

// ==== [1] THE DEEP-AUDIT v2 PLACEMENT LAW ==================================
console.log("\n== [1] the deep-audit v2 placement law ==");
{
  const py = read("scripts/r156-motion-audit.py");
  ok(
    "1a the tag resolver exists (the v2 core)",
    py.includes("def _tag_bounds("),
  );
  ok(
    "1b the walk is quote-aware (a '>' inside a string never ends the tag)",
    /elif c in ["']\\["'`]["']:\s*\n\s*q = c/.test(py) || (py.includes('q = c') && py.includes('c in')),
  );
  ok(
    "1c the walk is brace-aware (a '>' inside {...} — arrows, nested JSX — never ends the tag)",
    py.includes('depth += 1') && py.includes('depth -= 1') && py.includes('">" and depth == 0'),
  );
  ok(
    "1d the unresolvable-tag fallback keeps the v1 window check (no silent skips)",
    py.includes("fall back to the v1 window check"),
  );
  ok(
    "1e the ring-on-tag verdict: focus-visible INSIDE the opening tag is the only clean pass",
    py.includes("FOCUS_VISIBLE.search(tag_text)"),
  );
  ok(
    "1f the child-window ring is MISPLACED (deep-m), not clean",
    py.includes("misplaced.append") && py.includes("deep-m"),
  );
  ok(
    "1g the ABSENT gap (deep-f) still fires when no ring exists anywhere near",
    py.includes("focus_gaps.append"),
  );
  ok(
    "1h misplaced findings fail the audit (exit 1)",
    /if tgap or fgap or mis:/.test(py),
  );
  ok(
    "1i the v2 docstring records the R170 dead-ring root cause",
    py.includes("THE RING-PLACEMENT LAW") && py.includes("PO supplier picker"),
  );
}

// ==== [2] THE PRICING TAB FIX ==============================================
console.log("\n== [2] the pricing tab fix ==");
{
  const view = read("src/modules/pricing/pricing-view.tsx");
  const tabIdx = view.indexOf('role="tab"');
  ok("2a the tab buttons still carry role=tab", tabIdx > -1);
  const tagStart = view.lastIndexOf("<button", tabIdx);
  // The tag-end walk MIRRORS the v2 _tag_bounds law: a '>' inside quotes or
  // {...} (the onClick arrow!) never ends the opening tag — the naive
  // indexOf('>') truncates before the className and false-fails.
  let tagEnd = -1;
  {
    let depth = 0;
    let q: string | null = null;
    for (let j = tabIdx; j < view.length; j++) {
      const c = view[j]!;
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'" || c === "`") {
        q = c;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
      } else if (c === ">" && depth === 0) {
        tagEnd = j;
        break;
      }
    }
  }
  const tagText = tagEnd > -1 ? view.slice(tagStart, tagEnd + 1) : "";
  ok(
    "2b the ring rides the SAME element as role=tab (v2's own law, on-tag)",
    tagText.includes(
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    ),
  );
  ok(
    "2c the tab joins the radio-card interaction family (active pair + motion-reduce escapes)",
    tagText.includes("active:scale-[0.98]") &&
      tagText.includes("motion-reduce:transition-none") &&
      tagText.includes("motion-reduce:active:scale-100"),
  );
  ok(
    "2d the dead ring is OFF the currency wrapper div (never focusable)",
    !view.includes('gap-2 focus-visible:outline-none'),
  );
}

// ==== [3] THE RUNNER --list FLAG ===========================================
console.log("\n== [3] the runner --list flag ==");
{
  const sh = read("scripts/run-family.sh");
  ok("3a the flag parses (--list)", sh.includes("--list)"));
  ok(
    "3b the manifest prints from the SAME arrays (one source, no drift)",
    /print_manifest\(\)[\s\S]*BATTERIES_TSX\[@\][\s\S]*BATTERIES_BUN\[@\][\s\S]*PROOFS\[@\]/.test(sh),
  );
  ok(
    "3c --list runs NOTHING and exits 0 before the execution banner",
    /if \[ \$LIST_ONLY -eq 1 \]; then\s*\n\s*print_manifest\s*\n\s*exit 0/.test(sh) &&
      sh.indexOf("LIST_ONLY -eq 1") < sh.indexOf('echo "== run-family.sh — the regression family =="\n'),
  );
  ok(
    "3d the manifest honors --skip-proofs and the smoke/types extensions",
    (sh.match(/if \[ \$SKIP_PROOFS -eq 0 \]; then/g) ?? []).length >= 2 &&
      (sh.match(/if \[ \$WITH_SMOKE -eq 1 \]; then/g) ?? []).length >= 2 &&
      (sh.match(/if \[ \$WITH_TYPES -eq 1 \]; then/g) ?? []).length >= 2,
  );
  ok(
    "3e unknown flags still exit 2 (the guard law intact)",
    sh.includes('*) echo "unknown flag: $arg"; exit 2 ;;'),
  );
  ok(
    "3f the usage header documents --list (the honest-CLI law)",
    sh.includes("#   bash scripts/run-family.sh --list"),
  );
}

// ==== [4] THE PRODUCT DUPLICATE ============================================
console.log("\n== [4] the product duplicate ==");
{
  const dlg = read("src/modules/products/product-form-dialog.tsx");
  const view = read("src/modules/products/products-view.tsx");
  const en = read("src/i18n/messages/en.ts");
  const fa = read("src/i18n/messages/fa.ts");

  ok("4a the dialog takes an optional duplicateFrom source", /duplicateFrom\?: Product \| null/.test(dlg));

  const formFrom = dlg.slice(dlg.indexOf("function formFrom"), dlg.indexOf("export function ProductFormDialog"));
  ok(
    "4b the honest-copy transform: name marked, sku BLANK, stock 0",
    formFrom.includes("duplicateName") &&
      /return \{ \.\.\.base, name: duplicateName, sku: "", stockQty: "0" \}/.test(formFrom),
  );
  ok(
    "4c the dialog source is `duplicateFrom ?? editing` (the QA-caught bug: prices MUST prefill)",
    (dlg.match(/formFrom\(duplicateFrom \?\? editing, precision, duplicateName\)/g) ?? []).length === 2,
  );
  ok(
    "4d edit mode can NEVER inherit the copy transform (the R170 guard)",
    dlg.includes("duplicateFrom && !editing"),
  );
  ok(
    "4e the title/desc switch: editing first, duplicate second, plain create last",
    /title=\{editing \? t\("edit"\) : duplicateFrom \? t\("duplicateTitle"\) : t\("add"\)\}/.test(dlg) &&
      /description=\{editing \? t\("formDescription"\) : duplicateFrom \? t\("duplicateDesc"\) : t\("formDescription"\)\}/.test(dlg),
  );
  ok(
    "4f the create path stays a plain POST (no API change)",
    dlg.includes('api("/api/v1/products", { method: "POST", body })'),
  );
  ok(
    "4g the view keeps the three sources mutually exclusive",
    view.includes("setEditing(null);\n    setDuplicateFrom(p);") &&
      (view.match(/setDuplicateFrom\(null\)/g) ?? []).length >= 2,
  );
  ok(
    "4h the row button: testid + aria-label + title, ONE source key",
    view.includes('data-testid="product-duplicate"') &&
      view.includes('aria-label={t("duplicate")}') &&
      view.includes('title={t("duplicate")}'),
  );
  ok("4i the Copy icon rides the row", view.includes("<Copy className=\"size-4\" aria-hidden=\"true\" />"));
  ok(
    "4j EN keys: duplicate / duplicateTitle / duplicateName / duplicateDesc",
    en.includes('duplicate: "Duplicate product"') &&
      en.includes('duplicateName: "{name} (copy)"') &&
      en.includes("the SKU is not copied and the new product starts with 0 stock"),
  );
  ok(
    "4k FA keys: pure-Persian family with the (نسخه) suffix",
    fa.includes('duplicate: "تکثیر کالا"') &&
      fa.includes('duplicateName: "{name} (نسخه)"') &&
      fa.includes("کد کالا رونوشت نمی‌شود"),
  );
  ok(
    "4l the wire law: no new API route was invented",
    existsSync("src/app/api/v1/products/route.ts") && !existsSync("src/app/api/v1/products/duplicate"),
  );
}

// ==== [5] THE TITLE-PARITY SWEEP (Mandate 4) ===============================
console.log("\n== [5] the title-parity sweep ==");
{
  // The structural mini-audit (the R168 blind-spot law): scan EVERY .tsx for
  // size="icon" Buttons carrying aria-label without the matching title.
  // NOTE: static imports only — a dynamic `await import` here would trip the
  // documented TLA law (r138/r141: tsx's CJS transform rejects top-level
  // await; this battery RUNS under npx tsx like the rest of the family).
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
  const exceptions = new Set(["src/modules/shell/onboarding-tour.tsx"]);
  const offenders: string[] = [];
  for (const p of listTsx("src")) {
    if (exceptions.has(p) || p.includes(".test.")) continue;
    const text = read(p);
    const re = /size="icon"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const window = text.slice(m.index, m.index + 700);
      if (window.includes("aria-label") && !window.includes("title=")) {
        offenders.push(`${p}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  ok(
    "5a EVERY size=icon Button with aria-label carries title (tour close exempt)",
    offenders.length === 0,
    offenders.slice(0, 5).join(", "),
  );
  const products = read("src/modules/products/products-view.tsx");
  ok(
    "5b the 4-button actions cells wrap at ≤360px (products)",
    products.includes('className="flex flex-wrap items-center justify-end gap-1"'),
  );
  ok(
    "5c the sibling list cells joined (sales / party / inventory line cells)",
    read("src/modules/sales/sales-view.tsx").includes("flex flex-wrap items-center justify-end gap-1") &&
      read("src/modules/parties/party-view.tsx").includes("flex flex-wrap items-center justify-end gap-1") &&
      read("src/modules/inventory/goods-receipts/goods-receipt-detail-view.tsx").includes(
        "flex flex-wrap items-center justify-end gap-1",
      ),
  );
  ok(
    "5d the sweep includes the header + table-kit chrome (language/theme/user/pagination)",
    read("src/modules/shell/header.tsx").includes('title={tShell("toggleTheme")}') &&
      read("src/components/shared/table-kit.tsx").includes('title={labels?.prev ?? tCommon("previous")}'),
  );
}

// ==== summary ==============================================================
console.log(`\nr171-duplicate-placement-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("ALL GREEN");
