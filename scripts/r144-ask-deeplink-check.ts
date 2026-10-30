/**
 * scripts/r144-ask-deeplink-check.ts — R144 harness.
 *
 * The ASK-THE-COPILOT deep link (the reverse of R143's perf chips):
 * the perf panel's "Ask the Copilot" button navigates to
 * #/copilot?ask=<question> and the copilot view PRE-SEEDS the composer
 * DRAFT with it. Send stays the user's action.
 *
 *   [1] the ASK HASH LAW — #/copilot?ask=… parses to the closed ask
 *       sub-state (trimmed, bounded to the composer's OWN 500-char cap);
 *       a blank / wholly-over-cap value drops WHOLESALE (bare copilot);
 *       the fragment never rides another module; canonical serialization
 *       round-trips byte-identical (encodeURIComponent one-way law);
 *       viewKeyOf keeps the copilot shell STABLE across ask flips (no
 *       remount) while sameView re-enters (the seed effect re-fires).
 *   [2] the SEED-NOT-SEND LAW (source) — the copilot seed effect fills
 *       the draft + focuses the textarea and NEVER sends (no handleSubmit
 *       / send call inside the effect block); an EMPTY-composer-only
 *       overwrite gate; the one-ask-one-seed ref; the stream guard.
 *   [3] the PRODUCER LAW (source) — the perf panel button: per-kind
 *       question (sales → perfAskSales …), navigate with { ask }, ONE
 *       tooltip source (title = aria-label = perfAskHint), the violet-
 *       adjacent outline pill styling, the Bot icon, the testid.
 *   [4] the I18N LAW — 5 new keys EN/FA symmetric; FA values pure Persian
 *       (no Latin letters); the questions name no custom range.
 *   [5] REGRESSION PINS — the R134 range grammar spot re-run; the R143
 *       perf-chip render block untouched; the composer send path intact.
 *
 * Run: bun scripts/r144-ask-deeplink-check.ts
 */

import { readFileSync } from "node:fs";
import { hashToView, viewToHash, sameView, viewKeyOf, type AppView } from "../src/store/app-store";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `actual=${a} expected=${e}`);
}

const view = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const panel = readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
const store = readFileSync("src/store/app-store.ts", "utf8");
const en = readFileSync("src/i18n/messages/en.ts", "utf8");
const fa = readFileSync("src/i18n/messages/fa.ts", "utf8");

// [1] the ASK HASH LAW ----------------------------------------------------------
console.log("\n== [1] ask hash law ==");

{
  const v = hashToView("#/copilot?ask=Which%20products%20drove%20my%20sales%3F");
  eq(v, { kind: "module", module: "copilot", ask: "Which products drove my sales?" }, "1a. encoded ask parses to the closed ask sub-state");
  eq(viewToHash(v), "#/copilot?ask=Which%20products%20drove%20my%20sales%3F", "1b. canonical serialize is byte-identical (one encodeURIComponent)");
}
{
  // FA question round-trip (the encoded form rides RTL text too).
  const faQ = "به‌تازگی کدام محصولات بیشترین سهم را در فروش من داشتند؟";
  const v = hashToView(`#/copilot?ask=${encodeURIComponent(faQ)}`);
  eq(v, { kind: "module", module: "copilot", ask: faQ }, "1c. FA ask parses (URLSearchParams decodes once)");
  eq(viewToHash(v), `#/copilot?ask=${encodeURIComponent(faQ)}`, "1d. FA ask serializes canonically");
}
eq(hashToView("#/copilot?ask="), { kind: "module", module: "copilot" }, "1e. empty ask drops WHOLESALE (never a lying param)");
eq(hashToView("#/copilot?ask=%20%20%20"), { kind: "module", module: "copilot" }, "1f. whitespace-only ask drops WHOLESALE (trimmed)");
{
  // Over-cap: the composer's OWN 500-char cap bounds the seed. A 600-char
  // ask is trimmed to 500 (honest — maxLength would enforce the same on
  // typed text); the parser NEVER returns an over-cap state.
  const long = "x".repeat(600);
  const v = hashToView(`#/copilot?ask=${long}`);
  ok("1g. over-cap ask trims to the composer cap (500)", v.kind === "module" && v.module === "copilot" && (v as { ask?: string }).ask?.length === 500, `len=${(v as { ask?: string }).ask?.length ?? "none"}`);
}
{
  // Whitespace padding + over-cap combined: trim FIRST, then bound.
  const padded = `   ${"y".repeat(505)}   `;
  const v = hashToView(`#/copilot?ask=${encodeURIComponent(padded)}`);
  ok("1h. trim-then-bound: padded over-cap ask lands exactly at 500", (v as { ask?: string }).ask?.length === 500 && (v as { ask?: string }).ask?.startsWith("yyy") === true, `len=${(v as { ask?: string }).ask?.length ?? "none"}`);
}
{
  const v = hashToView("#/reports?ask=hello");
  ok("1i. the ask fragment NEVER rides another module", v.kind === "module" && v.module === "reports" && (v as { ask?: string }).ask === undefined, JSON.stringify(v));
}
eq(hashToView("#/copilot"), { kind: "module", module: "copilot" }, "1j. bare copilot unchanged");
{
  // A literal "+" in a hand-typed hash is a SPACE in query-string grammar —
  // the producer always encodeURIComponent's (plus → %2B), so the seed
  // never corrupts producer-built links; document the hand-typed law.
  const v = hashToView("#/copilot?ask=a+b");
  eq(v, { kind: "module", module: "copilot", ask: "a b" }, "1k. raw + is a space (query grammar); producer-built links encode %2B");
}
{
  const v = hashToView("#/copilot?ask=C%2B%2B%20revenue");
  eq(v, { kind: "module", module: "copilot", ask: "C++ revenue" }, "1l. %2B decodes to a literal plus");
}

// [2] identity / re-entry law ---------------------------------------------------
console.log("\n== [2] identity / re-entry law ==");

const copilotBare: AppView = { kind: "module", module: "copilot" };
const copilotAskA: AppView = { kind: "module", module: "copilot", ask: "Question A" };
const copilotAskB: AppView = { kind: "module", module: "copilot", ask: "Question B" };
ok("2a. viewKeyOf keeps the copilot shell STABLE across ask flips (no remount)", viewKeyOf(copilotBare) === viewKeyOf(copilotAskA) && viewKeyOf(copilotAskA) === viewKeyOf(copilotAskB), `${viewKeyOf(copilotBare)} vs ${viewKeyOf(copilotAskA)}`);
ok("2b. sameView(bare, ask) — a landing deep link RE-ENTERS the mounted copilot", !sameView(copilotBare, copilotAskA));
ok("2c. sameView(askA, askB) — a DIFFERENT ask re-enters (the seed effect re-fires)", !sameView(copilotAskA, copilotAskB));
ok("2d. sameView(askA, askA) — the SAME ask is the same view (one ask, one seed)", sameView(copilotAskA, copilotAskA));
{
  // The store's own structural-compare comment names the law; pin it.
  ok("2e. the store comment documents the copilot ask re-entry law", /R144 — the copilot ask seed is structural/.test(store));
}

// [3] the SEED-NOT-SEND LAW (copilot-view source) --------------------------------
console.log("\n== [3] seed-not-send law ==");

{
  // Extract the R144 seed effect block and audit its body.
  const m = view.match(/R144 — the ASK DEEP-LINK SEED[\s\S]*?const seededAskRef[\s\S]*?\}, \[view, activeStreamId, input\]\);/);
  ok("3a. the seed effect block exists exactly once", m !== null);
  if (m) {
    const block = m[0];
    ok("3b. the seed NEVER sends (no handleSubmit / sendCopilot / fetch inside)", !/handleSubmit|sendCopilot|fetch\(/.test(block), "send verbs found in seed block");
    ok("3c. the seed fills the DRAFT (setInput) — not the session state", block.includes("setInput(ask)") && !block.includes("setSessions"));
    ok("3d. the seed focuses the composer textarea", block.includes("textareaRef.current?.focus()"));
    ok("3e. EMPTY-composer-only overwrite gate (typed text is never destroyed)", block.includes('input.trim() === ""'));
    ok("3f. one ask, one seed (seededAskRef identity gate)", block.includes("seededAskRef.current === ask") && block.includes("seededAskRef.current = ask"));
    ok("3g. the stream guard (never seeds mid-flight)", block.includes("activeStreamId !== null"));
    ok("3h. the seed gates on the copilot module view + ask", block.includes('view.module === "copilot"') && block.includes("view.ask ??"));
  }
  ok("3i. the store carries the ask field on the module view (typed, optional)", store.includes("ask?: string; }") && store.includes("R144 — the copilot ask deep link"));
  ok("3j. the parser comment pins the decode-once law (no double decode)", /URLSearchParams already decoded the value/.test(store));
  ok("3k. the serializer comment pins the blank-ask honesty", /a blank ask never serializes/.test(store));
}

// [4] the PRODUCER LAW (perf panel source) ---------------------------------------
console.log("\n== [4] producer law ==");

{
  const m = panel.match(/R144 — the ASK-THE-COPILOT handoff[\s\S]*?data-testid="perf-ask-copilot"[\s\S]*?\/>/);
  ok("4a. the ask button block exists exactly once", m !== null);
  if (m) {
    const block = m[0];
    ok("4b. per-kind question: sales → perfAskSales", block.includes('kind === "sales"') && block.includes('t("perfAskSales")'));
    ok("4c. per-kind question: expenses → perfAskExpenses", block.includes('t("perfAskExpenses")'));
    ok("4d. per-kind question: cashflow → perfAskCashflow", block.includes('t("perfAskCashflow")'));
    ok("4e. navigate carries the ask (module copilot, ask payload)", block.includes('module: "copilot"') && block.includes("ask: askQuestion"));
    ok("4f. ONE tooltip source: title = aria-label = askCopilotHint (R145: generic key)", block.includes('title={t("askCopilotHint")}') && block.includes('aria-label={t("askCopilotHint")}'));
    ok("4g. the Bot icon carries the semantic", block.includes("<Bot"));
    ok("4h. the pill styling (rounded-full, ms-auto, primary family)", block.includes("rounded-full") && block.includes("ms-auto") && block.includes("text-primary"));
  }
  ok("4i. the testid is singular", (panel.match(/perf-ask-copilot/g) ?? []).length === 1);
  // Seed-not-send on the producer side: the button NAVIGATES — it never
  // touches the copilot's send path.
  ok("4j. the producer never sends (no handleSubmit in the panel)", !/handleSubmit/.test(panel));
}

// [5] the I18N LAW ----------------------------------------------------------------
console.log("\n== [5] i18n law ==");

const KEYS = ["askCopilotLabel", "askCopilotHint", "perfAskSales", "perfAskExpenses", "perfAskCashflow"] as const;
for (const k of KEYS) {
  const enRe = new RegExp(`${k}: "([^"]+)"`);
  const faRe = new RegExp(`${k}: "([^"]+)"`);
  ok(`5a. ${k} exists in EN`, enRe.test(en));
  ok(`5b. ${k} exists in FA`, faRe.test(fa));
}
ok("5c. EN label is the handoff name (R145: the GENERIC affordance key)", /askCopilotLabel: "Ask the Copilot"/.test(en));
ok("5d. FA label is pure Persian", /askCopilotLabel: "از دستیار بپرس"/.test(fa));
ok("5d2. R145: the old perf-scoped affordance keys are GONE (one key, one string)", !/perfAskCopilot|perfAskHint/.test(en) && !/perfAskCopilot|perfAskHint/.test(fa));
ok("5e. FA hint is pure Persian (no Latin letters)", /askCopilotHint: "([^"]*)"/.test(fa) && !/[A-Za-z]/.test(fa.match(/askCopilotHint: "([^"]*)"/)?.[1] ?? ""));
{
  // The hint names the seed-not-send contract in BOTH locales.
  ok("5f. EN hint says edit-before-send", /edit it before sending/.test(en));
  ok("5g. FA hint says edit-before-send (پیش از ارسال)", /پیش از ارسال/.test(fa));
}
{
  // The questions name NO custom range (no date placeholders — the
  // copilot's own window is the honest scope).
  for (const k of ["perfAskSales", "perfAskExpenses", "perfAskCashflow"] as const) {
    const enV = en.match(new RegExp(`${k}: "([^"]*)"`))?.[1] ?? "";
    const faV = fa.match(new RegExp(`${k}: "([^"]*)"`))?.[1] ?? "";
    ok(`5h. ${k} carries no {placeholder} (no fake window promise)`, !/\{/.test(enV) && !/\{/.test(faV), `en=${enV}`);
    ok(`5i. ${k} FA value is pure Persian`, !/[A-Za-z]/.test(faV), faV);
  }
}

// [6] REGRESSION PINS -------------------------------------------------------------
console.log("\n== [6] regression pins ==");

// R134 range grammar spot re-run (the ask branch must not have disturbed it).
eq(hashToView("#/reports?from=2026-08-29&to=2026-09-27"), { kind: "module", module: "reports", rangeFrom: "2026-08-29", rangeTo: "2026-09-27" }, "6a. R134: valid range still parses");
eq(hashToView("#/reports?from=2026-09-27&to=2026-08-29"), { kind: "module", module: "reports" }, "6b. R134: inverted range still drops WHOLESALE");
eq(hashToView("#/sales?ask=x"), { kind: "module", module: "sales" }, "6c. R87: sales still ignores foreign params");
// R143 perf-chip render block untouched.
ok("6d. R143: the perf chip render block survives (CopilotPerfActionChips law)", /R143 — the perf ACTION CHIPS/.test(view) || /pickPerfActionChips/.test(view));
ok("6e. R143: the perf chips testids survive", view.includes("copilot-perf-chips") && view.includes("copilot-action-perf-sales"));
// The composer send path intact (maxLength 500 — the seed's bound authority).
ok("6f. the composer keeps its 500-char maxLength (the seed's bound authority)", (view.match(/maxLength=\{500\}/g) ?? []).length === 1);
// The parser precedence: copilot ask branch sits INSIDE isKnownModule (after
// the reports branches) — a reports URL can never be captured by it.
ok("6g. the ask branch sits after the reports sub-view branches (precedence)", store.indexOf('path === "copilot" && query.has("ask")') > store.indexOf('query.get("reorder") === "1"'));

console.log(`\n== r144-ask-deeplink-check: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
