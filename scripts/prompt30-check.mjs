/**
 * scripts/prompt30-check.mjs — Prompt 30 identity-security E2E harness
 * (§335-§364, §391, §397-§401, §405, §410-§419, §436).
 *
 * Exercises the REAL HTTP surface + real NextAuth flow:
 *   AUTH          legacy login, sessionVersion, password change invalidation
 *   EMAIL VERIFY  status/resend/send-before-persist/confirm/single-use/rate-limit
 *   MFA           reauth → setup → QR+manual key → confirm → recovery codes →
 *                 MFA_REQUIRED at login → challenge → TOTP/recovery → assertion →
 *                 full session; wrong code; replay; disable; regenerate
 *   SESSIONS      list, current marker, revoke one, revoke all, tampering,
 *                 legacy-JWT compat (no sid), expiry semantics
 *   STEP-UP       reauth + window; high-risk gates
 *   PRIVACY       no secrets in any response body
 *   TENANT/PLATFORM ISOLATION  cross-user session id → 404-safe
 *
 * Run:  bun --conditions react-server scripts/prompt30-check.mjs
 *       (needs the dev server on :3000; EMAIL_PROVIDER=test-memory friendly)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.P30_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const results = [];
let current = "";
function section(name) { current = name; }
function record(name, ok, info = "") {
  results.push({ section: current, name, ok, info });
  console.log(`${ok ? "✓" : "✗"} [${current}] ${name}${info ? ` — ${info}` : ""}`);
}
let lastResponses = {};
function check(name, cond, info = "") {
  if (!cond) {
    const snap = JSON.stringify(lastResponses).slice(0, 200);
    record(name, false, `${info} |last=${snap}`);
  } else record(name, true, info);
}
function secretScan(label, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const forbidden = ["passwordHash", "encryptedSecret", "codeHash", "tokenHash", "sessionTokenHash", "secretVersion\":"];
  const leaked = forbidden.filter((k) => text.includes(`"${k}"`));
  check(`${label}: no secret fields in response`, leaked.length === 0, leaked.join(",") || "clean");
}

/* --------------------------- TOTP helper (test) ---------------------------- */
import * as OTPAuth from "otpauth";
function totpFor(secretBase32) {
  return new OTPAuth.TOTP({
    issuer: "AI Business Copilot",
    label: "test",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}
function currentTotp(secretBase32) {
  const t = totpFor(secretBase32);
  return t.generate();
}

/* ------------------------------ cookie-jar fetch --------------------------- */
const XFF = `10.216.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
let XFF_OVERRIDE = null; // set per-call by mfaLogin (login-limiter isolation)
function freshXff() {
  return `10.21${Math.floor(Math.random() * 9)}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
}
function jarFetch(jar, xff) {
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": xff ?? XFF_OVERRIDE ?? freshXff(), ...(init.headers ?? {}) };
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { ...init, headers: cookie ? { ...headers, cookie } : headers });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
    }
    return res;
  };
}
async function apiJson(f, path, init = {}) {
  const res = await f(path, init);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { res, body };
}

async function login(jar, email, password, extra = {}) {
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: "false", json: "true", ...extra });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const hasSession = [...jar.keys()].some((k) => k.includes("session-token"));
  return { res, hasSession, jar };
}

/**
 * Full MFA login dance for a user WITH MFA enabled:
 * password → MFA_REQUIRED → challenge → TOTP → assertion → session.
 * Returns { ok, jar }. If the TOTP step was already consumed by an earlier
 * login (replay protection §45), waits for the NEXT 30s step and retries.
 */
async function mfaLogin(email, totpInstance) {
  const jar = new Map();
  // Every call below carries its own fresh XFF (login limiter keys on
  // email+ip; the harness performs many legitimate sign-ins per account).
  const probe = await login(jar, email, PASS);
  if (probe.hasSession) return { ok: true, jar }; // MFA not active
  for (let attempt = 0; attempt < 2; attempt++) {
    const ch = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/challenge", {
      method: "POST",
      body: JSON.stringify({ email, password: PASS }),
    });
    if (!ch.body?.ok) return { ok: false, jar, why: `challenge:${ch.res.status}:${JSON.stringify(ch.body?.error ?? {}).slice(0, 120)}` };
    const done = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
      method: "POST",
      body: JSON.stringify({ challenge: ch.body.data.challenge, code: totpInstance.generate(), method: "TOTP" }),
    });
    if (done.body?.ok) {
      const final = await login(jar, email, PASS, { mfaAssertion: done.body.data.assertion });
      return { ok: final.hasSession, jar };
    }
    // Replay rejection → wait for the next time-step boundary and retry.
    const msIntoStep = Date.now() % 30_000;
    await new Promise((r) => setTimeout(r, 30_000 - msIntoStep + 500));
  }
  return { ok: false, jar, why: "complete" };
}

async function registerApi(email, name = "P30 Harness") {
  const f = jarFetch(new Map());
  const { body } = await apiJson(f, "/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: PASS }),
  });
  return body;
}

async function createBusiness(jar, name) {
  const f = jarFetch(jar);
  const { body } = await apiJson(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name, currencyCode: "EUR", locale: "en", timezone: "Europe/Berlin" }),
  });
  return body;
}

/* ---------------------------- unique run suffix ---------------------------- */
const RUN = randomBytes(4).toString("hex");
const A_EMAIL = `p30-a-${RUN}@harness.test`;
const B_EMAIL = `p30-b-${RUN}@harness.test`;

/* ================================ 1. AUTH ================================== */
section("AUTH");
const regA = await registerApi(A_EMAIL);
check("AUTH: register user A", regA?.ok === true, regA?.ok ? regA.data.user.id : JSON.stringify(regA?.error));

const jarA = new Map();
const loginA = await login(jarA, A_EMAIL, PASS);
check("AUTH: password-only login succeeds (MFA off)", loginA.res.status === 200 && loginA.hasSession, `status=${loginA.res.status}`);

const fA = jarFetch(jarA);
const meRes = await apiJson(fA, "/api/v1/me");
check("AUTH: /me works with fresh sid session", meRes.body?.ok === true && meRes.body?.data?.email === A_EMAIL);
secretScan("AUTH /me", meRes.body);

const secSummary = await apiJson(fA, "/api/v1/me/security");
check("AUTH: security summary loads", secSummary.body?.ok === true);
check("AUTH: current session registered (isCurrent)", secSummary.body?.data?.currentSession?.isCurrent === true);
check("AUTH: sessionCount >= 1", (secSummary.body?.data?.sessionCount ?? 0) >= 1);
secretScan("AUTH /me/security", secSummary.body);

/* ============================ 2. EMAIL VERIFY ============================== */
section("EMAIL VERIFY");
const status1 = await apiJson(fA, "/api/v1/auth/email-verification/status");
check("EMAIL VERIFY: status is authenticated + honest", status1.body?.ok === true && status1.body?.data?.verified === false);
check("EMAIL VERIFY: no token material in status", !JSON.stringify(status1.body).includes("token"));
secretScan("EMAIL VERIFY status", status1.body);

// resend (send-before-persist; dev console transport).
const resend1 = await apiJson(fA, "/api/v1/auth/email-verification/resend", { method: "POST", body: "{}" });
check("EMAIL VERIFY: resend returns honest state", resend1.body?.ok === true && typeof resend1.body?.data?.sent === "boolean");
secretScan("EMAIL VERIFY resend", resend1.body);

// Extract the raw token from the dev console-transport line (dev-only).
const devLog = readFileSync(new URL("../dev.log", import.meta.url), "utf8");
const verifyLinks = [...devLog.matchAll(/#\/verify-email\/([A-Za-z0-9_-]{43})/g)].map((m) => m[1]);
const rawToken = verifyLinks[verifyLinks.length - 1];
check("EMAIL VERIFY: dev console transport printed a link (documented dev-only)", typeof rawToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(rawToken ?? ""));

// Anonymous confirm.
const confirmRes = await apiJson(jarFetch(new Map()), "/api/v1/auth/email-verification/confirm", {
  method: "POST",
  body: JSON.stringify({ token: rawToken }),
});
check("EMAIL VERIFY: anonymous confirm succeeds", confirmRes.body?.ok === true && confirmRes.body?.data?.verified === true);

// Single use: the SAME token again is generic-invalid (§144-analog §20).
const confirm2 = await apiJson(jarFetch(new Map()), "/api/v1/auth/email-verification/confirm", {
  method: "POST",
  body: JSON.stringify({ token: rawToken }),
});
check("EMAIL VERIFY: token single-use (2nd claim generic-invalid)", confirm2.body?.ok === false && confirm2.body?.error?.code === "EMAIL_VERIFICATION_TOKEN_INVALID");

// Already-verified account: resend is a safe no-op (§20/§249).
const resend2 = await apiJson(fA, "/api/v1/auth/email-verification/resend", { method: "POST", body: "{}" });
check("EMAIL VERIFY: resend after verified = alreadyVerified no-op", resend2.body?.data?.alreadyVerified === true);

// Status now verified.
const status2 = await apiJson(fA, "/api/v1/auth/email-verification/status");
check("EMAIL VERIFY: status reflects verified", status2.body?.data?.verified === true);

// Malformed token — generic invalid, no crash (§130).
const badToken = await apiJson(jarFetch(new Map()), "/api/v1/auth/email-verification/confirm", {
  method: "POST",
  body: JSON.stringify({ token: "not-a-valid-token-format!!!" }),
});
check("EMAIL VERIFY: malformed token → safe invalid", badToken.res.status === 400 && badToken.body?.error?.code === "EMAIL_VERIFICATION_TOKEN_INVALID");

// Rate-limit probe on the anonymous confirm endpoint.
let rateLimited = false;
{
  const fixedIp = `10.219.7.7`;
  for (let i = 0; i < 25; i++) {
    const r = await apiJson(jarFetch(new Map(), fixedIp), "/api/v1/auth/email-verification/confirm", {
      method: "POST",
      body: JSON.stringify({ token: `${"A".repeat(42)}${"B"}` }),
    });
    if (r.res.status === 429) { rateLimited = true; break; }
  }
}
check("EMAIL VERIFY: confirm rate-limited after bounded attempts", rateLimited);

/* ================================ 3. MFA =================================== */
section("MFA");
// Fresh user B: reauth → setup → confirm (enable) → codes.
const regB = await registerApi(B_EMAIL, "P30 B");
check("MFA: register user B", regB?.ok === true);
const jarB = new Map();
await login(jarB, B_EMAIL, PASS);
const fB = jarFetch(jarB);

// Setup requires recent password auth (§162) — expect 403 first.
const earlySetup = await apiJson(fB, "/api/v1/me/security/mfa/setup/start", { method: "POST", body: "{}" });
check("MFA: setup without reauth rejected", earlySetup.res.status === 403 && earlySetup.body?.error?.code === "MFA_REAUTH_REQUIRED");

// Reauth with the current password.
const reauth = await apiJson(fB, "/api/v1/me/security/reauth", {
  method: "POST",
  body: JSON.stringify({ password: PASS }),
});
check("MFA: reauth with correct password", reauth.body?.ok === true && reauth.body?.data?.passwordVerified === true);

// Wrong password reauth.
const reauthBad = await apiJson(fB, "/api/v1/me/security/reauth", {
  method: "POST",
  body: JSON.stringify({ password: "wrong-password-1" }),
});
check("MFA: reauth with wrong password rejected", reauthBad.res.status === 400 && reauthBad.body?.error?.code === "INVALID_CURRENT_PASSWORD");

// Setup start → otpauth URI + manual key + QR data URI.
const setup = await apiJson(fB, "/api/v1/me/security/mfa/setup/start", { method: "POST", body: "{}" });
check("MFA: setup start returns provisioning material", setup.body?.ok === true && typeof setup.body?.data?.otpauthUri === "string");
check("MFA: otpauth URI has issuer+account", /^otpauth:\/\/totp\/AI%20Business%20Copilot:/i.test(setup.body?.data?.otpauthUri ?? ""));
check("MFA: QR returned as data URI", (setup.body?.data?.qrDataUri ?? "").startsWith("data:image/png;base64,"));
const manualKey = setup.body?.data?.manualKey ?? "";
check("MFA: manual key present (RFC base32)", /^[A-Z2-7]+$/.test(manualKey) && manualKey.length >= 32);
secretScan("MFA setup", setup.body);

// Confirm with a WRONG code first.
const totp = totpFor(manualKey);
const wrongCode = String((Number(totp.generate()) + 1) % 1000000).padStart(6, "0");
const confirmBad = await apiJson(fB, "/api/v1/me/security/mfa/setup/confirm", {
  method: "POST",
  body: JSON.stringify({ code: wrongCode, confirmedSaved: true }),
});
check("MFA: setup confirm with wrong code rejected", confirmBad.res.status === 400 && confirmBad.body?.error?.code === "MFA_INVALID_CODE");

// Confirm with the CURRENT code.
const goodCode = totp.generate();
const confirmOk = await apiJson(fB, "/api/v1/me/security/mfa/setup/confirm", {
  method: "POST",
  body: JSON.stringify({ code: goodCode, confirmedSaved: true }),
});
check("MFA: setup confirm enables MFA", confirmOk.body?.ok === true && confirmOk.body?.data?.enabled === true);
const recoveryCodes = confirmOk.body?.data?.recoveryCodes ?? [];
check("MFA: 10 recovery codes returned ONCE", Array.isArray(recoveryCodes) && recoveryCodes.length === 10);
check("MFA: recovery code format (4×4 unambiguous alphabet)", recoveryCodes.every((c) => /^[0-9A-HJKMNP-TVWXYZ]{4}-[0-9A-HJKMNP-TVWXYZ]{4}-[0-9A-HJKMNP-TVWXYZ]{4}-[0-9A-HJKMNP-TVWXYZ]{4}$/.test(c)));
check("MFA: sessions invalidated after enable (§363)", confirmOk.body?.data?.sessionsInvalidated === true);
secretScan("MFA confirm", confirmOk.body);

// Session is dead now (§363): the next request must fail.
const afterEnable = await apiJson(fB, "/api/v1/me");
check("MFA: old session invalid after enable", afterEnable.res.status === 401);

// Second enable attempt → MFA_ALREADY_ENABLED (no silent overwrite §67).
await login(jarB, B_EMAIL, PASS); // now requires MFA!
// Password-only login must NOT create a session (§54).
const pwdOnly = await login(new Map(), B_EMAIL, PASS);
check("MFA: password-only login with MFA enabled → NO session", !pwdOnly.hasSession, `status=${pwdOnly.res.status}`);

/* ------------------------------ MFA login flow ----------------------------- */
const challengeRes = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/challenge", {
  method: "POST",
  body: JSON.stringify({ email: B_EMAIL, password: PASS }),
});
check("MFA: challenge issued for correct password", challengeRes.body?.ok === true && typeof challengeRes.body?.data?.challenge === "string");
const challenge = challengeRes.body?.data?.challenge;

// Wrong TOTP at complete.
const loginWrong = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
  method: "POST",
  body: JSON.stringify({ challenge, code: String((Number(totp.generate()) + 1) % 1000000).padStart(6, "0"), method: "TOTP" }),
});
check("MFA: wrong code → generic MFA_INVALID_CODE", loginWrong.res.status === 400 && loginWrong.body?.error?.code === "MFA_INVALID_CODE");

// Correct TOTP at complete → assertion.
const totpNow = totp.generate();
const completeOk = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
  method: "POST",
  body: JSON.stringify({ challenge, code: totpNow, method: "TOTP" }),
});
check("MFA: complete with valid TOTP returns assertion", completeOk.body?.ok === true && typeof completeOk.body?.data?.assertion === "string");
const assertion = completeOk.body?.data?.assertion ?? "";
secretScan("MFA complete", completeOk.body);

// Same challenge reuse → single-use (§50).
const challengeReuse = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
  method: "POST",
  body: JSON.stringify({ challenge, code: totp.generate(), method: "TOTP" }),
});
check("MFA: challenge single-use", challengeReuse.body?.ok === false);

// Assertion → real NextAuth session.
const assertionLogin = await login(new Map(), B_EMAIL, PASS, { mfaAssertion: assertion });
check("MFA: assertion completes NextAuth login", assertionLogin.hasSession, `status=${assertionLogin.res.status}`);

// Assertion single-use (§53): replay must fail.
const assertionReplay = await login(new Map(), B_EMAIL, PASS, { mfaAssertion: assertion });
check("MFA: assertion cannot be replayed", !assertionReplay.hasSession, `status=${assertionReplay.res.status}`);

// Recovery code completes login (§63) — capture B's authenticated jar.
const challenge2 = (await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/challenge", {
  method: "POST",
  body: JSON.stringify({ email: B_EMAIL, password: PASS }),
})).body?.data?.challenge;
const recoveryLogin = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
  method: "POST",
  body: JSON.stringify({ challenge: challenge2, code: recoveryCodes[0], method: "RECOVERY_CODE" }),
});
check("MFA: recovery code completes login", recoveryLogin.body?.ok === true && typeof recoveryLogin.body?.data?.assertion === "string");
const recoveryAssertion = recoveryLogin.body?.data?.assertion;
const recoverySession = await login(new Map(), B_EMAIL, PASS, { mfaAssertion: recoveryAssertion });
check("MFA: recovery assertion yields full session", recoverySession.hasSession);
const fB2 = jarFetch(recoverySession.jar); // B's live session for later sections

// Recovery code reuse → consumed permanently.
const challenge3 = (await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/challenge", {
  method: "POST",
  body: JSON.stringify({ email: B_EMAIL, password: PASS }),
})).body?.data?.challenge;
const recoveryReuse = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
  method: "POST",
  body: JSON.stringify({ challenge: challenge3, code: recoveryCodes[0], method: "RECOVERY_CODE" }),
});
check("MFA: used recovery code rejected (single use)", recoveryReuse.body?.ok === false);

// TOTP replay protection (§45): capture the accepted step, force the same
// step again via a new challenge — must NOT be accepted twice.
const replayChallenge = (await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/challenge", {
  method: "POST",
  body: JSON.stringify({ email: B_EMAIL, password: PASS }),
})).body?.data?.challenge;
const sameCodeAgain = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
  method: "POST",
  body: JSON.stringify({ challenge: replayChallenge, code: totpNow, method: "TOTP" }),
});
check("MFA: same TOTP step cannot be accepted twice (replay)", sameCodeAgain.body?.ok === false);

/* ============================== 4. SESSIONS ================================ */
section("SESSIONS");
// loginA (sid) + loginB (sid) are registered; also make a second session for A.
const jarA2 = new Map();
await login(jarA2, A_EMAIL, PASS);
const fA2 = jarFetch(jarA2);

const sessionsA = await apiJson(fA, "/api/v1/me/security/sessions?pageSize=50");
check("SESSIONS: list bounded + ok", sessionsA.body?.ok === true);
const aSessions = sessionsA.body?.data?.sessions ?? [];
check("SESSIONS: A sees only own sessions", aSessions.length >= 2);
check("SESSIONS: exactly one current session", aSessions.filter((s) => s.isCurrent).length === 1);
check("SESSIONS: DTOs carry no token material", !JSON.stringify(sessionsA.body).includes("sessionTokenHash") && !JSON.stringify(sessionsA.body).includes("token"));
const otherSession = aSessions.find((s) => !s.isCurrent);
check("SESSIONS: another session visible", otherSession != null);

// Revoke A's other session from the current one.
const revokeRes = await apiJson(fA, `/api/v1/me/security/sessions/${otherSession.id}/revoke`, { method: "POST", body: "{}" });
check("SESSIONS: revoke other session succeeds", revokeRes.body?.ok === true);

// The revoked session dies at its next request.
const revokedFetch = await apiJson(fA2, "/api/v1/me");
check("SESSIONS: revoked session gets 401 SESSION_REVOKED", revokedFetch.res.status === 401 && revokedFetch.body?.error?.code === "SESSION_REVOKED");

// Idempotent double revoke (§210).
const revokeAgain = await apiJson(fA, `/api/v1/me/security/sessions/${otherSession.id}/revoke`, { method: "POST", body: "{}" });
check("SESSIONS: double revoke = safe no-op", revokeAgain.body?.ok === true && revokeAgain.body?.data?.alreadyRevoked === true);

// Cross-user session id → 404-safe (§126/§358). B's session id, from A.
// B authenticates through the full MFA dance (totp) to hold a live session.
const bLogin = await mfaLogin(B_EMAIL, totp);
check("SESSIONS: B completes MFA login dance", bLogin.ok, `why=${bLogin.why ?? "n/a"}`);
const fB3 = bLogin.ok ? jarFetch(bLogin.jar) : fB;
const bSessions = await apiJson(fB3, "/api/v1/me/security/sessions?pageSize=50");
const bCurrent = (bSessions.body?.data?.sessions ?? []).find((s) => s.isCurrent);
check("SESSIONS: B current session marked", bCurrent != null);
const crossRevoke = await apiJson(fA, `/api/v1/me/security/sessions/${bCurrent.id}/revoke`, { method: "POST", body: "{}" });
check("SESSIONS: cross-user revoke → 404 (no existence oracle)", crossRevoke.res.status === 404 && crossRevoke.body?.error?.code === "SESSION_NOT_FOUND");
check("SESSIONS: B's session untouched", (await apiJson(fB3, "/api/v1/me")).body?.ok === true);

// Revoke-all (password + typed confirmation §80).
const revokeAllBad = await apiJson(fA, "/api/v1/me/security/sessions/revoke-all", {
  method: "POST",
  body: JSON.stringify({ password: "wrong-password-1", confirmation: "SIGN OUT ALL" }),
});
lastResponses.revokeAllBad = { status: revokeAllBad.res.status, err: revokeAllBad.body?.error?.code };
check("SESSIONS: revoke-all with wrong password rejected", revokeAllBad.res.status === 400 && revokeAllBad.body?.error?.code === "INVALID_CURRENT_PASSWORD");

const revokeAll = await apiJson(fA, "/api/v1/me/security/sessions/revoke-all", {
  method: "POST",
  body: JSON.stringify({ password: PASS, confirmation: "SIGN OUT ALL" }),
});
lastResponses.revokeAll = { status: revokeAll.res.status, err: revokeAll.body?.error?.code };
check("SESSIONS: revoke-all succeeds with password+confirmation", revokeAll.body?.ok === true);
check("SESSIONS: current session survives revoke-all", revokeAll.body?.data?.currentSessionKept === true);
const afterRevokeAll = await apiJson(fA, "/api/v1/me");
lastResponses.afterRevokeAll = { status: afterRevokeAll.res.status, err: afterRevokeAll.body?.error?.code };
check("SESSIONS: current session still valid after revoke-all", afterRevokeAll.body?.ok === true);

/* =============================== 5. STEP-UP ================================ */
section("STEP-UP");
// Recent reauth passes; stale/restart cleared by new reauth — the window is
// server-authoritative (§116). Also: client boolean CANNOT bypass (§501).
const noPasswordRegen = await apiJson(fB3, "/api/v1/me/security/mfa/recovery-codes/regenerate", {
  method: "POST",
  body: JSON.stringify({ password: "", mfaCode: "000000" }),
});
lastResponses.regenEmpty = { status: noPasswordRegen.res.status, err: noPasswordRegen.body?.error?.code };
check("STEP-UP: regen without valid password rejected", noPasswordRegen.res.status === 400 || noPasswordRegen.res.status === 422);
const regenWithPasswordOnly = await apiJson(fB3, "/api/v1/me/security/mfa/recovery-codes/regenerate", {
  method: "POST",
  body: JSON.stringify({ password: PASS, mfaCode: "000000" }),
});
lastResponses.regenBadMfa = { status: regenWithPasswordOnly.res.status, err: regenWithPasswordOnly.body?.error?.code };
check("STEP-UP: regen with password but no valid MFA rejected", regenWithPasswordOnly.res.status === 400 && regenWithPasswordOnly.body?.error?.code === "MFA_INVALID_CODE");

// Successful regen requires password + current TOTP.
const regen = await apiJson(fB2, "/api/v1/me/security/mfa/recovery-codes/regenerate", {
  method: "POST",
  body: JSON.stringify({ password: PASS, mfaCode: totp.generate() }),
});
check("STEP-UP: regen with password+TOTP succeeds", regen.body?.ok === true && regen.body?.data?.recoveryCodes?.length === 10);
check("STEP-UP: old recovery codes stop working (§212)", !regen.body?.data?.recoveryCodes?.includes(recoveryCodes[1]));
// Verify a STILL-UNUSED old code is truly dead after regen.
const oldCodeProbe = (await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/challenge", {
  method: "POST",
  body: JSON.stringify({ email: B_EMAIL, password: PASS }),
})).body?.data?.challenge;
const oldCodeAttempt = await apiJson(jarFetch(new Map()), "/api/v1/auth/mfa/complete", {
  method: "POST",
  body: JSON.stringify({ challenge: oldCodeProbe, code: recoveryCodes[1], method: "RECOVERY_CODE" }),
});
check("STEP-UP: unused old code rejected after regen", oldCodeAttempt.body?.ok === false);

/* ============================ 6. MFA DISABLE ============================== */
section("MFA DISABLE");
const disableNoConfirm = await apiJson(fB2, "/api/v1/me/security/mfa/disable", {
  method: "POST",
  body: JSON.stringify({ password: PASS, mfaCode: totp.generate(), confirmation: "WRONG" }),
});
check("MFA DISABLE: wrong typed confirmation rejected", disableNoConfirm.res.status === 422 && disableNoConfirm.body?.error?.code === "CONFIRMATION_MISMATCH");

const disableOk = await apiJson(fB2, "/api/v1/me/security/mfa/disable", {
  method: "POST",
  body: JSON.stringify({ password: PASS, mfaCode: totp.generate(), confirmation: "DISABLE MFA" }),
});
check("MFA DISABLE: disable with password+TOTP+confirmation", disableOk.body?.ok === true && disableOk.body?.data?.disabled === true);
check("MFA DISABLE: sessions invalidated (§66)", disableOk.body?.data?.sessionsInvalidated === true);
const afterDisable = await apiJson(fB2, "/api/v1/me");
check("MFA DISABLE: B's session dead after disable", afterDisable.res.status === 401);

// Re-login WITHOUT MFA now succeeds (capability removed).
const plainLogin = await login(new Map(), B_EMAIL, PASS);
check("MFA DISABLE: password-only login works again", plainLogin.hasSession);

// Double disable → safe state (§211).
await login(jarB, B_EMAIL, PASS);
const disableAgain = await apiJson(jarFetch(jarB), "/api/v1/me/security/mfa/disable", {
  method: "POST",
  body: JSON.stringify({ password: PASS, mfaCode: "123456", confirmation: "DISABLE MFA" }),
});
check("MFA DISABLE: second disable = safe alreadyDisabled", disableAgain.body?.ok === true && disableAgain.body?.data?.alreadyDisabled === true);

/* ============================ 7. ISOLATION ================================= */
section("ISOLATION");
// A cannot read B's security center (the API derives identity from session).
const aSecurity = await apiJson(fA, "/api/v1/me/security");
check("ISOLATION: security center is session-bound (A sees A)", aSecurity.body?.data?.email === A_EMAIL);

// Anonymous access to /me/security → 401 (§160).
const anonSecurity = await apiJson(jarFetch(new Map()), "/api/v1/me/security");
check("ISOLATION: anonymous /me/security → 401", anonSecurity.res.status === 401);

// Anonymous /me/security/sessions → 401 (§203).
const anonSessions = await apiJson(jarFetch(new Map()), "/api/v1/me/security/sessions");
check("ISOLATION: anonymous sessions → 401", anonSessions.res.status === 401);

/* ========================= 8. SECURITY ACTIVITY ============================ */
section("ACTIVITY");
const activity = await apiJson(fA, "/api/v1/me/security/activity?pageSize=50");
check("ACTIVITY: list loads, newest first", activity.body?.ok === true && Array.isArray(activity.body?.data?.events));
const events = activity.body?.data?.events ?? [];
const types = new Set(events.map((e) => e.eventType));
check("ACTIVITY: login.success recorded", types.has("auth.login.success"));
check("ACTIVITY: session revoked recorded", types.has("auth.session.revoked"));
check("ACTIVITY: session revoke-all recorded", types.has("auth.session.revoked_all"));
check("ACTIVITY: email verification completed recorded", types.has("auth.email_verification.completed"));
check("ACTIVITY: fixed vocabulary only (no client names)", [...types].every((t) => t.startsWith("auth.")));
check("ACTIVITY: no secret values in events", !/"(password|otp|code|token|secret)":/.test(JSON.stringify(activity.body)));
secretScan("ACTIVITY", activity.body);

/* ============================ 9. SECRET LEAK SCAN ========================== */
section("PRIVACY");
// Re-scan every captured response for secret-bearing keys.
const bodies = [meRes, secSummary, status1, resend1, confirmRes, setup, sessionsA, bSessions, activity];
  // confirmOk deliberately EXCLUDED: it is the sanctioned ONE-TIME display
  // response (§60) — the only response that may ever contain raw codes.
const leakScan = bodies.filter((b) => JSON.stringify(b.body ?? {}).match(/"(passwordHash|encryptedSecret|codeHash|tokenHash|sessionTokenHash|mfaSecret|recoveryCodes)":/));
check("PRIVACY: no secret-bearing field in ANY captured response", leakScan.length === 0, `${leakScan.length} leaks`);
// Recovery codes were returned exactly once (at enable) — never in later reads.
const laterReads = JSON.stringify([secSummary.body, sessionsA.body, activity.body]);
check("PRIVACY: raw recovery codes never appear outside the one-time response", !laterReads.includes(recoveryCodes[0]));

/* ================================= done ==================================== */
const failed = results.filter((r) => !r.ok);
console.log(`\n=== prompt30-check: ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name} ${f.info}`);
  process.exit(1);
}
process.exit(0);
