/**
 * Shared MFA fixture helper for platform batteries — Prompt 65 §17.
 *
 * ONE helper, the REAL enrollment + login paths (no crypto duplication,
 * no direct DB secret writes — §81):
 *
 *   enrollFixtureMfa   — reauth → setup/start → TOTP → setup/confirm.
 *                        Exercises the exact §6.3 enrollment flow every
 *                        operator must follow; returns the secret (for
 *                        login codes) + recovery codes.
 *   generateTotpCode   — the battery-side twin of the authenticator app
 *                        (otpauth, the SAME library the server uses).
 *   platformMfaLogin   — full 3-step MFA login: password-only attempt →
 *                        MFA_REQUIRED detection → challenge → code →
 *                        assertion → session. Returns a cookie jar.
 *   clearFixtureMfa    — FK-safe sweep (self-healing re-runs).
 *
 * NOTE: enrollment happens BEFORE the user has MFA, so the plain
 * password login still works for the enrolling session itself.
 */
import { PrismaClient } from "@prisma/client";
import * as OTPAuth from "otpauth";

const BASE = process.env.BATTERY_BASE ?? "http://localhost:3000";

/* ------------------------------ jar plumbing ------------------------------ */

export function jarFetch(jar: Map<string, string>) {
  return async (path: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `10.78.${(Date.now() >> 8) & 255}.${(Date.now() >> 16) & 255}`,
      ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    const raw = res.headers.get("set-cookie");
    if (raw) {
      for (const piece of raw.split(/,(?=[^;]+=)/)) {
        const [pair] = piece.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return res;
  };
}

export function callerOf(jar: Map<string, string>) {
  const f = jarFetch(jar);
  return async (path: string, init: RequestInit = {}) => {
    const res = await f(path, init);
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, res };
  };
}

/* -------------------------------- TOTP code ------------------------------- */

/** Battery-side authenticator: same library + params as the server. */
export function generateTotpCode(secretBase32: string, timestamp?: number): string {
  const totp = new OTPAuth.TOTP({
    issuer: "AI Business Copilot",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: timestamp ?? Date.now() });
}

/* ------------------------------- enrollment ------------------------------- */

/**
 * Enroll MFA for a logged-in fixture via the REAL API flow.
 * `caller` must be bound to the fixture's own (fresh, password-logged-in)
 * cookie jar. Returns the base32 secret + the one-time recovery codes.
 */
/** Minimal structural caller — batteries pass their own local variants. */
type EnrollCaller = (path: string, init?: RequestInit) => Promise<{ status: number; json: any }>;

export async function enrollFixtureMfa(
  caller: EnrollCaller,
  password: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  // §162 — recent password auth via the sanctioned reauth endpoint.
  const re = await caller("/api/v1/me/security/reauth", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (re.status !== 200) throw new Error(`fixture reauth failed: ${re.status}`);

  const start = await caller("/api/v1/me/security/mfa/setup/start", { method: "POST", body: "{}" });
  const startData = start.json?.data ?? start.json;
  if (start.status !== 200 || !startData?.manualKey) {
    throw new Error(`fixture mfa setup/start failed: ${start.status} ${JSON.stringify(start.json)?.slice(0, 200)}`);
  }
  const secret: string = startData.manualKey;

  const confirm = await caller("/api/v1/me/security/mfa/setup/confirm", {
    method: "POST",
    body: JSON.stringify({ code: generateTotpCode(secret), confirmedSaved: true }),
  });
  const confirmData = confirm.json?.data ?? confirm.json;
  if (confirm.status !== 200 || !Array.isArray(confirmData?.recoveryCodes)) {
    throw new Error(`fixture mfa setup/confirm failed: ${confirm.status} ${JSON.stringify(confirm.json)?.slice(0, 200)}`);
  }
  return { secret, recoveryCodes: confirmData.recoveryCodes as string[] };
}

/* ------------------------------ MFA login flow ----------------------------- */

/**
 * Full 3-step MFA login for a fixture with MFA ALREADY enabled:
 *   1) password-only credentials callback → expect the MFA_REQUIRED
 *      redirect (no session cookie is ever issued for that attempt);
 *   2) /auth/mfa/challenge (re-verifies the password) → challenge token;
 *   3) /auth/mfa/complete (TOTP via generateTotpCode) → one-time assertion;
 *   4) credentials callback with mfaAssertion → real session jar.
 */
export async function platformMfaLogin(
  email: string,
  password: string,
  secret: string,
  opts: { code?: string; method?: "TOTP" | "RECOVERY_CODE" } = {},
): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const f = jarFetch(jar);

  const csrf1 = await f("/api/auth/csrf");
  const { csrfToken } = (await csrf1.json()) as { csrfToken: string };
  const attempt = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password }).toString(),
  });
  const location = attempt.headers.get("location") ?? "";
  if (!/MFA_REQUIRED/.test(location)) {
    throw new Error(`expected MFA_REQUIRED redirect, got ${attempt.status} → ${location.slice(0, 120)}`);
  }
  // The failed attempt must NOT have issued a session (anti-bypass law).
  const hasAuthCookie = [...jar.keys()].some((k) => k.includes("authjs.session-token") || k.includes("next-auth.session-token"));
  if (hasAuthCookie) throw new Error("MFA_REQUIRED attempt issued a session cookie — enforcement bypass!");

  const chRes = await f("/api/v1/auth/mfa/challenge", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const chJson = await chRes.json().catch(() => null);
  const chData = chJson?.data ?? chJson;
  if (chRes.status !== 200 || !chData?.challenge) {
    throw new Error(`mfa challenge failed: ${chRes.status} ${JSON.stringify(chJson)?.slice(0, 200)}`);
  }
  const challenge: string = chData.challenge;

  // Default to the NEXT step's code: a login immediately following an
  // enrollment (whose confirm consumed the current step) can never replay
  // (§45 — future steps are never permanently rejected).
  const code = opts.code ?? generateTotpCode(secret, Date.now() + 30_000);
  const completeRes = await f("/api/v1/auth/mfa/complete", {
    method: "POST",
    body: JSON.stringify({ challenge, code, method: opts.method ?? "TOTP" }),
  });
  const completeJson = await completeRes.json().catch(() => null);
  const completeData = completeJson?.data ?? completeJson;
  if (completeRes.status !== 200 || !completeData?.assertion) {
    throw new Error(`mfa complete failed: ${completeRes.status} ${JSON.stringify(completeJson)?.slice(0, 200)}`);
  }
  const assertion: string = completeData.assertion;

  const csrf2 = await f("/api/auth/csrf");
  const { csrfToken: token2 } = (await csrf2.json()) as { csrfToken: string };
  const final = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: token2, email, mfaAssertion: assertion }).toString(),
  });
  if (final.status !== 302 && final.status !== 200) {
    throw new Error(`mfa final login failed: ${final.status}`);
  }
  const hasSession = [...jar.keys()].some((k) => k.includes("authjs.session-token") || k.includes("next-auth.session-token"));
  if (!hasSession) throw new Error("MFA login finished without a session cookie");
  return jar;
}

/* ----------------------------- plain login -------------------------------- */

/** Structural jar-fetch (each battery defines its own — same shape). */
type JarFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Plain credentials login for a fixture WITHOUT MFA (batteries create their
 * users directly with a passwordHash — no enrollment): CSRF → credentials
 * callback → the session cookie lands in the caller's own jar via its
 * set-cookie handling. Returns the SAME jar so callers can wrap it with
 * callerOf(jar) in a single expression. Throws when no session cookie was
 * issued — a login must never silently pretend to be authenticated.
 * (MFA-enrolled fixtures use platformMfaLogin above instead.)
 */
export async function loginCredentials(
  f: JarFetch,
  jar: Map<string, string>,
  email: string,
  password: string,
): Promise<Map<string, string>> {
  const csrfRes = await f("/api/auth/csrf");
  if (!csrfRes.ok) throw new Error(`csrf failed: ${csrfRes.status}`);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const attempt = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password }).toString(),
  });
  // NextAuth answers a successful credentials callback with a redirect and
  // issues the session cookie into the jar; anything without that cookie is
  // a failed login (bad credentials / disabled user) — fail loudly.
  const hasSession = [...jar.keys()].some(
    (k) => k.includes("authjs.session-token") || k.includes("next-auth.session-token"),
  );
  if (!hasSession) {
    throw new Error(`credentials login failed for ${email}: status=${attempt.status}`);
  }
  return jar;
}

/* --------------------------------- sweep ---------------------------------- */

/** FK-safe fixture sweep for idempotent re-runs (self-healing batteries). */
export async function clearFixtureMfa(db: PrismaClient, userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  await db.mfaRecoveryCode.deleteMany({ where: { userId: { in: userIds } } });
  await db.mfaCredential.deleteMany({ where: { userId: { in: userIds } } });
  await db.mfaLoginChallenge.deleteMany({ where: { userId: { in: userIds } } });
}
