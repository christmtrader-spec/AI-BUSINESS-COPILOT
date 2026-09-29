/**
 * POST /api/v1/auth/mfa/challenge — step 2 of the MFA login flow
 * (Prompt 30 §46-§49, §110).
 *
 * Called AFTER NextAuth authorize() rejected the password-only attempt with
 * the fixed MFA_REQUIRED code. This endpoint re-verifies the password (the
 * challenge token must only ever reach the legitimate login flow) and
 * issues a SHORT-LIVED single-use challenge:
 *   - raw challenge token returned ONCE, to this client only (§48);
 *   - database stores SHA-256(challengeHash) — never the raw value (§47);
 *   - TTL = mfaChallengeTtlSeconds() (default 300s, §47);
 *   - bound to the user's CURRENT sessionVersion (§437/§438) — a password
 *     change or password reset mid-challenge invalidates it;
 *   - single-use (claimed atomically at completion, §50).
 *
 * Enumeration/anti-oracle law (§200/§280): wrong credentials produce the
 * SAME generic 401 as NextAuth's own failure — this endpoint never reveals
 * whether an account has MFA before the password has been verified.
 *
 * Rate-limit law (§56/§142): counts against the SAME login bucket as
 * authorize() (no limiter bypass) PLUS a dedicated challenge limiter.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { mfaChallengeTtlSeconds } from "@/lib/auth/config";
import { generateResetToken, hashResetToken, isPlausibleResetToken } from "@/lib/auth-security";
import {
  SECURITY_EVENTS,
  recordSecurityEvent,
} from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

/** Opportunistic bounded challenge cleanup (§133). */
async function cleanupChallenges(userId?: string): Promise<void> {
  const now = new Date();
  if (userId) {
    await db.mfaLoginChallenge.deleteMany({
      where: { userId, OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    });
  } else {
    await db.mfaLoginChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
  }
}

export const POST = route(async (req: NextRequest) => {
  const ip = getClientIp(req);
  const input = await parseBody(req, bodySchema);

  // §142 — the SAME login bucket authorize() uses: the MFA layer can never
  // be used to bypass the password brute-force limiter.
  const rlLogin = rateLimit(`login:${input.email}:${ip}`, 10, 5 * 60 * 1000);
  if (!rlLogin.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please try again later.", {
      retryAfterMs: rlLogin.retryAfterMs,
    });
  }
  // §56 — dedicated challenge-issuance limiter on top.
  const rl = rateLimit(`mfa-challenge:${input.email}:${ip}`, 10, 5 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please try again later.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const user = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, passwordHash: true, sessionVersion: true },
  });

  // §200/§280 — identical generic failure whether the email is unknown,
  // the password is wrong, or MFA is not enabled (before password proof
  // the existence/absence of MFA is never revealed).
  const passwordOk = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
  if (!user || !passwordOk) {
    if (user) {
      await recordSecurityEvent({
        eventType: SECURITY_EVENTS.loginFailed,
        userId: user.id,
        reasonCode: "INVALID_CREDENTIALS",
        success: false,
        ip,
        userAgent: req.headers.get("user-agent"),
      });
    }
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const credential = await db.mfaCredential.findUnique({
    where: { userId: user.id },
    select: { enabledAt: true },
  });
  if (credential?.enabledAt == null) {
    // MFA not enabled — no challenge exists for this account. Generic
    // MFA_NOT_ENABLED lets the client fall back to the normal login form;
    // reaching here already required the CORRECT password (no oracle).
    throw new ApiError(400, "MFA_NOT_ENABLED", "Two-factor authentication is not active for this account.");
  }

  // §133 — bounded cleanup of this user's dead challenges + global expired.
  await cleanupChallenges(user.id).catch(() => undefined);

  // §47/§48 — raw token returned ONCE; only the hash is stored. Bound to
  // the current sessionVersion (§438).
  const rawChallenge = generateResetToken(); // 32B base64url — same crypto law
  if (!isPlausibleResetToken(rawChallenge)) {
    throw new ApiError(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
  const ttlSeconds = mfaChallengeTtlSeconds();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.mfaLoginChallenge.create({
    data: {
      userId: user.id,
      challengeHash: hashResetToken(rawChallenge),
      expiresAt,
      sessionVersionAtChallenge: user.sessionVersion,
    },
    select: { id: true },
  });

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.mfaLoginChallengeCreated,
    userId: user.id,
    success: true,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  return ok({
    mfaRequired: true,
    challenge: rawChallenge,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: ttlSeconds,
  });
});
