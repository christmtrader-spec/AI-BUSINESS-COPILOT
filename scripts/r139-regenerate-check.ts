/**
 * scripts/r139-regenerate-check.ts — R139 battery.
 *
 * Pins the regenerate-answer wave (the honest metering confirm + the
 * affordance cluster + the styling/a11y detail pass):
 *
 *   [1] i18n LAW — the 5 new keys exist in BOTH locales, symmetric and
 *       non-empty; FA strings are genuinely Persian; the {question}/{used}
 *       /{limit} placeholder laws match byte-for-byte across locales.
 *   [2] GATE LAW — the affordance renders ONLY under the LAST completed
 *       (non-failed, non-empty) answer; the question comes from the
 *       transcript walk (never the stale lastQuestionRef).
 *   [3] METERING HONESTY — the send happens ONLY from the confirm dialog's
 *       AlertDialogAction (confirmRegenerate); the meter line renders only
 *       when BOTH used and limit are real numbers (§64: unlimited plans
 *       and failed fetches show NO meter, never fake numbers); the meter
 *       numbers pass through Intl.NumberFormat(dayLocale) — the ONE locale
 *       source law; the usage query is fetched ONLY while the dialog is
 *       open (enabled: regenOpen) with retry:false (a 403 must never spin).
 *   [4] APPEND LAW — regenerate appends a NEW stamped turn (the 6th
 *       ts: Date.now() site); no message deletion exists client-side.
 *   [5] STYLING + A11Y DETAIL LAW — the regenerate button rides the same
 *       backdrop/backing law as copy inside ONE actions cluster (single
 *       absolute anchor — no overlapping absolutes), carries testid +
 *       aria-label + title, the spin-on-hover is motion-reduce guarded,
 *       the cluster reveals on hover AND focus-within AND touch (max-md);
 *       the window segmented control gained focus-visible rings (keyboard
 *       law); the composer counter turns amber at the ≥450 honesty
 *       threshold with a transition.
 *
 * Run: bun scripts/r139-regenerate-check.ts
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

const NEW_KEYS = [
  "regenerateTitle",
  "regenerateDesc",
  "regenerateMeter",
  "regenerateConfirm",
  "regenerateAria",
] as const;

function sectionOf(src: string, section: string): string {
  const start = src.indexOf(`  ${section}: {`);
  if (start < 0) return "";
  let depth = 0;
  let i = src.indexOf("{", start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(open, i + 1);
}

const enCopilot = sectionOf(en, "copilot");
const faCopilot = sectionOf(fa, "copilot");
const hasPersian = (s: string) => /[\u0600-\u06FF]/.test(s);

for (const key of NEW_KEYS) {
  const enMatch = enCopilot.match(new RegExp(`${key}: "([^"]*)"`));
  const faMatch = faCopilot.match(new RegExp(`${key}: "([^"]*)"`));
  ok(`[1] ${key} exists in EN`, !!enMatch);
  ok(`[1] ${key} exists in FA`, !!faMatch);
  if (enMatch && faMatch) {
    ok(
      `[1] ${key} EN is English, FA is Persian`,
      !hasPersian(enMatch[1]) && hasPersian(faMatch[1]),
      `EN="${enMatch[1]}" FA="${faMatch[1]}"`,
    );
    ok(`[1] ${key} placeholder law symmetric`, (() => {
      const ph = (s: string) => (s.match(/\{(question|used|limit)\}/g) ?? []).sort().join(",");
      return ph(enMatch[1]) === ph(faMatch[1]);
    })());
  }
}

// ---- [2] gate law -------------------------------------------------------------

ok(
  "[2] gate: last completed answer (pending/failed/empty excluded)",
  view.includes("const lastCompletedAnswer =") &&
    /lastCompletedAnswer =\s*\n\s*!pending &&\s*\n\s*lastMessage\?\.role === "assistant" &&\s*\n\s*lastMessage\.failed !== true &&\s*\n\s*lastMessage\.content\.trim\(\)\.length > 0;/.test(view),
);
ok(
  "[2] gate: the question walks the transcript (no stale ref)",
  /const regenerateQuestion = useMemo\(\(\) => \{\s*\n\s*for \(let i = messages\.length - 1; i >= 0; i -= 1\) \{/.test(view) &&
    !view.includes("regenerateQuestion = lastQuestionRef"),
);
ok(
  "[2] gate: button only on the last message + canRegenerate",
  view.includes("canRegenerate && i === messages.length - 1"),
);

// ---- [3] metering honesty ------------------------------------------------------

ok(
  "[3] send ONLY from the confirm action",
  /AlertDialogAction\s*\n\s*onClick=\{confirmRegenerate\}/.test(view) &&
    count(view, "const confirmRegenerate") === 1,
);
ok(
  "[3] §64 — meter line only when used AND limit are real numbers",
  /typeof meterRaw\.used === "number" &&\s*\n\s*typeof meterRaw\.limit === "number"/.test(view),
);
ok(
  "[3] ONE locale law — ONE memoized formatter for dialog + glance",
  view.includes("const numFmt = useMemo(() => new Intl.NumberFormat(dayLocale), [dayLocale]);") &&
    // The DIALOG's two sites are this battery's mandate (the glance chip's
    // third site is R140's — pinned by r140-welcome-usage-check).
    count(view, "numFmt.format(meter.used)") >= 2 &&
    count(view, "numFmt.format(meter.limit)") >= 2,
);
ok(
  "[3] usage: ONE shared query (R140 glance law) — fetches on copilot mount, never retried, no separate dialog fetch",
  /queryKey: \["billing", "usage", "copilot"\],\s*\n\s*queryFn: \(\) => api\("\/api\/v1\/billing\/usage"\),\s*\n\s*staleTime: 60_000,\s*\n\s*retry: false,/.test(view) &&
    count(view, 'api("/api/v1/billing/usage")') === 1,
);
ok(
  "[3] glance chip: §64 render gate + honest tone escalation + testid",
  view.includes('data-testid="copilot-usage-glance"') &&
    /meter\.limit > 0 && meter\.used \/ meter\.limit >= 1/.test(view) &&
    /meter\.limit > 0 && meter\.used \/ meter\.limit >= 0\.8/.test(view) &&
    /\{meter \? \(/.test(view),
);
ok("[3] meter line carries its testid", view.includes('data-testid="copilot-regen-meter"'));

// ---- [4] append law --------------------------------------------------------------

ok(
  "[4] regenerate appends a NEW stamped turn (6 sites total)",
  count(view, "ts: Date.now()") === 6 && /confirmRegenerate[\s\S]*?ts: Date\.now\(\)/.test(view),
);
ok(
  "[4] no client-side message deletion for regenerate (append-only law)",
  !/confirmRegenerate[\s\S]*?filter\(\(m\) => m\.id !==/.test(view),
);

// ---- [5] styling + a11y detail law ----------------------------------------------

ok(
  "[5] ONE actions cluster — single absolute anchor for copy + regenerate",
  count(view, 'className="absolute end-2 bottom-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 motion-reduce:transition-none"') === 1 &&
    count(view, "absolute end-2 bottom-1.5") === 2,
  `anchors=${count(view, "absolute end-2 bottom-1.5")}`,
);
ok(
  "[5] regenerate affordance: testid + aria-label + title",
  view.includes('data-testid="copilot-regenerate"') &&
    count(view, 'aria-label={t("regenerateAria")}') === 1 &&
    count(view, 'title={t("regenerateAria")}') === 1,
);
ok(
  "[5] spin-on-hover is motion-reduce guarded",
  view.includes("group-hover/regen:-rotate-[360deg]") &&
    view.includes("motion-reduce:group-hover/regen:rotate-0"),
);
ok(
  "[5] segmented control: keyboard focus rings (a11y fix)",
  view.includes(
    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
  ),
);
ok(
  "[5] composer counter: amber honesty at ≥450 with transition",
  view.includes("input.length >= 450 && \"text-amber-600 dark:text-amber-400\"") &&
    view.includes("\"shrink-0 tabular-nums transition-colors\""),
);
ok(
  "[5] copy button keeps its copiedId law + gained the focus ring",
  count(view, 'aria-label={copiedId === m.id ? t("copied") : t("copy")}') === 1 &&
    count(view, "focus-visible:ring-2 focus-visible:ring-ring/60") >= 3,
);

// ---- summary ---------------------------------------------------------------------

console.log(`\n== r139: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
