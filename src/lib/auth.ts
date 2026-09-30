/**
 * NextAuth configuration — Constitution A14 · Prompt 30 identity security v2.
 *
 * Credentials provider + JWT session strategy (SPA-friendly), now with:
 *  - TOTP MFA (§46/§52/§54): password success with MFA enabled NEVER issues
 *    a full session — authorize() throws MFA_REQUIRED and the client
 *    completes a bounded server-side challenge (MfaLoginChallenge) whose
 *    success yields a ONE-TIME assertion consumed here.
 *  - Per-device session registry (§70-§73): every NEW login generates a
 *    cryptographically strong `sid`, registers UserSession(SHA-256(sid))
 *    and stamps it into the JWT. Registration failure fails the login
 *    (§217) — no untrackable sessions are ever issued.
 *  - sessionVersion (§82 — unchanged): `sv` remains the global kill switch
 *    stamped at sign-in and compared against the DB at every freshness gate.
 *
 * SECURITY LAWS (Prompt 30 §0):
 *  - No password, OTP, recovery code, reset token or MFA secret is ever
 *    logged or returned (§12-§19). The client-visible authorize error
 *    message is a FIXED code (MFA_REQUIRED) — never a secret.
 *  - Client-asserted MFA state is never trusted (§10/§53/§112): the only
 *    path past MFA is the single-use server-side assertion.
 *  - Legacy JWTs without sid keep working during the documented
 *    compatibility window (§83/§228) — sessionVersion still applies to
 *    them; they simply bypass the per-device registry.
 */
import type { NextAuthOptions } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { findUserForSignIn } from "@/lib/auth-security";
import { recordSecurityEvent, SECURITY_EVENTS } from "@/lib/auth/security-events/service";
import {
  generateSessionId,
  hashSessionId,
  registerUserSession,
} from "@/lib/auth/sessions/service";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/auth/config";

/**
 * Session-version policy (Prompt 18 §16 — UNCHANGED): the JWT is stamped
 * with `sv` — the User.sessionVersion at sign-in time. Password change/
 * reset increments the stored version; every older JWT then fails the
 * freshness check in getAuthContext (business APIs) and assertFreshSession
 * (account APIs).
 *
 * Prompt 30 adds: `sid` (per-device session id) and `mfa` (informational
 * only — server authorization NEVER trusts it, §112).
 */

/** Fixed client-visible sign-in error codes (no secrets, §111/§422). */
export const SIGNIN_ERROR_MFA_REQUIRED = "MFA_REQUIRED";
/** Fixed reason code for rate-limited login attempts (§91). */
const LOGIN_RATE_LIMITED = "RATE_LIMITED";

const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(200).optional(),
    /** §52/§53 — one-time server-generated assertion from MFA completion. */
    mfaAssertion: z.string().min(20).max(200).optional(),
  })
  .refine((v) => v.password !== undefined || v.mfaAssertion !== undefined, {
    message: "credentials_required",
  });

export const authOptions: NextAuthOptions = {
  // STABLE secret is mandatory: without it next-auth v4 derives an ad-hoc
  // dev key per route-module instance / restart, and session JWTs issued
  // by one instance can never be decrypted by another (JWEDecryptionFailed
  // → random 401s). Production still fails fast (NO_SECRET throw) if the
  // env var is missing; the literal fallback is dev-only convenience.
  secret:
    process.env.NEXTAUTH_SECRET ??
    (process.env.NODE_ENV !== "production"
      ? "ai-business-copilot-dev-secret-stable"
      : undefined),
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS, // 30 days — single authority (§84)
  },
  pages: {
    signIn: "/", // SPA handles sign-in view at root
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        mfaAssertion: { label: "MFA Assertion", type: "text" },
      },
      async authorize(credentials, req) {
        const parsed = credentialsSchema.safeParse(credentials ?? {});
        if (!parsed.success) return null;

        const { email, password, mfaAssertion } = parsed.data;

        const headers = (req as { headers?: Record<string, string> } | null)?.headers;
        const ip = headers?.["x-forwarded-for"] ?? "unknown";
        const userAgent = headers?.["user-agent"] ?? null;

        // Brute-force guard per email+ip (A14, §142 — MFA never bypasses
        // the login limiter). Same bucket as the MFA challenge endpoint.
        const { rateLimit } = await import("@/lib/rate-limit");
        const rl = rateLimit(`login:${email}:${ip}`, 10, 5 * 60 * 1000);
        if (!rl.allowed) {
          await recordSecurityEvent({
            eventType: SECURITY_EVENTS.loginFailed,
            reasonCode: LOGIN_RATE_LIMITED,
            success: false,
            ip,
            userAgent,
          });
          return null;
        }

        const user = await findUserForSignIn(email);
        if (!user) {
          // §91/§141: no event for unknown emails (no unbounded write sink,
          // no information gain for the attacker).
          return null;
        }

        /* ------------------------ MFA assertion path ------------------------ */
        if (mfaAssertion !== undefined) {
          // §53: hashed, single-use, server-bound, consumed during authorize.
          const { hashResetToken, isPlausibleResetToken } = await import("@/lib/auth-security");
          if (!isPlausibleResetToken(mfaAssertion)) return null;

          const challenge = await db.mfaLoginChallenge.findFirst({
            where: { userId: user.id, assertionHash: hashResetToken(mfaAssertion) },
            select: {
              id: true,
              expiresAt: true,
              assertionUsedAt: true,
              sessionVersionAtChallenge: true,
            },
          });
          const now = new Date();
          const valid =
            challenge &&
            challenge.assertionUsedAt === null &&
            challenge.expiresAt.getTime() > now.getTime() &&
            challenge.sessionVersionAtChallenge === user.sessionVersion;
          if (!valid) {
            // Invalid/expired/replayed assertion → NEVER a session; the
            // client restarts the (rate-limited) MFA flow. Generic code.
            throw new Error(SIGNIN_ERROR_MFA_REQUIRED);
          }
          const claimed = await db.mfaLoginChallenge.updateMany({
            where: {
              id: challenge.id,
              assertionUsedAt: null,
              expiresAt: { gt: now },
            },
            data: { assertionUsedAt: now },
          });
          if (claimed.count !== 1) {
            throw new Error(SIGNIN_ERROR_MFA_REQUIRED); // concurrent replay lost — §50
          }

          return await completeLogin(user, { ip, userAgent, createdFrom: "assertion", mfaUsed: true });
        }

        /* -------------------------- password path --------------------------- */
        if (password === undefined) return null;
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          await recordSecurityEvent({
            eventType: SECURITY_EVENTS.loginFailed,
            userId: user.id,
            reasonCode: "INVALID_CREDENTIALS",
            success: false,
            ip,
            userAgent,
          });
          return null;
        }

        // §54 — MFA enabled ⇒ password success is NEVER a full session.
        const mfaCredential = await db.mfaCredential.findUnique({
          where: { userId: user.id },
          select: { enabledAt: true },
        });
        if (mfaCredential?.enabledAt != null) {
          // Fixed code only — no MFA-state details, no secrets (§111).
          throw new Error(SIGNIN_ERROR_MFA_REQUIRED);
        }

        return await completeLogin(user, { ip, userAgent, createdFrom: "login", mfaUsed: false });
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.sv = (user as { sessionVersion?: number }).sessionVersion ?? 0;
        const sid = (user as { sid?: string }).sid;
        if (sid) token.sid = sid;
        token.mfa = (user as { mfaUsed?: boolean }).mfaUsed === true;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      // Exposed to server helpers via getServerSession; harmless client-side.
      // The server NEVER trusts client copies of these values (§10/§112).
      session.user.sessionVersion = typeof token.sv === "number" ? token.sv : 0;
      if (typeof token.sid === "string") {
        (session.user as { sid?: string }).sid = token.sid;
      }
      return session;
    },
  },
};

/**
 * Shared login-completion path (§73/§216/§217): register the UserSession
 * (failure FAILS the login — no untrackable session, §217), record the
 * durable login.success activity event, and hand NextAuth the user object
 * whose sid/sv are stamped into the JWT by the jwt callback.
 */
async function completeLogin(
  user: { id: string; email: string; name: string | null; sessionVersion: number },
  meta: { ip: string; userAgent: string | null; createdFrom: "login" | "assertion"; mfaUsed: boolean },
) {
  const sid = generateSessionId();
  // §216/§217 — registration failure propagates: the login fails safely
  // instead of issuing a session that could never be individually revoked.
  const registered = await registerUserSession({
    userId: user.id,
    sid,
    ip: meta.ip,
    userAgent: meta.userAgent,
    createdFrom: meta.createdFrom,
  });

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.loginSuccess,
    userId: user.id,
    sessionId: registered.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    success: true,
  });

  // Prompt 32 §96 — new sign-in notification (in-app always, optional
  // email by preference). Safe device label only — never IP, geolocation
  // or session secrets. Fire-safe; a notification failure never fails the
  // login (§30).
  const { notifyNewLogin } = await import("@/lib/notifications");
  notifyNewLogin(user.id, registered.id, meta.userAgent, meta.createdFrom);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    sessionVersion: user.sessionVersion,
    sid,
    mfaUsed: meta.mfaUsed,
  };
}

/**
 * Registry key helper re-exported for tests/tools — NOT for clients: this
 * is the SHA-256 registry key derivation (§72), kept next to the code
 * that stamps it so the two can never drift.
 */
export { hashSessionId };
