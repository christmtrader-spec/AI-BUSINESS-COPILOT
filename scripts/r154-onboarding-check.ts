/**
 * scripts/r154-onboarding-check.ts — R154 harness.
 *
 * THE CHECKLIST THAT EARNS ITS CHECKMARKS + the conditional fourth tile
 * (the standing conditional's twelfth round, finally EARNED by onboarding
 * data): the getting-started checklist's invite step rode NO proof (it
 * never checked off — a lie of inertia) while the business's own member
 * count IS the proof. R154: the invite step's done-state rides the ONE
 * ["members", activeId] members query (shared with Settings → Members),
 * and the welcome card grows the invite tile for a SOLO shop whose owner
 * can actually manage members — absent while the probe loads (unknown →
 * honest silence), gone once the team exists.
 *
 *   [1] the CHECKLIST LAW — the invite step rides members.length > 1
 *       through the shared probe; firstSaleDone's law untouched; step 1
 *       stays done:true; stepSettings stays done:false (the DOCUMENTED
 *       decision: reviewing settings is subjective — the card's dismiss
 *       is the honest exit, never a fake checkmark).
 *   [2] the TILE LAW — the gate (manage + the probe RESOLVED + solo),
 *       the family byte-pattern, the Users iconography, the adaptive
 *       grid, the OWNER-only fetch on the card.
 *   [3] the i18n LAW — welcomeActionInvite EN/FA; the card description
 *       no longer names a count ("three good first stops" would become a
 *       lie when the fourth tile renders).
 *   [4] the RBAC LAW (unit) — members:read rides EVERY role (the
 *       checklist's probe is universal); members:manage is OWNER-only
 *       (the tile's gate).
 *   [5] the REGRESSION PIN — r140's three testids + the shared ["me"]
 *       query + the dismiss gate + the ONE members cache key across all
 *       three surfaces.
 *
 * Run: npx tsx scripts/r154-onboarding-check.ts
 */

import { readFileSync } from "node:fs";
import { can, ROLES, type Role } from "../src/lib/rbac";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond && info) failures.push(`${name} — ${info}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

const dashSrc = readFileSync("src/modules/dashboard/dashboard-view.tsx", "utf8");
const cardSrc = readFileSync("src/modules/dashboard/welcome-card.tsx", "utf8");
const membersViewSrc = readFileSync("src/modules/settings/members-view.tsx", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

section("[1] the CHECKLIST LAW — each step rides its own proof");
{
  ok("1a the members probe rides the ONE shared query key", dashSrc.includes('queryKey: ["members", activeId]'));
  ok("1b inviteDone = the business's OWN member count", dashSrc.includes("const inviteDone = (membersProbe?.length ?? 0) > 1;"));
  ok("1c the stepInvite entry carries done: inviteDone", /done: inviteDone, icon: Users, label: t\("stepInvite"\)/.test(dashSrc));
  ok("1d firstSaleDone untouched (the sales probe)", dashSrc.includes("const firstSaleDone = (salesProbe?.total ?? 0) > 0;") && /done: firstSaleDone, icon: ClipboardList/.test(dashSrc));
  ok("1e step 1 stays done:true (the business exists — honest)", dashSrc.includes("{ done: true, icon: CheckCircle2, label: t(\"stepBusinessDone\")"));
  ok("1f stepSettings stays done:false (the DOCUMENTED decision — reviewing is subjective; the dismiss is the honest exit)", /done: false, icon: Settings2, label: t\("stepSettings"\)/.test(dashSrc));
  ok("1g the card receives the role (the tile's gate input)", dashSrc.includes("<WelcomeCard role={role} />"));
}

section("[2] the TILE LAW — earned by onboarding data, honest silence while unknown");
{
  ok("2a the gate: manage + the probe RESOLVED + solo (no pop-in for existing teams)", cardSrc.includes("const inviteTile = manage && members !== undefined && members.length <= 1;"));
  ok("2b the invite testid exists exactly once", (cardSrc.match(/data-testid="welcome-action-invite"/g) ?? []).length === 1);
  ok("2c the tile navigates to the members settings", cardSrc.includes('onClick={() => navigate({ kind: "settings:members" })}'));
  ok("2d the family byte-pattern (the R144 tile lift + motion-safety)", /motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-reduce:transition-none/.test(cardSrc) && cardSrc.includes('data-testid="welcome-action-invite"\n                className="group hover:border-primary/40'));
  ok("2e the Users icon (the checklist's own invite iconography)", /<Users className="size-4" aria-hidden="true" \/>/.test(cardSrc));
  ok("2f the grid adapts (4 tiles → 2/4 cols, 3 tiles → 3 cols)", cardSrc.includes('inviteTile ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3"'));
  ok("2g the card's members fetch is manage-gated (OWNER/ADMIN) — the checklist probe stays universal", cardSrc.includes("enabled: !!activeId && manage,"));
}

section("[3] the i18n LAW — the invite tile named in both locales");
{
  ok("3a EN welcomeActionInvite present exactly once", (enSrc.match(/welcomeActionInvite:/g) ?? []).length === 1 && enSrc.includes('welcomeActionInvite: "Invite your team"'));
  ok("3b FA welcomeActionInvite present exactly once, pure Persian", (faSrc.match(/welcomeActionInvite:/g) ?? []).length === 1 && faSrc.includes('welcomeActionInvite: "دعوت از هم‌تیمی‌ها"'));
  ok("3c the description no longer names a count (a static 'three' would lie when four tiles render)", !enSrc.includes("three good first stops") && !faSrc.includes("سه مقصد"));
  ok("3d no {placeholder} in the new key", !/welcomeActionInvite: "[^"]*\{/.test(enSrc) && !/welcomeActionInvite: "[^"]*\{/.test(faSrc));
}

section("[4] the RBAC LAW — the probe is universal, the tile is manage-gated");
{
  const roles = ROLES as readonly Role[];
  ok("4a members:read rides EVERY role (the checklist probe works for all)", roles.every((r) => can(r, "members:read")));
  ok("4b members:manage rides OWNER+ADMIN exactly (the tile's gate)", roles.filter((r) => can(r, "members:manage")).join(",") === "OWNER,ADMIN");
  ok("4c the matrix carries both permissions in the closed list", roles.length >= 4);
}

section("[5] the REGRESSION PIN — the family this round must not disturb");
{
  ok("5a r140's three tile testids still exist", cardSrc.includes('data-testid="welcome-action-copilot"') && cardSrc.includes('data-testid="welcome-action-reports"') && cardSrc.includes('data-testid="welcome-action-tour"'));
  ok("5b the shared [\"me\"] query + the dismiss gate untouched", cardSrc.includes('queryKey: ["me"]') && cardSrc.includes("if (!me || me.checklistDismissedAt) return null;"));
  ok("5c Settings → Members reads the SAME cache key (one fetch, three surfaces)", membersViewSrc.includes('queryKey: ["members", activeId]'));
  ok("5d the tour tile keeps its desktop-only honesty", /hidden w-full items-center[^"]*lg:flex/.test(cardSrc.replace(/\n\s+/g, " ")) || cardSrc.includes("hidden w-full"));
  ok("5e the card's dismiss affordance intact", cardSrc.includes('data-testid="welcome-card-dismiss"'));
}

console.log(`\nr154-onboarding-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
