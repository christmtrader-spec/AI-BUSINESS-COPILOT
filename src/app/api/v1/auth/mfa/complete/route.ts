/**
 * POST /api/v1/auth/mfa/complete — step 3 of the MFA login flow
 * (Prompt 30 §51, §62-§63, §109).
 *
 * Input: { challenge, code, method } where method = TOTP | RECOVERY_CODE.
 *
 * Verifies: challenge format (constant gate BEFORE any DB work, §130-analog),
 * single-use atomic claim (§50), expiry, attempt budget (§56 — bounded
 * wrong-code attempts, then the challenge is invalidated, §57 — temporary,
 * never a permanent lockout), user still exists + MFA still enabled +
 * sessionVersion unchanged (§437/§438 — a password change/reset mid-flow
 * kills the challenge), and finally the code itself:
 *   - TOTP: standard 6-digit, ±1 step window, replay-protected (§43-§45);
 *   - RECOVERY_CODE: atomic single-use claim (§62), permanently consumed.
 *
 * On success a ONE-TIME assertion (§53) is stored hash-only on the
 * challenge row and returned to the client for the final NextAuth
 * authorize() call — the full JWT session is still issued exclusively by
 * NextAuth (§52).
 *
 * Error law (§55/§111/§284): generic "Invalid authentication code" — no
 * TOTP-secret existence, no recovery-code counts, no attempt counters
 * beyond the safe UX copy.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import {
  MFA_MAX_ATTEMPTS_PER_CHALLENGE,
  mfaChallengeTtlSeconds,
} from "@/lib/auth/config";
import {
  generateResetToken,
  hashResetToken,
  isPlausibleResetToken,
} from "@/lib/auth-security";
import {
  claimRecoveryCode,
  hashRecoveryCode,
  verifyMfaCodeForCredential,
} from "@/lib/auth/mfa/service";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  challenge: z.string().min(20).max(200),
  code: z.string().trim().min(6).max(64),
  method: z.enum(["TOTP", "RECOVERY_CODE"]),
});

export const POST = route(async (req: NextRequest) => {
  const ip = getClientIp(req);
  const input = await parseBody(req, bodySchema);

  // §130-analog — constant format gate BEFORE any database work.
  if (!isPlausibleResetToken(input.challenge)) {
    throw new ApiError(400, "MFA_CHALLENGE_INVALID", "This sign-in attempt is no longer valid. Please sign in again.");
  }

  const challengeHash = hashResetToken(input.challenge);
  const challenge = await db.mfaLoginChallenge.findUnique({
    where: { challengeHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      attemptCount: true,
      sessionVersionAtChallenge: true,
    },
  });

  // Generic invalid/expired — indistinguishable from unknown (§55).
  if (!challenge || challenge.usedAt !== null || challenge.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(
      400,
      challenge && challenge.usedAt !== null ? "MFA_CHALLENGE_INVALID" : "MFA_CHALLENGE_EXPIRED",
      "This sign-in attempt is no longer valid. Please sign in again.",
    );
  }

  // §56 — dedicated limiter per user+ip AND per challenge (double bound).
  const rl = rateLimit(`mfa-login:${challenge.userId}:${ip}`, 10, 5 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many attempts. Please try again later.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }
  const rlChallenge = rateLimit(`mfa-login-ch:${challenge.id}`, MFA_MAX_ATTEMPTS_PER_CHALLENGE + 2, 10 * 60 * 1000);
  if (!rlChallenge.allowed) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many attempts. Please sign in again.", {
      retryAfterMs: rlChallenge.retryAfterMs,
    });
  }

  const user = await db.user.findUnique({
    where: { id: challenge.userId },
    select: { id: true, sessionVersion: true },
  });
  const credential = user
    ? await db.mfaCredential.findUnique({
        where: { userId: user.id },
        select: { id: true, userId: true, encryptedSecret: true, enabledAt: true, lastUsedTotpStep: true },
      })
    : null;

  const mfaActive = credential?.enabledAt != null;
  const versionOk = user && user.sessionVersion === challenge.sessionVersionAtChallenge;
  if (!user || !mfaActive || !credential || !versionOk) {
    // Deleted user / MFA disabled mid-flow / password changed mid-flow
    // (§437/§438/§440) — the challenge is dead. Generic code.
    await db.mfaLoginChallenge.updateMany({
      where: { id: challenge.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    throw new ApiError(400, "MFA_CHALLENGE_INVALID", "This sign-in attempt is no longer valid. Please sign in again.");
  }

  // Attempt budget (§56): bounded wrong codes per challenge; exceeding it
  // invalidates the challenge (§57 — temporary throttle, re-login restarts;
  // NO permanent account lockout).
  if (challenge.attemptCount >= MFA_MAX_ATTEMPTS_PER_CHALLENGE) {
    await db.mfaLoginChallenge.updateMany({
      where: { id: challenge.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    throw new ApiError(400, "MFA_CHALLENGE_EXPIRED", "Too many incorrect codes. Please sign in again.");
  }

  let verified = false;
  let step: number | null = null;

  if (input.method === "TOTP") {
    const result = await verifyMfaCodeForCredential(credential, input.code);
    if (result.ok) {
      verified = true;
      step = result.step;
    }
  } else {
    // §62/§63 — atomic single-use recovery-code claim.
    const codeHash = hashRecoveryCode(input.code);
    const exists = await db.mfaRecoveryCode.findFirst({
      where: { userId: user.id, codeHash, usedAt: null },
      select: { id: true },
    });
    if (exists && (await claimRecoveryCode(user.id, input.code))) {
      verified = true;
      await recordSecurityEvent({
        eventType: SECURITY_EVENTS.mfaRecoveryCodeUsed,
        userId: user.id,
        reasonCode: "LOGIN",
        success: true,
        ip,
        userAgent: req.headers.get("user-agent"),
      });
    }
  }

  if (!verified) {
    // Bounded attempt counter on the challenge row + safe event.
    await db.mfaLoginChallenge.update({
      where: { id: challenge.id },
      data: { attemptCount: { increment: 1 } },
      select: { id: true },
    });
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.mfaLoginFailed,
      userId: user.id,
      reasonCode: input.method === "TOTP" ? "MFA_FAILED" : "RECOVERY_CODE_INVALID",
      success: false,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    // §55/§111/§284 — generic failure copy, no state disclosure.
    throw new ApiError(400, "MFA_INVALID_CODE", "Invalid authentication code.");
  }

  // Persist the TOTP replay state (§45) — same-or-older step rejected at
  // future logins; future steps are never blocked.
  if (step !== null) {
    await db.mfaCredential.update({
      where: { id: credential.id },
      data: { lastUsedTotpStep: step },
      select: { id: true },
    });
  }

  // §50 — atomic single-use claim of the challenge.
  const claimed = await db.mfaLoginChallenge.updateMany({
    where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new ApiError(400, "MFA_CHALLENGE_INVALID", "This sign-in attempt is no longer valid. Please sign in again.");
  }

  // §53 — one-time assertion: random, hash-only, single-use, user-bound,
  // consumed inside NextAuth authorize().
  const assertion = generateResetToken();
  await db.mfaLoginChallenge.update({
    where: { id: challenge.id },
    data: { assertionHash: hashResetToken(assertion) },
    select: { id: true },
  });

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.mfaLoginSucceeded,
    userId: user.id,
    reasonCode: input.method,
    success: true,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  return ok({
    assertion,
    expiresInSeconds: mfaChallengeTtlSeconds(),
    // The raw assertion is returned EXACTLY ONCE — never again (§53/§60-analog).
  });
});
