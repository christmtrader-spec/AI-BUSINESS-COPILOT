/**
 * R104 ZERO-TRUST UNIT — static wiring proofs for the round's two pushes:
 *
 *   S  THE SWEEP ITSELF: the r104-zero-trust-sweep harness pins the
 *      zero-trust law — the STRICT-401 default for /api/v1, the reviewed
 *      exception families (each named by its own design document), the
 *      secret-leak body inspection, the signout no-op honesty assertion,
 *      and the cross-tenant isolation matrix.
 *   W  THE LOW-STOCK ATTENTION LINE: the inventory tile's amber line —
 *      gated on lowStockCount > 0 (honest silence on a healthy book),
 *      deep-linking the Prompt 55 reorder token (#/reports?reorder=1),
 *      the amber tone language, the RTL-mirrored chevron, and both i18n
 *      bags carrying the ICU-plural line + full-sentence tooltip.
 *
 * Run: bun --conditions react-server scripts/r104-zero-trust-unit.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

const sweep = read("scripts/r104-zero-trust-sweep.ts");
const dash = read("src/modules/dashboard/dashboard-view.tsx");
const en = read("src/i18n/messages/en.ts");
const fa = read("src/i18n/messages/fa.ts");

console.log("\n[S] THE SWEEP PINNS THE ZERO-TRUST LAW");

ok(
  "S1 the sweep walks the whole src/app/api tree (no hand-listed routes)",
  /walk\(SRC\)/.test(sweep) && /readdirSync/.test(sweep) && /e === "route\.ts"/.test(sweep),
);
ok(
  "S2 the STRICT-401 default is the fallthrough (no per-route allowlist needed)",
  /return \{ kind: "STRICT-401", allowed: \[401\] \};/.test(sweep),
);
ok(
  "S3 the exception families are each commented with their own design doc",
  /R67: the token IS the authorization/.test(sweep) &&
    /Prompt 23 §18\/§19/.test(sweep) &&
    /Prompt 22: gateway callback/.test(sweep) &&
    /idempotent sign-out companion/.test(sweep) &&
    /Open-or-token endpoints/.test(sweep),
);
ok(
  "S4 the secret-leak inspector scans every 2xx body",
  /SECRET_KEYS/.test(sweep) && /leaky2xx/.test(sweep) && /passwordHash\|password\|token\|secret/.test(sweep),
);
ok(
  "S5 the signout no-op asserts the honest body shape (revoked:false, nothing else claimed)",
  /envelope\.revoked === false/.test(sweep) && /SIGNOUT-DISHONEST/.test(sweep),
);
ok(
  "S6 the cross-tenant matrix proves read+mutate+delete+list+summary isolation",
  /B GET \$\{label\}\/\$\{id\.slice\(-6\)\} is 404\/403/.test(sweep) &&
    /B PATCH A's customer is 404\/403/.test(sweep) &&
    /B DELETE A's customer is 404\/403/.test(sweep) &&
    /excludes A's row/.test(sweep) &&
    /fresh zeros/.test(sweep),
);
ok(
  "S7 the sweep heals the dev server via the liveness entrypoint (never edits state)",
  /ensure-dev\.sh/.test(sweep) && /re-attempt/.test(sweep),
);
ok(
  "S8 cleanup is FK-safe (businesses cascade, users last, both fixtures)",
  /for \(const uid of \[USER_A, USER_B\]\)/.test(sweep) && /business\.delete/.test(sweep),
);

console.log("\n[W] THE LOW-STOCK ATTENTION LINE");

ok(
  "W1 the tile grows the amber attention line (data-testid pinned)",
  /data-testid="attention-inventory-low"/.test(dash),
);
ok(
  "W2 the gate is honest: renders ONLY on lowStockCount > 0 (healthy book = silence)",
  /const low = summary\.inventory\.lowStockCount \?\? 0;/.test(dash) && /if \(low <= 0\) return null;/.test(dash),
);
ok(
  "W3 one click opens the Prompt 55 reorder token (param: \"reorder\")",
  /navigate\(\{ kind: "module", module: "reports", param: "reorder" \}\)/.test(dash),
);
ok(
  "W4 the amber tone language (the aging tiles' attention family) + the AlertTriangle icon",
  /text-amber-700 underline-offset-2 hover:underline focus-visible:ring-ring/.test(dash) &&
    /dark:text-amber-300/.test(dash),
);
ok(
  "W5 the RTL-mirrored chevron rides the R101 law verbatim",
  /rtl:-scale-x-100 rtl:group-hover:-translate-x-0\.5/.test(dash),
);
ok(
  "W6 the count rides fmtCount (UI-locale digits — the R94 law)",
  /statInventoryLowLine", \{ count: fmtCount\(uiLocale, low\) \}/.test(dash) &&
    /statInventoryLowTooltip", \{\s*count: fmtCount\(uiLocale, low\),?\s*\}/.test(dash),
);
ok(
  "W7 the tooltip names ITS OWN fact (the reorder suggestions) in both bags",
  /1 product is at or below its low-stock threshold\. One click opens the reorder suggestions\./.test(en) &&
    /با یک کلیک پیشنهادهای سفارش مجدد باز می‌شود/.test(fa),
);
ok(
  "W8 EN carries the ICU-plural line + the full-sentence tooltip",
  /statInventoryLowLine: "\{count, plural, =1 \{1 product runs low\} other \{# products run low\}\}"/.test(en) &&
    /statInventoryLowTooltip: "\{count, plural, =1 \{1 product is at or below its low-stock threshold\. One click opens the reorder suggestions\.\} other \{# products are at or below their low-stock threshold\. One click opens the reorder suggestions\.\}\}"/.test(en),
);
ok(
  "W9 FA mirrors both keys with the Persian one-literal + RLM-free sentences",
  /statInventoryLowLine: "\{count, plural, =1 \{۱ کالا در آستانه اتمام\} other \{# کالا در آستانه اتمام\}\}"/.test(fa) &&
    /statInventoryLowTooltip: "\{count, plural, =1 \{۱ کالا در حد یا زیر آستانه موجودی کم است\. با یک کلیک پیشنهادهای سفارش مجدد باز می‌شود\.\}/.test(fa),
);
ok(
  "W10 the line sits INSIDE the value-known branch (no attention about a loading tile)",
  new RegExp(
    "statInventoryHint[\\s\\S]*?statInventoryLowLine",
  ).test(dash.slice(dash.indexOf("statInventory"))),
);

console.log(`\n[D] VERDICT — ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
}
if (failed > 0) process.exit(1);
