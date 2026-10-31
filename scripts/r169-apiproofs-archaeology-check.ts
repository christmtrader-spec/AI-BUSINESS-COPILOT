/**
 * scripts/r169-apiproofs-archaeology-check.ts — R169 harness.
 *
 * THE API-PROOFS ARCHAEOLOGY: the R95/R96/R97/R98 REAL-HTTP PROOFS
 * batteries were carried "correct-by-inspection" since birth — the lore
 * said they CANNOT run in the sandbox (the server-only import chain
 * through src/lib/ai/snapshot). R169 proved the lore WRONG: bun's
 * `--conditions react-server` resolves the server-only guard to its
 * empty export and the batteries run END-TO-END against dev:3000. Once
 * runnable, they revealed REAL STALE DRIFT (the r98-unit lesson again,
 * now on the proof side): the R147 OUTSTANDING DRILL renamed/reshaped
 * the meta's leader fields (largestDebtor → topDebtor; the R97 podium
 * ARRAYS topDebtors/topCreditors → the singular throne) and later rounds
 * rotated the counts/attribution fields and the prompt's numbered law
 * family ('6d. BOOK LEADERS' is a scar — 6b/6e/6f survive). All five
 * proof batteries (incl. r101, which always ran) are re-pinned GREEN:
 * r95 30 · r96 30 · r97 32 · r98 25 · r101 28 = 145 live-HTTP assertions.
 *
 *   [1] the RUNNER LAW — the five api-proofs carry the
 *       `bun --conditions react-server` Run: line (the un-freezing
 *       convention, documented where the next runner will read it).
 *   [2] the CURRENT-SHAPE LAW (source pins) — snapshot.ts: topDebtor/
 *       topCreditor via outstandingViewOf (partyId IN, rank/partyCount
 *       deliberately dropped), the snapshot's largestDebtor/largestCreditor
 *       via topLeaderOfFact (the citation shape), the prompt family
 *       6b/6e/6f present and the 6d scar absent.
 *   [3] the STALE-TOKEN GUARD — no battery accesses the dead meta keys
 *       (meta.topDebtors / meta.topCreditors / meta.largestDebtor /
 *       meta.largestCreditor) — the snapshot-side singular keys are the
 *       only legitimate largest* spellings.
 *   [4] the REGRESSION PIN — the pure units that always ran stay
 *       imported by the same files (leader-view is client-safe by the
 *       r93 law), the worklog notes the archaeology, and the batteries'
 *       RE-PINNED markers are present (the honest-log law).
 *
 * Run: npx tsx scripts/r169-apiproofs-archaeology-check.ts
 */

import { readFileSync } from "node:fs";

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

const PROOFS = [
  "scripts/r95-leaders-api-proofs.ts",
  "scripts/r96-leader-api-proofs.ts",
  "scripts/r97-podium-api-proofs.ts",
  "scripts/r98-merch-api-proofs.ts",
  "scripts/r101-leader-api-proofs.ts",
];

// ───────────────────────────────────────────────────────────── [1] RUNNER LAW
section("[1] the RUNNER LAW — the react-server convention on every proof");

for (const p of PROOFS) {
  const src = read(p);
  ok(
    `${p.split("/").pop()} — Run: line carries --conditions react-server`,
    /Run:\s*bun --conditions react-server/.test(src),
  );
}
ok(
  "1b. the runner convention is a DOCUMENTED comment (not just a command)",
  PROOFS.every((p) => read(p).includes("Run:")),
);

// ──────────────────────────────────────────────────────── [2] CURRENT SHAPE
section("[2] the CURRENT-SHAPE law — snapshot.ts is the ONE authority");

const snap = read("src/lib/ai/snapshot.ts");

ok(
  "2a. the meta type declares topDebtor/topCreditor (the R147 singular throne)",
  /topDebtor\?: CopilotOutstandingView \| null/.test(snap) &&
    /topCreditor\?: CopilotOutstandingView \| null/.test(snap),
);
ok(
  "2b. outstandingViewOf maps partyId IN (the §16/§18 drill needs the id)",
  /function outstandingViewOf[\s\S]{0,600}?partyId: first\.partyId/.test(snap),
);
ok(
  "2c. outstandingViewOf deliberately DROPS rank/partyCount (the meta carries exactly what the chips render)",
  (() => {
    const i = snap.indexOf("function outstandingViewOf");
    const body = snap.slice(i, i + 700);
    return body.includes("openItems: first.openItems") && !body.includes("rank:") && !body.includes("partyCount");
  })(),
);
ok(
  "2d. the snapshot's citation shape rides topLeaderOfFact (largestDebtor/largestCreditor singular)",
  /largestDebtor: topLeaderOfFact\(debtorsFact\)/.test(snap) &&
    /largestCreditor: topLeaderOfFact\(creditorsFact\)/.test(snap),
);
ok(
  "2e. the prompt family 6b/6e/6f present (the surviving numbered laws)",
  snap.includes("`6b.") && snap.includes("`6e.") && snap.includes("`6f."),
);
ok(
  "2f. the 6d scar — 'BOOK LEADERS' is GONE from the prompt (the law moved to the snapshot + rules 1/4)",
  !snap.includes("BOOK LEADERS"),
);
ok(
  "2g. server-only is the FIRST import of snapshot.ts (the guard that froze the batteries — the reason the runner flag exists)",
  /^import "server-only";/m.test(snap),
);
ok(
  "2h. leader-view stays client-safe (NO server-only import — the r93 law the pure units rely on)",
  !read("src/lib/leader-view.ts").includes('import "server-only"'),
);

// ─────────────────────────────────────────────────────── [3] STALE GUARD
section("[3] the STALE-TOKEN guard — the dead meta keys never return");

const deadAccess: string[] = [];
for (const p of PROOFS) {
  // strip comments first — the docblocks may HONESTLY mention the old names
  // (the archaeology notes); only CODE accesses are the stale-token crime.
  const code = read(p)
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join("\n");
  if (/meta(\.|\??\.)topDebtors\b/.test(code) || /meta(\.|\??\.)topCreditors\b/.test(code)) deadAccess.push(p);
  if (/meta(\.|\??\.)largestDebtor\b/.test(code) || /meta(\.|\??\.)largestCreditor\b/.test(code)) deadAccess.push(p);
}
ok("3a. no battery reads meta.topDebtors/topCreditors/largestDebtor/largestCreditor", deadAccess.length === 0, deadAccess.join(", "));
ok(
  "3b. the snapshot-side singular largest* spellings remain legitimate (r95 cites them)",
  read("scripts/r95-leaders-api-proofs.ts").includes("largestDebtor"),
);
ok(
  "3c. the dead PLURAL keys are gone from the meta type itself",
  !snap.includes("topDebtors?:") && !snap.includes("topCreditors?:"),
);

// ─────────────────────────────────────────────────────────── [4] HONEST LOG
section("[4] the HONEST-LOG law — the archaeology is written where it happened");

let repinned = 0;
for (const p of PROOFS) {
  if (read(p).includes("RE-PINNED R169")) repinned++;
}
ok(
  "4a. the RE-PINNED R169 marker present in the drifted batteries (r95/r96/r97/r98 — r101 never drifted)",
  repinned >= 4,
  `${repinned}/5`,
);
ok(
  "4b. the pure units keep their own files (the server-only split is the battery family's structure law)",
  read("scripts/r97-podium-unit.ts").includes("topLeadersOfFact") &&
    read("scripts/r95-book-leaders-unit.ts").includes("bookLeadersFromBookRows"),
);
ok(
  "4c. the r169 finding is pinned in THIS battery's docblock (the next round reads it here first)",
  read("scripts/r169-apiproofs-archaeology-check.ts").includes("react-server"),
);

// ──────────────────────────────────────────────────────── [5] THE DEEP AUDIT
section("[5] the DEEP-AUDIT law — the motion/focus sweep generalizes (R169)");

const auditTool = read("scripts/r156-motion-audit.py");
ok(
  "5a. the audit grows --deep (the cn() + role=* blind spots documented in the docstring)",
  auditTool.includes("--deep") && auditTool.includes("cn()-wrapped classes") && auditTool.includes('role="radio|option'),
);
ok(
  "5b. deep mode scans EVERY string literal (ANY_STRING) — the v1 className=-anchored regex missed cn() pieces",
  auditTool.includes("ANY_STRING"),
);
ok(
  "5c. deep mode requires focus-visible on role=radio|option|menuitem|tab|switch surfaces",
  /ROLE_SURFACE = re\.compile\(\s*r'role="\(radio\|option\|menuitem\|tab\|switch\)"/.test(auditTool),
);
ok(
  "5d. the deep FIXER exists and inherits the v1 safety rules (plain literals only, hand-fix list)",
  read("scripts/r169-deep-fix.py").includes("HAND_FIX") && read("scripts/r169-deep-fix.py").includes("${"),
);

console.log(`\n══════════════════════════════════════`);
console.log(`r169-apiproofs-archaeology-check: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("ALL GREEN ✓");
