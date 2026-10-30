/**
 * r140-welcome-usage-check.ts — R140 battery.
 *
 * Covers the round's two features + the styling/a11y mandate:
 *  [1] i18n parity — the 11 new keys (6 dashboard + 5 profile), EN/FA
 *      symmetric, FA pure Persian, no stray English in FA values.
 *  [2] Welcome card source laws — the R108 consumer: shared ["me"] query,
 *      gate law (loading → silence, dismissed → gone), PATCH
 *      {checklistDismissed:true} + invalidate, testids/aria, the
 *      desktop+data-writer honesty of the replay affordance.
 *  [3] Tour replay laws — replayProductTour exported, listener re-guards
 *      (viewport + anchor), flag cleared, welcome card dispatches.
 *  [4] Profile restore laws — Me type carries checklistDismissedAt, the
 *      row renders the honest state, restore PATCHes false through the
 *      SAME saveMutation (dedicated toast), invalidate ["me"].
 *  [5] Usage glance laws — ONE shared billing/usage query, §64 gate,
 *      tone escalation (muted/amber/destructive), numFmt memoized on
 *      dayLocale, dayLocale hoisted above its first use (no TDZ), testid.
 *
 * Run:  bun scripts/r140-welcome-usage-check.ts
 * Exit: 0 = all green, 1 = any check failed.
 */
import { readFileSync } from "node:fs";

let passed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info?: string) {
  if (cond) passed += 1;
  else {
    failures.push(name + (info ? ` — ${info}` : ""));
    console.log(`FAIL ${name}${info ? ` — ${info}` : ""}`);
  }
}
function count(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- [1] i18n parity -------------------------------------------------------------

const en = read("../src/i18n/messages/en.ts");
const fa = read("../src/i18n/messages/fa.ts");

const DASH_KEYS = [
  "welcomeCardTitle",
  "welcomeCardDesc",
  "welcomeActionCopilot",
  "welcomeActionReports",
  "welcomeReplayTour",
  "welcomeDismiss",
];
const PROFILE_KEYS = [
  "welcomeCardLabel",
  "welcomeCardShown",
  "welcomeCardHidden",
  "welcomeCardRestore",
  "welcomeCardRestoreToast",
];

ok(
  "[1] all 11 new keys exist in BOTH en and fa (dashboard + profile)",
  DASH_KEYS.every((k) => count(en, `    ${k}: `) >= 1 && count(fa, `    ${k}: `) >= 1) &&
    PROFILE_KEYS.every((k) => count(en, `    ${k}: `) >= 1 && count(fa, `    ${k}: `) >= 1),
);

// The FA values must be Persian — extract each FA value and demand
// at least 3 Arabic-script chars; EN values must have none.
const faValue = (key: string): string => {
  const m = fa.match(new RegExp(`    ${key}: "([^"]*)"`));
  return m ? m[1] : "";
};
const enValue = (key: string): string => {
  const m = en.match(new RegExp(`    ${key}: "([^"]*)"`));
  return m ? m[1] : "";
};
const hasPersian = (s: string) => (s.match(/[\u0600-\u06FF]/g) ?? []).length >= 3;
const hasLatin = (s: string) => /[A-Za-z]/.test(s);

for (const k of [...DASH_KEYS, ...PROFILE_KEYS]) {
  ok(`[1] ${k}: FA pure Persian, EN latin`, hasPersian(faValue(k)) && !hasPersian(enValue(k)) && hasLatin(enValue(k)), `fa="${faValue(k).slice(0, 30)}"`);
}

ok(
  "[1] no interpolation placeholders introduced this round (keys are placeholder-free)",
  [...DASH_KEYS, ...PROFILE_KEYS].every(
    (k) => !/\{[a-zA-Z]+\}/.test(enValue(k)) && !/\{[a-zA-Z]+\}/.test(faValue(k)),
  ),
);

// ---- [2] welcome card source laws --------------------------------------------------

const card = read("../src/modules/dashboard/welcome-card.tsx");
const dash = read("../src/modules/dashboard/dashboard-view.tsx");

ok("[2] shared ONE account query — the SAME [\"me\"] key the profile reads (R154 re-pin: the card grew the shared [\"members\", activeId] probe — two useQuery calls, BOTH shared-cache)", card.includes('queryKey: ["me"],') && count(card, "useQuery<") === 2 && card.includes('queryKey: ["members", activeId]'));
ok("[2] gate law: loading → silence, dismissed → gone (one combined gate)", /if \(!me \|\| me\.checklistDismissedAt\) return null;/.test(card));
ok("[2] dismiss PATCHes the R108 boolean law", card.includes('body: JSON.stringify({ checklistDismissed: true })') && card.includes('method: "PATCH"'));
ok("[2] dismissal invalidates the shared cache", /onSuccess: \(\) => void queryClient\.invalidateQueries\(\{ queryKey: \["me"\] \}\)/.test(card));
ok(
  "[2] a11y: dismiss has aria-label + title + testid, pending spinner honest",
  card.includes('aria-label={t("welcomeDismiss")}') &&
    card.includes('title={t("welcomeDismiss")}') &&
    card.includes('data-testid="welcome-card-dismiss"') &&
    card.includes("motion-reduce:animate-none"),
);
ok(
  "[2] the actions ride testids + icon chips + focus rings (R154 re-pin: the conditional invite tile joins — 4 when it renders, 3 tiles' pins grow to 4)",
  card.includes('data-testid="welcome-action-copilot"') &&
    card.includes('data-testid="welcome-action-reports"') &&
    card.includes('data-testid="welcome-action-tour"') &&
    card.includes('data-testid="welcome-action-invite"') &&
    count(card, "focus-visible:outline-none focus-visible:ring-2") === 4,
);
ok(
  "[2] replay affordance honesty: hidden where the tour cannot run (no lg → display:none, out of the a11y tree)",
  card.includes("hidden w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start text-sm transition-all focus-visible:outline-none focus-visible:ring-2 motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-reduce:transition-none lg:flex"),
);
ok(
  "[2] R154 re-pin: all FOUR tiles carry the motion-safe lift + group icon chip (count pins)",
  count(card, "motion-safe:hover:-translate-y-px") === 4 &&
    count(card, "group-hover:bg-primary/15") === 4 &&
    count(card, "transition-colors group-hover:bg-primary/15") === 4,
);
ok("[2] the card mounts on the dashboard right after the PageHeader (R154 re-pin: the role prop feeds the invite tile's gate)", dash.includes("import { WelcomeCard } from \"@/modules/dashboard/welcome-card\";") && count(dash, "<WelcomeCard role={role} />") === 1);
ok("[2] the card is testid-findable", card.includes('data-testid="welcome-card"'));

// ---- [3] tour replay laws ----------------------------------------------------------

const tour = read("../src/modules/shell/onboarding-tour.tsx");

ok("[3] replayProductTour exported (event dispatch, SSR-guarded)", /export function replayProductTour\(\)/.test(tour) && /typeof window === "undefined"/.test(tour));
ok("[3] the listener clears the once-per-browser flag", tour.includes("window.localStorage.removeItem(TOUR_FLAG)"));
ok(
  "[3] the listener re-applies the SAME guards as auto-arm (viewport + anchor)",
  /const onReplay = \(\) => \{[\s\S]*?if \(window\.innerWidth < 1024\) return;[\s\S]*?if \(rectOf\("quick-actions"\) === null\) return;[\s\S]*?\};/.test(tour),
);
ok("[3] replay resets to step 0 before arming", /setStepIndex\(0\);\s*\n\s*setActive\(true\);/.test(tour));
ok("[3] listener is registered + cleaned up on the replay event name", tour.includes('window.addEventListener(TOUR_REPLAY_EVENT, onReplay)') && tour.includes('window.removeEventListener(TOUR_REPLAY_EVENT, onReplay)'));
ok("[3] the welcome card dispatches through the exported helper (no internals)", card.includes("import { replayProductTour } from \"@/modules/shell/onboarding-tour\";") && card.includes("onClick={() => replayProductTour()}"));

// ---- [4] profile restore laws -------------------------------------------------------

const profile = read("../src/modules/settings/profile-view.tsx");

ok("[4] Me type carries the additive R108 field", /checklistDismissedAt\?: string \| null;/.test(profile));
ok(
  "[4] the row states are honest server facts (hidden/shown by checklistDismissedAt)",
  /me\?\.checklistDismissedAt \? t\("welcomeCardHidden"\) : t\("welcomeCardShown"\)/.test(profile),
);
ok(
  "[4] restore PATCHes false through the SAME saveMutation",
  profile.includes("saveMutation.mutate({ checklistDismissed: false })") &&
    /checklistDismissed\?: boolean;/.test(profile),
);
ok(
  "[4] restore has its OWN toast (not the generic savedToast)",
  /payload\.checklistDismissed === false && payload\.name === undefined && payload\.locale === undefined/.test(profile) &&
    profile.includes('t("welcomeCardRestoreToast")'),
);
ok("[4] restore invalidates the shared [\"me\"] cache (dashboard card reacts)", profile.includes('void queryClient.invalidateQueries({ queryKey: ["me"] });'));
ok("[4] restore button: testid + pending spinner honest", profile.includes('data-testid="welcome-restore"') && profile.includes("motion-reduce:animate-none"));

// ---- [5] usage glance laws -----------------------------------------------------------

const view = read("../src/modules/copilot/copilot-view.tsx");

ok(
  "[5] ONE shared usage query — mount-fetched, 60s stale, never retried",
  /queryKey: \["billing", "usage", "copilot"\],\s*\n\s*queryFn: \(\) => api\("\/api\/v1\/billing\/usage"\),\s*\n\s*staleTime: 60_000,\s*\n\s*retry: false,/.test(view) &&
    count(view, 'api("/api/v1/billing/usage")') === 1,
);
ok(
  "[5] §64 — meter derived ONLY from a real used+limit pair",
  /const meterRaw = usage\?\.metrics\?\.AI_REQUESTS;\s*\n\s*const meter =\s*\n\s*meterRaw &&\s*\n\s*typeof meterRaw\.used === "number" &&\s*\n\s*typeof meterRaw\.limit === "number"/.test(view),
);
ok(
  "[5] the glance chip rides the SAME meter as the dialog (one derivation, two surfaces)",
  count(view, "data-testid=\"copilot-usage-glance\"") === 1 &&
    count(view, "data-testid=\"copilot-regen-meter\"") === 1 &&
    view.includes("{meter ? ("),
);
ok(
  "[5] honest tone escalation: muted → amber ≥80% → destructive exhausted",
  /meter\.limit > 0 && meter\.used \/ meter\.limit >= 1/.test(view) &&
    /meter\.limit > 0 && meter\.used \/ meter\.limit >= 0\.8/.test(view) &&
    view.includes("border-destructive/40 bg-destructive/10 text-destructive") &&
    view.includes("border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"),
);
ok(
  "[5] ONE locale law: dayLocale hoisted ABOVE its first use + numFmt memoized on it",
  view.indexOf("const dayLocale = uiLocale === \"fa\" ? \"fa-IR\" : \"en-GB\";") <
    view.indexOf("const numFmt = useMemo(() => new Intl.NumberFormat(dayLocale), [dayLocale]);") &&
    view.includes("const numFmt = useMemo(() => new Intl.NumberFormat(dayLocale), [dayLocale]);"),
);
ok("[5] glance numbers ride numFmt (Persian digits on FA) — dialog + glance title + glance display = 3 sites", count(view, "numFmt.format(meter.used)") === 3 && count(view, "numFmt.format(meter.limit)") === 3);
ok("[5] glance chip title reuses regenerateMeter (no duplicate copy)", count(view, 't("regenerateMeter"') === 2);
ok(
  "[5] the composer counter keeps its amber ≥450 honesty + tabular classes",
  view.includes("input.length >= 450 && \"text-amber-600 dark:text-amber-400\"") &&
    view.includes("\"shrink-0 tabular-nums transition-colors\""),
);
ok(
  "[5] the footer right side is one shrink-0 cluster (glance + counter never wrap)",
  view.includes('<span className="flex shrink-0 items-center gap-2">'),
);

// ---- summary ---------------------------------------------------------------------

console.log(`\n== r140: ${passed} passed, ${failures.length} failed ==`);
if (failures.length > 0) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
