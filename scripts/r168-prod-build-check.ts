/**
 * scripts/r168-prod-build-check.ts — R168 harness.
 *
 * THE PROD BUILD DANCE BECOMES A SCRIPT: the R156 hard-won laws (split
 * build to fit the tool-call window, OOM preflight, standalone assembly,
 * NEXTAUTH_SECRET, the ordering + same-call laws) are encoded in
 * scripts/build-prod.sh so any round can re-prove prod:3100 without
 * re-deriving the dance from the worklog. The selectable-card radio
 * pickers (the settings restore ID-mode cards, the billing plan cards —
 * the app's TWO role="radio" surfaces) join the interaction-state
 * unification (focus-visible ring + active scale + motion-safety — the
 * R167 chip-family byte-pattern), closing the motion-audit blind spot
 * (the audit scans interactive elements, div role=radio was never scanned).
 *
 *   [1] the SPLIT-BUILD law — build-prod.sh: compile + generate modes
 *       with --experimental-build-mode, preflight kills chrome/dev/prod
 *       (the OOM law), `all` NEVER starts (the honest guard), the
 *       NEXTAUTH_SECRET law (generate-if-missing, never printed), the
 *       assembly law (static + public + .env), the start law (setsid +
 *       PORT + NODE_ENV + server.js + health wait), the ordering-law
 *       comments, the ONE health authority (/api/health).
 *   [2] the RADIO-CARD law — both role="radio" surfaces carry the R167
 *       chip-family interaction states (focus-visible:ring-2 + offset,
 *       active:scale + motion-reduce pair, transition + motion-reduce);
 *       the settings restore cards' unselected hover gains the border
 *       affordance.
 *   [3] the BLIND-SPOT law — a structural mini-audit: EVERY role="radio"
 *       surface in src/modules carries motion-reduce on its transition
 *       and a visible focus state (the law the r156 audit tool could not
 *       see; this battery now guards it).
 *   [4] the REGRESSION PIN — the sibling families intact: the
 *       party-aging outline family untouched, the copilot chip families
 *       (R167 byte-pattern) untouched, next.config output standalone,
 *       the smoke suite exists for the same-call consumption.
 *
 * Run: npx tsx scripts/r168-prod-build-check.ts
 */

import { readFileSync, statSync } from "node:fs";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(info ? `${name} — ${info}` : name);
}
function section(title: string) {
  console.log(`\n${title}`);
}

const read = (p: string) => readFileSync(p, "utf8");

// ─────────────────────────────────────────────────────────── [1] SPLIT-BUILD
section("[1] the SPLIT-BUILD law — scripts/build-prod.sh");

const script = read("scripts/build-prod.sh");

ok("1a. the script exists and is executable", (statSync("scripts/build-prod.sh").mode & 0o111) !== 0);

for (const cmd of ["preflight", "compile", "generate", "assemble", "start", "status", "all"]) {
  ok(`1b. subcommand "${cmd}" present`, script.includes(`  ${cmd})`));
}

ok(
  "1c. the split-build law — compile mode carries --experimental-build-mode=compile",
  /compile\)\n[\s\S]*?--experimental-build-mode=compile/.test(script),
);
ok(
  "1d. the split-build law — generate mode carries --experimental-build-mode=generate",
  /generate\)\n[\s\S]*?--experimental-build-mode=generate/.test(script),
);
ok(
  "1e. the OOM law — preflight kills chrome-headless leftovers",
  /preflight\)\n[\s\S]*?chrome-headless|kill_servers[\s\S]*?chrome-headless/.test(script),
);
ok(
  "1f. the OOM/clobber law — preflight kills the dev server",
  /kill_servers[\s\S]*?next dev -p 3000/.test(script),
);
ok(
  "1g. the supersede law — preflight kills next-server (dev AND stale prod)",
  /kill_servers[\s\S]*?pkill -f "next-server"/.test(script),
);
ok(
  "1h. the secret law — NEXTAUTH_SECRET generated when missing",
  /grep -q "\^NEXTAUTH_SECRET="[\s\S]*?openssl rand -base64 32/.test(script),
);
ok(
  "1i. the secret law — the secret VALUE is never echoed",
  !/echo.*NEXTAUTH_SECRET=\$/.test(script),
);
ok(
  "1j. the assembly law — static copied into standalone",
  /cp -r \.next\/static \.next\/standalone\/\.next\//.test(script),
);
ok(
  "1k. the assembly law — public copied into standalone",
  /cp -r public \.next\/standalone\//.test(script),
);
ok(
  "1l. the secret-rides law — .env copied into the standalone",
  /cp \.env \.next\/standalone\/\.env/.test(script),
);
ok(
  "1m. the start law — setsid + PORT + NODE_ENV=production + server.js",
  /setsid nohup env PORT="\$PORT" NODE_ENV=production node \.next\/standalone\/server\.js/.test(script),
);
ok(
  "1n. the start law — health is awaited before PROD-READY",
  /wait_health "\$PORT"[\s\S]*?PROD-READY:\$PORT/.test(script),
);
ok(
  "1o. the honest guard — `all` never EXECUTES the server (no setsid/server start, only instructions printed)",
  (() => {
    const allBlock = script.slice(script.indexOf("  all)")).split(";;")[0];
    return !allBlock.includes("setsid") && !allBlock.includes("node .next/standalone/server.js") && !allBlock.includes("wait_health");
  })(),
);
ok(
  "1p. the ordering law — the ensure-dev-before-start warning is written",
  script.includes("revive dev FIRST"),
);
ok(
  "1q. the same-call law — the start comment says consume in the SAME tool call",
  /SAME tool call|same-call/.test(script),
);
ok(
  "1r. the ONE health authority — checks ride /api/health",
  (script.match(/\/api\/health/g) || []).length >= 2,
);

// ───────────────────────────────────────────────────────── [2] RADIO-CARD LAW
section("[2] the RADIO-CARD law — the two role=radio surfaces join the family");

const settings = read("src/modules/settings/business-settings-view.tsx");
const billing = read("src/modules/billing/subscription-view.tsx");

ok(
  "2a. settings restore cards — focus-visible:ring-2 present",
  /role="radio"[\s\S]{0,900}?focus-visible:ring-2/.test(settings),
);
ok(
  "2b. settings restore cards — focus ring-offset present",
  /focus-visible:ring-offset-1 focus-visible:ring-offset-background/.test(settings),
);
ok(
  "2c. settings restore cards — active scale + motion-reduce pair",
  /active:scale-\[0\.98\] motion-reduce:transition-none motion-reduce:active:scale-100/.test(settings),
);
ok(
  "2d. settings restore cards — the unselected hover gains the border affordance",
  /hover:border-primary\/30 hover:bg-muted\/40/.test(settings),
);
ok(
  "2e. billing plan cards — focus-visible:ring-2 present",
  /focus-visible:ring-2 focus-visible:ring-primary\/40/.test(billing),
);
ok(
  "2f. billing plan cards — focus ring-offset present",
  /focus-visible:ring-offset-1 focus-visible:ring-offset-background/.test(billing),
);
ok(
  "2g. billing plan cards — active scale + motion-reduce pair",
  /active:scale-\[0\.98\] motion-reduce:transition-none motion-reduce:active:scale-100/.test(billing),
);

// ───────────────────────────────────────────────────────── [3] BLIND-SPOT LAW
section("[3] the BLIND-SPOT law — every role=radio surface passes the mini-audit");

import { readdirSync, statSync as st } from "node:fs";
import { join } from "node:path";

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsx(p));
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const allTsx = listTsx("src/modules");
const radioSurfaces = allTsx.filter((f) => read(f).includes('role="radio"'));
ok(
  "3a. exactly TWO role=radio surfaces known (settings + billing — new ones must join this battery)",
  radioSurfaces.length === 2,
  radioSurfaces.join(", "),
);
for (const f of radioSurfaces) {
  const src = read(f);
  const hasTransition = /transition-(colors|all)/.test(src);
  const hasReduce = /motion-reduce:transition-none/.test(src);
  const hasFocus = /focus-visible:(ring-2|outline-2)/.test(src);
  ok(`3b. ${f.split("/").pop()} — transition has motion-reduce`, !hasTransition || hasReduce);
  ok(`3c. ${f.split("/").pop()} — visible focus state`, hasFocus);
}

// ─────────────────────────────────────────────────────────── [4] REGRESSION
section("[4] the REGRESSION PIN — the sibling families intact");

const aging = read("src/modules/balances/party-aging-panel.tsx");
ok(
  "4a. the party-aging outline family byte-pattern untouched",
  aging.includes(
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
  ),
);
const copilot = read("src/modules/copilot/copilot-view.tsx");
ok(
  "4b. the R167 copilot chip family intact — empty-state chips keep the ring byte-pattern",
  copilot.includes("focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background"),
);
ok(
  "4c. the R167 expense chip picker intact",
  copilot.includes("pickExpenseActionChip") && copilot.includes("copilot-action-expense-facet"),
);
const nextConfig = read("next.config.ts");
ok(
  "4d. next.config — output: standalone (the assembly's precondition)",
  /output:\s*"standalone"/.test(nextConfig),
);
ok(
  "4e. the smoke suite exists for the same-call consumption",
  statSync("scripts/e2e-smoke.ts").size > 1000,
);
ok(
  "4f. ensure-dev survives untouched (the ordering law's other half)",
  read("scripts/ensure-dev.sh").includes('pkill -f "next-server"'),
);

console.log(`\n══════════════════════════════════════`);
console.log(`r168-prod-build-check: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("ALL GREEN ✓");
