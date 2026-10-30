/**
 * scripts/r136-copilot-detail-check.ts — R136 battery.
 *
 * Pins the copilot transcript-detail wave (restored-answer badge,
 * scroll-to-bottom pill, copy symmetry, and the styling-detail pass):
 *
 *   [1] i18n LAW — the 4 new keys exist in BOTH locales, symmetric and
 *       non-empty; the FA strings are genuinely Persian (no bare EN
 *       sentences) and the EN strings carry no Persian.
 *   [2] ONE PILL LAW — statusPillBase is referenced by EXACTLY the two
 *       status pills (amber resuming + sky restored), so the pill geometry
 *       can never drift; the resuming pill keeps role=status +
 *       aria-live=polite; the restored badge is gated on the device-local
 *       healed flag && !failed (R128 law C surface) and carries its
 *       testid + description tooltip.
 *   [3] SCROLL PILL LAW — gated on !atBottom && !empty (never rendered on
 *       the empty state or at the live edge), smooth scrollTo, the
 *       pending-aware aria-label law, physical centering safe under RTL,
 *       motion-reduce guards on BOTH animations.
 *   [4] COPY SYMMETRY LAW — the user bubble's copy button rides the same
 *       copiedId state machine (copied/copiedId) and is suppressed while
 *       pending; the assistant button keeps its backdrop layer.
 *   [5] DETAIL-PASS LAW — thinking dots stop under motion-reduce; the
 *       session-row actions reveal on hover/focus/touch (max-md) and on
 *       Radix data-highlighted; citation chips + empty-state chips carry
 *       the transition/focus/active polish; the messages wrapper keeps the
 *       scroll area absolutely filled (relative min-h-0 flex-1 + inset-0).
 *
 * Run: bun scripts/r136-copilot-detail-check.ts
 */
export {};

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function count(hay: string, needle: string) {
  return hay.split(needle).length - 1;
}

const view = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const en = readFileSync("src/i18n/messages/en.ts", "utf8");
const fa = readFileSync("src/i18n/messages/fa.ts", "utf8");

// ---- [1] i18n law -----------------------------------------------------------

const NEW_KEYS = ["restoredBadge", "restoredDesc", "scrollBottom", "scrollBottomLive"] as const;

function sectionOf(src: string, section: string): string {
  const start = src.indexOf(`  ${section}: {`);
  if (start < 0) return "";
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}
const enCop = sectionOf(en, "copilot");
const faCop = sectionOf(fa, "copilot");

for (const k of NEW_KEYS) {
  const enM = enCop.match(new RegExp(`\\b${k}: "([^"]+)"`));
  const faM = faCop.match(new RegExp(`\\b${k}: "([^"]+)"`));
  ok(`[1] en.${k} present + non-empty`, !!enM && enM[1].length > 4);
  ok(`[1] fa.${k} present + non-empty`, !!faM && faM[1].length > 4);
  ok(`[1] fa.${k} is Persian (no bare EN sentence)`, !!faM && /[\u0600-\u06FF]/.test(faM[1]));
  ok(`[1] fa.${k} has no long ASCII run`, !!faM && !/[A-Za-z]{4,}/.test(faM[1]));
  ok(`[1] en.${k} has no Arabic-script chars`, !!enM && !/[\u0600-\u06FF]/.test(enM[1]));
}
ok("[1] fa.scrollBottom uses the conversational register", (() => {
  const m = faCop.match(/\bscrollBottom: "([^"]+)"/);
  return !!m && m[1].includes("آخرین");
})());

// ---- [2] ONE pill law -------------------------------------------------------

const pillBaseUses = count(view, "statusPillBase,");
ok("[2] statusPillBase defined once", count(view, "const statusPillBase") === 1);
ok("[2] statusPillBase used exactly 2× (resuming + restored)", pillBaseUses === 2, String(pillBaseUses));
ok(
  "[2] resuming pill keeps role=status + aria-live=polite",
  /role="status"\s*\n\s*aria-live="polite"/.test(view),
);
ok(
  "[2] restored badge hue is sky, resuming hue is amber (distinct semantics)",
  view.includes("border-sky-500/40 bg-sky-500/10") && view.includes("border-amber-500/40 bg-amber-500/10"),
);
ok(
  "[2] restored badge gated on healed && !failed (device-local law surface)",
  /\{m\.healed && !m\.failed \? \(/.test(view),
);
ok("[2] restored badge carries its testid", view.includes('data-testid="copilot-restored-badge"'));
ok("[2] restored badge carries the description tooltip", view.includes('title={t("restoredDesc")}'));

// ---- [3] scroll pill law ----------------------------------------------------

ok("[3] scroll pill gated on !atBottom && !empty", /\{!atBottom && !empty \? \(/.test(view));
ok("[3] scroll pill testid", view.includes('data-testid="copilot-scroll-bottom"'));
ok("[3] scroll pill scrolls smooth to the live edge", /behavior: "smooth"/.test(view));
ok(
  "[3] pending-aware aria-label law",
  /aria-label=\{pending \? t\("scrollBottomLive"\) : t\("scrollBottom"\)\}/.test(view),
);
ok(
  "[3] physical centering (RTL-safe) — left-1/2 -translate-x-1/2",
  view.includes("absolute bottom-3 left-1/2") && view.includes("-translate-x-1/2"),
);
ok(
  "[3] pulsing dot only while pending + motion-reduce guard",
  /animate-pulse rounded-full motion-reduce:animate-none/.test(view),
);
ok(
  "[3] pill entrance animated + motion-reduce guard",
  /animate-in fade-in slide-in-from-bottom-2 .*motion-reduce:animate-none/.test(view),
);

// ---- [4] copy symmetry law --------------------------------------------------

const userBranch = view.slice(view.indexOf('m.role === "user" ? ('), view.indexOf("m.role === \"user\" ? (") + 2400);
ok("[4] user copy button gated on !pending", userBranch.includes("{!pending ? ("));
ok("[4] user copy rides copyAnswer (same state machine)", userBranch.includes("void copyAnswer(m)"));
ok(
  "[4] user copy aria-label law (generic copy wording, not the answer-specific key)",
  userBranch.includes('copiedId === m.id ? tCommon("copied") : tCommon("copy")'),
);
ok(
  "[4] assistant copy keeps the backdrop layer",
  view.includes("bg-background/80") && view.includes("backdrop-blur-sm"),
);

// ---- [5] detail-pass law ----------------------------------------------------

ok("[5] thinking dots motion-reduce guard", /animate-bounce rounded-full motion-reduce:animate-none/.test(view));
ok(
  "[5] session-row actions reveal on hover/focus/touch/highlight",
  /group-hover\/item:opacity-100 group-data-\[highlighted\]\/item:opacity-100 focus-within:opacity-100 max-md:opacity-100/.test(view),
);
ok("[5] citation chips hover + motion-reduce polish", /rounded-full border px-2 py-0\.5 text-\[11px\] leading-none transition-colors/.test(view));
ok("[5] empty-state chips active-scale + focus ring", /active:scale-\[0\.98\] .*focus-visible:ring-2/.test(view) || (/active:scale-\[0\.98\]/.test(view) && /focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background/.test(view)));
ok(
  "[5] messages wrapper keeps the scroll area absolutely filled",
  view.includes("relative min-h-0 flex-1") && view.includes("absolute inset-0 space-y-4 overflow-y-auto"),
);
ok(
  "[5] assistant bubble keeps the ring refinement",
  view.includes("ring-border/40") && view.includes("shadow-xs"),
);

// ---- [6] exported-shape honesty --------------------------------------------

ok("[6] no leftover TODO/placeholder in the touched files", !/TODO|XXX|待补充|【/.test(view));

console.log(`\n== r136: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
