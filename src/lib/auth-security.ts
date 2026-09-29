/**
 * Authentication & account-lifecycle security core (Prompt 18).
 *
 * Centralizes the rules that must NEVER drift between UI and API:
 *  - the password policy (single zod schema, consumed by register,
 *    password change and password reset confirm),
 *  - reset-token generation/hashing (raw tokens exist ONLY inside the
 *    emailed link — the database stores SHA-256 hashes),
 *  - the session-invalidation primitive (User.sessionVersion compared
 *    against the version stamped into the NextAuth JWT),
 *  - the reset-link builder (base URL from configuration, never from
 *    arbitrary request Host headers).
 *
 * Logging law for this module: passwords and raw tokens are NEVER logged,
 * never returned from APIs, and never written to audit records.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";

/* --------------------------------- policy -------------------------------- */

/**
 * Password policy — documented in docs/security/account-lifecycle.md.
 * 8+ chars, at least one letter and one digit, ≤200 chars. No artificial
 * complexity theater beyond that (usability over rule-count). Passwords are
 * NOT trimmed: whitespace is significant inside a secret (register has
 * always behaved this way — the policy must not silently change it).
 */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200, "Password must be at most 200 characters")
  .regex(/[a-zA-Z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

/* ------------------------------ reset tokens ------------------------------ */

/** Reset links are valid for exactly 30 minutes (documented policy). */
export const PASSWORD_RESET_TTL_MINUTES = 30;
export const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60_000;

/** 32 random bytes → 43-char base64url — unguessable, sufficient length. */
export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only hashes ever touch the database. SHA-256: fast lookup, no plaintext. */
export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Constant-time raw-token format check before any DB work. */
export function isPlausibleResetToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Constant-time comparison for hash equality (defense in depth). */
export function safeHashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* --------------------------- session invalidation --------------------------
 *
 * Prompt 30 update (§81/§82/§83): the two freshness gates below now ALSO
 * validate the per-device session registry for sid-bearing JWTs: the sid
 * must exist, belong to the caller, be un-revoked and un-expired. JWTs
 * issued BEFORE Prompt 30 carry no sid and keep working during the
 * documented compatibility window (§83/§228): sessionVersion + user checks
 * still apply; only the per-device registry is bypassed.
 * -------------------------------------------------------------------------- */

/**
 * Session-version comparison (Prompt 18 §16).
 *
 * The JWT carries `sv` — the User.sessionVersion at sign-in time. Changing
 * the password (change OR reset) increments the stored version, so every
 * previously issued JWT fails the comparison and must re-authenticate.
 * This is enforced at BOTH enforcement points:
 *  - getAuthContext (business-scoped APIs) — via the membership's user row,
 *  - assertFreshSession (account-scoped APIs: /me, password change).
 *
 * Prompt 30 adds the per-device registry check (§81) for sid-bearing JWTs:
 * revocation is immediate on the NEXT request through either checkpoint.
 *
 * Honest limitation (documented): with the JWT strategy, invalidation takes
 * effect on the NEXT request that passes through one of these checkpoints —
 * it is not a push-based global revocation. All business + account APIs
 * pass through them, so effectively the old token is dead immediately.
 *
 * Back-compat: JWTs issued before this feature carry no `sv`; they are
 * treated as version 0, which matches every existing user's default.
 */
export function sessionVersionOf(session: Session | null): number {
  const v = (session?.user as { sessionVersion?: unknown } | undefined)?.sessionVersion;
  return typeof v === "number" && Number.isInteger(v) ? v : 0;
}

/** The sid from a session (undefined for legacy JWTs — compat window §83). */
export function sidOf(session: Session | null): string | null {
  const sid = (session?.user as { sid?: unknown } | undefined)?.sid;
  return typeof sid === "string" && sid.length > 0 ? sid : null;
}

/**
 * Per-device registry gate (§81). Throws 401 SESSION_REVOKED /
 * SESSION_INVALIDATED on any registry failure. Legacy JWTs (no sid) pass —
 * compatibility window (§83/§228); sessionVersion remains their kill switch.
 */
export async function assertSessionRegistry(session: Session | null, userId: string): Promise<string | null> {
  const sid = sidOf(session);
  if (!sid) return null; // legacy JWT — documented compat window
  const { checkSessionRegistry } = await import("@/lib/auth/sessions/service");
  const result = await checkSessionRegistry(sid, userId);
  if (result.ok) return result.sessionId;
  if (result.reason === "REVOKED") {
    throw new ApiError(401, "SESSION_REVOKED", "This device was signed out. Please sign in again.");
  }
  throw new ApiError(401, "SESSION_INVALIDATED", "This session is no longer valid. Please sign in again.");
}

/**
 * Account-scoped freshness gate: re-reads the CURRENT sessionVersion from
 * the database and compares it with the version in the JWT. Throws
 * 401 SESSION_INVALIDATED on mismatch (e.g. password changed on another
 * device). Returns the fresh userId on success.
 */
export async function assertFreshSession(session: Session | null): Promise<string> {
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  if (!user) {
    // Account deleted while a session token still exists.
    throw new ApiError(401, "SESSION_INVALIDATED", "This session is no longer valid. Please sign in again.");
  }
  if (sessionVersionOf(session) !== user.sessionVersion) {
    throw new ApiError(
      401,
      "SESSION_INVALIDATED",
      "Your session was invalidated (password changed). Please sign in again.",
    );
  }
  // Prompt 30 §81 — per-device registry check (sid-bearing sessions).
  await assertSessionRegistry(session, userId);
  return userId;
}

/** Helper for sign-in: fetch the fields authorize() must stamp into the JWT. */
export async function findUserForSignIn(email: string) {
  return db.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true, sessionVersion: true },
  });
}

/* ------------------------------ reset link URL ----------------------------- */

/**
 * Base URL comes from configuration ONLY (NEXTAUTH_URL / APP_BASE_URL).
 * Building it from the request Host header would let an attacker host the
 * reset link on a domain they control (password-reset poisoning).
 */
export function appBaseUrl(): string {
  const url = process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL;
  if (!url) {
    throw new ApiError(
      503,
      "RESET_DELIVERY_UNAVAILABLE",
      "Password reset is temporarily unavailable. Please try again later.",
    );
  }
  return url.replace(/\/+$/, "");
}

export function buildResetLink(rawToken: string): string {
  // The raw token exists ONLY inside this link (never logged, never stored).
  return `${appBaseUrl()}/#/reset-password/${rawToken}`;
}
