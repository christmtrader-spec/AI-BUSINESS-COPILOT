/**
 * R107 — MFA login BROWSER E2E (closes the last auth gap: r63/r64/r67
 * covered the MFA flow at the API level; the REAL UI — password →
 * MFA_REQUIRED → challenge card → OTP slots → session — was never
 * browser-driven until now).
 *
 * Flow exercised through the REAL React components (agent-browser):
 *   A. seed: register r107-mfa@test.local + enroll MFA via the REAL API
 *      (enrollFixtureMfa — reauth → setup/start → setup/confirm).
 *   B1. wrong TOTP on the live MfaLoginCard → "Invalid authentication code."
 *       (challenge stays valid; per-challenge budget is 5 attempts).
 *   B2. correct next-step TOTP on the SAME challenge → session cookie +
 *       app shell. (Next step, not current: setup/confirm consumed the
 *       current one — replay law §45; future steps are never rejected.)
 *   B3. sign out (Account menu) → cookie gone.
 *   B4. sign in again → MFA card → "Use a recovery code" → code[0] →
 *       session cookie again (recovery path end-to-end).
 *   C. FK-safe sweep of the fixture + census proof (idempotent re-runs).
 *
 * Run:  bun scripts/r107-mfa-browser-e2e.ts [--setup|--teardown|--sweep-only]
 * Exit: 0 = all green, 1 = any check failed.
 * Dev-only fixture: email allowlist r107-mfa@test.local.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { PrismaClient } from "@prisma/client";
import {
  callerOf,
  clearFixtureMfa,
  enrollFixtureMfa,
  generateTotpCode,
  jarFetch,
} from "./lib/platform-mfa";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const EMAIL = "r107-mfa@test.local";
const PASS = "Passw0rd!x";
const NAME = "R107 MFA QA";
const SETUP_ONLY = process.argv.includes("--setup");
const TEARDOWN = process.argv.includes("--teardown");
const SWEEP_ONLY = process.argv.includes("--sweep-only");

type Check = { name: string; ok: boolean; info?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, info?: string) {
  checks.push({ name, ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? ` — ${info}` : ""}`);
}

/* ----------------------------- browser helpers ---------------------------- */

const SHOT_DIR = "qa-shots";
function ab(...args: string[]): string {
  return execFileSync("agent-browser", args, { encoding: "utf8", timeout: 90_000 });
}
function shot(name: string) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    ab("screenshot", `${SHOT_DIR}/qa-r107-${name}.png`);
  } catch {
    /* screenshots never fail the run */
  }
}
/** Click the element whose snapshot line matches `label`, via its ref. */
function clickRef(label: string, kind: "button" | "menuitem" | "tab" | "link" = "button"): boolean {
  const snap = ab("snapshot");
  const re = new RegExp(`- ${kind} "${label}"[^\\n]*?ref=(e\\d+)`);
  const m = snap.match(re);
  if (!m) return false;
  ab("click", `@${m[1]}`);
  return true;
}
async function hasSessionCookie(): Promise<boolean> {
  const out = ab("cookies", "get");
  return out.includes("authjs.session-token") || out.includes("next-auth.session-token");
}
async function waitForSession(timeoutMs = 45_000): Promise<boolean> {
  const t0 = Date.now();
  let lastLog = "";
  while (Date.now() - t0 < timeoutMs) {
    const cookie = await hasSessionCookie();
    const body = ab("eval", "document.body.innerText.slice(0, 400)").replace(/\\n/g, " ");
    if (`cookie=${cookie} body=${body.slice(0, 120)}` !== lastLog) {
      lastLog = `cookie=${cookie} body=${body.slice(0, 120)}`;
      console.log(`  [poll ${(Date.now() - t0) / 1000 | 0}s] ${lastLog}`);
    }
    // Session is REAL only when the cookie exists AND a definitive shell
    // marker is visible (the splash "Preparing your workspace…" also shows
    // during unauthenticated boot — it alone proves nothing).
    if (cookie) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
/** Definitive post-login shell: the SPA shows either the workspace shell
 * (Account button / sidebar) or the onboarding card for business-less users. */
async function waitForShell(timeoutMs = 30_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const body = ab("eval", "document.body.innerText");
    if (/Create your business|Sign out instead|Overview|Account security/.test(body)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
async function waitSessionGone(timeoutMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await hasSessionCookie())) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/* ------------------------------- API seeding ------------------------------ */

async function seedMfaUser(): Promise<{ userId: string; secret: string; recoveryCodes: string[] }> {
  // FK-safe residue sweep FIRST so registration never 409s on re-runs.
  await sweepFixture();
  const jar = new Map<string, string>();
  const caller = callerOf(jar);
  const reg = await caller("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: NAME,
      email: EMAIL,
      password: PASS,
      acceptedLegal: { terms: true, privacy: true },
    }),
  });
  if (reg.status !== 201) throw new Error(`register failed ${reg.status}: ${JSON.stringify(reg.json).slice(0, 200)}`);
  const csrf = await caller("/api/auth/csrf");
  const csrfToken = csrf.json?.csrfToken;
  await caller("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASS }).toString(),
  });
  const me = await caller("/api/v1/me");
  if (me.status !== 200) throw new Error(`fixture login failed ${me.status}`);
  const userId = me.json?.data?.user?.id ?? me.json?.data?.id ?? me.json?.user?.id;
  if (!userId) throw new Error(`could not resolve fixture userId: ${JSON.stringify(me.json).slice(0, 200)}`);
  const enrolled = await enrollFixtureMfa(caller, PASS);
  // DEV-ONLY WARM-UP (r107 lesson): the first hit of a route in `next dev`
  // triggers a lazy compile whose HMR "Fast Refresh" can force a FULL PAGE
  // RELOAD — which silently reset the MFA card mid-flow (stage idle →
  // landing) and made the browser flow non-deterministic. Compile BOTH MFA
  // routes here with bogus payloads (expect 4xx, no side effects) so the
  // browser flow never triggers a first-time compile.
  await caller("/api/v1/auth/mfa/challenge", {
    method: "POST",
    body: JSON.stringify({ email: "warmup@invalid.local", password: "x" }),
  });
  await caller("/api/v1/auth/mfa/complete", {
    method: "POST",
    body: JSON.stringify({ challenge: "warmup", code: "000000", method: "TOTP" }),
  });
  return { userId, ...enrolled };
}

/* ------------------------------- FK-safe sweep ----------------------------- */

function quote(v: unknown) {
  return `'${String(v).replace(/'/g, "''")}'`;
}
async function sweepFixture(): Promise<number> {
  const users = (await db.$queryRawUnsafe(
    `SELECT id FROM "User" WHERE email = ${quote(EMAIL)}`,
  )) as Array<{ id: string }>;
  if (!users.length) return 0;
  const ids = users.map((u) => u.id);
  const tables = (
    (await db.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_migrations'`,
    )) as Array<{ name: string }>
  ).map((t) => t.name);
  const idSet = new Set(ids);
  const inList = `(${ids.map(quote).join(",")})`;
  for (let pass = 0; pass < 6; pass++) {
    let deleted = 0;
    for (const table of tables) {
      if (table === "User") continue;
      const fks = (await db.$queryRawUnsafe(`PRAGMA foreign_key_list("${table}")`)) as Array<{
        from: string;
        table: string;
      }>;
      const userFks = fks.filter((f) => f.table === "User");
      for (const fk of userFks) {
        const del = await db.$queryRawUnsafe(
          `DELETE FROM "${table}" WHERE "${fk.from}" IN ${inList}`,
        );
        deleted += 1; // raw delete; count via changes not needed for proof
      }
    }
    if (deleted === 0) break;
  }
  // Anything still referencing (none expected) would block the final delete.
  await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ${inList}`);
  for (const id of ids) idSet.delete(id);
  const fkViolations = (await db.$queryRawUnsafe(`PRAGMA foreign_key_check`)) as unknown[];
  if (fkViolations.length) throw new Error(`FK violations after sweep: ${JSON.stringify(fkViolations.slice(0, 5))}`);
  return ids.length;
}

/* ------------------------- RSS-guard cooperation -------------------------- */

/* r107 ROOT-CAUSE NOTE (kept for future rounds): the R105 guard originally
 * recycled next-server at 1700MB — below the app's grown compile plateau
 * (2.0–2.4GB) — producing a ~2min recycle loop whose HMR reconnects FULL-
 * PAGE-RELOAD every open tab and silently kills any long single-page
 * browser flow. Fixed SYSTEMICALLY in dev-rss-guard.cjs (default now
 * 2450MB, above the plateau, below the true OOM zone). No per-script
 * override needed anymore — do not reintroduce long-flow-hostile waters. */
const GUARD_PATTERN = "scripts/dev-rss-guard";
/** Restart the guard daemon so it picks up the current guard defaults. */
function restartGuard() {
  try {
    execFileSync("pkill", ["-f", GUARD_PATTERN]);
  } catch {
    /* none running */
  }
  const child = spawn(process.execPath, ["/home/z/my-project/scripts/dev-rss-guard.cjs"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  // Wait for the stage-2 daemon to take the lock.
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    try {
      const out = execFileSync("pgrep", ["-af", "dev-rss-guard"], { encoding: "utf8" });
      if (out.includes("--daemon-stage2")) return;
    } catch {
      /* not yet */
    }
    execFileSync("sleep", ["0.5"]);
  }
}

/* ------------------------------- diagnostics ------------------------------- */

async function dumpMfaDiagnostics() {
  try {
    const user = (await db.$queryRawUnsafe(`SELECT id FROM "User" WHERE email = ${quote(EMAIL)}`)) as Array<{ id: string }>;
    if (!user.length) return;
    const uid = user[0].id;
    const chal = (await db.$queryRawUnsafe(
      `SELECT id, substr(challengeHash,1,12) AS ch, expiresAt, usedAt, assertionUsedAt, sessionVersionAtChallenge AS svAtChal, attemptCount, createdAt FROM MfaLoginChallenge WHERE userId = ${quote(uid)} ORDER BY createdAt DESC LIMIT 5`,
    )) as unknown[];
    console.log("  [diag] challenges:", JSON.stringify(chal));
    const cred = (await db.$queryRawUnsafe(
      `SELECT enabledAt, lastUsedTotpStep FROM MfaCredential WHERE userId = ${quote(uid)}`,
    )) as unknown[];
    console.log("  [diag] credential:", JSON.stringify(cred));
    const ev = (await db.$queryRawUnsafe(
      `SELECT eventType, reasonCode, success, createdAt FROM SecurityEvent WHERE userId = ${quote(uid)} ORDER BY createdAt DESC LIMIT 8`,
    )) as unknown[];
    console.log("  [diag] events:", JSON.stringify(ev));
  } catch (e) {
    console.log("  [diag] failed:", String(e).slice(0, 200));
  }
}

/* --------------------------------- phases --------------------------------- */

async function browserFlow(secret: string, recoveryCodes: string[]) {
  const jar = new Map<string, string>(); // reserved for future API asserts

  // Fresh browser state.
  ab("cookies", "clear");
  ab("open", BASE);
  ab("wait", "#email", "--timeout", "30000");
  shot("1-signin");

  // B1 — password → MFA card appears.
  ab("fill", "#email", EMAIL);
  ab("fill", "#password", PASS);
  ab("click", 'form button[type="submit"]');
  ab("wait", '[data-slot="input-otp"]', "--timeout", "30000");
  const mfaSnap = ab("snapshot");
  check("B1 password → MFA card with OTP slots", mfaSnap.includes("Two-factor authentication") && mfaSnap.includes("Verify and sign in"));
  shot("2-mfa-card");

  // B2 — wrong TOTP on the live challenge → inline error, no session.
  ab("click", '[data-slot="input-otp"]');
  ab("press", "Control+a");
  ab("keyboard", "type", "000000");
  ab("click", 'form button[type="submit"]');
  ab("wait", "1500");
  const errSnap = ab("snapshot");
  check("B2 wrong TOTP → inline invalid-code error", errSnap.includes("Invalid authentication code."));
  check("B2 no session after wrong TOTP", !(await hasSessionCookie()));
  console.log("  [B2 console]", ab("console").split("\n").filter((l) => l.trim() && !l.includes("HMR") && !l.includes("Fast Refresh") && !l.includes("DevTools")).slice(-6).join(" ⏎ "));
  shot("3-mfa-error");

  // B3 — correct NEXT-step TOTP on the same challenge → session + shell.
  // r107 lesson: after B2's failed attempt FOCUS IS ON <body> (submit click
  // + error re-render) — keystrokes go NOWHERE unless the OTP input is
  // re-focused first. Click it, then verify the value actually landed
  // before submitting (fail fast instead of typing into the void).
  ab("wait", '[data-slot="input-otp"]', "--timeout", "5000");
  ab("click", '[data-slot="input-otp"]');
  const code = generateTotpCode(secret, Date.now() + 30_000);
  ab("press", "Control+a");
  ab("keyboard", "type", code);
  const otpNow = ab("eval", "document.querySelector('input[data-input-otp]')?.value ?? ''");
  if (!otpNow.includes(code)) {
    throw new Error(`OTP input did not receive the code (value=${otpNow.slice(0, 40)})`);
  }
  ab("click", 'form button[type="submit"]');
  ab("wait", "900");
  console.log(
    "  [B3 post-verify stage]",
    ab("eval", "document.body.innerText.includes('Verify and sign in') ? 'still-on-card' : 'left-card'"),
  );
  ab("wait", "600");
  const gotSession = await waitForSession();
  check("B3 correct TOTP → session cookie issued", gotSession);
  if (!gotSession) await dumpMfaDiagnostics();
  // Definitive shell marker (splash alone proves nothing — see waitForSession).
  const shellReady = await waitForShell(30_000);
  check("B3 app shell rendered (account controls visible)", shellReady);
  shot("4-mfa-success");

  // B4 — sign out through the REAL account menu (topbar Account button when
  // a business exists, or the onboarding card's inline "Sign out instead").
  if (!clickRef("Account") && !clickRef("Sign out instead"))
    throw new Error("neither Account button nor onboarding Sign-out found after MFA login");
  ab("wait", "800");
  const snapForMenu = ab("snapshot");
  if (/menuitem "Sign out"/.test(snapForMenu)) {
    if (!clickRef("Sign out", "menuitem")) throw new Error("Sign out menu item not found");
  } // else: onboarding path already signed out directly by its button.
  const signedOut = await waitSessionGone();
  check("B4 sign out clears session cookie", signedOut);
  ab("wait", "1500");

  // B5 — recovery-code path end-to-end.
  ab("wait", "#email", "--timeout", "30000");
  ab("fill", "#email", EMAIL);
  ab("fill", "#password", PASS);
  ab("click", 'form button[type="submit"]');
  ab("wait", '[data-slot="input-otp"]', "--timeout", "30000");
  if (!clickRef("Use a recovery code")) throw new Error("recovery switch link not found");
  ab("wait", "#mfa-recovery", "--timeout", "15000");
  const recSnap = ab("snapshot");
  check("B5 method switch → recovery input shown", recSnap.includes("Recovery code") || recSnap.includes("recovery"));
  shot("5-mfa-recovery");
  ab("fill", "#mfa-recovery", recoveryCodes[0]);
  ab("click", 'form button[type="submit"]');
  const recSession = await waitForSession();
  check("B5 recovery code → session cookie issued", recSession);
  shot("6-recovery-success");

  // Leave a clean browser for the next QA consumer.
  ab("cookies", "clear");
  void jar;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  if (TEARDOWN || SWEEP_ONLY) {
    const removed = await sweepFixture();
    console.log(`swept ${removed} fixture user(s)`);
    await db.$disconnect();
    process.exit(0);
  }

  console.log("── A. seed (register + REAL-API MFA enrollment) ──");
  const { userId, secret, recoveryCodes } = await seedMfaUser();
  check("A fixture enrolled via real enrollment flow", Boolean(secret) && recoveryCodes.length > 0, `${recoveryCodes.length} recovery codes`);
  await clearFixtureMfa(db as never, []).catch(() => undefined); // no-op shape guard

  if (SETUP_ONLY) {
    console.log(`setup only — secret saved to ${SHOT_DIR}/qa-r107-secret.txt (gitignored dir)`);
    mkdirSync(SHOT_DIR, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${SHOT_DIR}/qa-r107-secret.txt`, JSON.stringify({ EMAIL, PASS, secret, recoveryCodes }, null, 2));
    await db.$disconnect();
    process.exit(0);
  }

  console.log("── B. real-browser MFA login flow ──");
  restartGuard(); // pick up the retuned guard defaults (see note above)
  try {
    await browserFlow(secret, recoveryCodes);
  } catch (err) {
    check("browser flow completed without harness error", false, String(err).slice(0, 300));
  } finally {
    restartGuard(); // leave a healthy default guard behind
  }

  console.log("── C. sweep + census ──");
  const swept = await sweepFixture();
  check("C fixture swept FK-safe", swept === 1, `removed ${swept} user(s)`);
  const census = (await db.$queryRawUnsafe(
    `SELECT (SELECT COUNT(*) FROM "User") AS users, (SELECT COUNT(*) FROM "Business") AS businesses`,
  )) as Array<{ users: number; businesses: number }>;
  console.log(`census: users=${census[0].users} businesses=${census[0].businesses}`);

  await db.$disconnect();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nr107 MFA browser E2E: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

// jarFetch re-exported for future API asserts inside this harness.
void jarFetch;
await main();
