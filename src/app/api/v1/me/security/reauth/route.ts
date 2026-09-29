/**
 * POST /api/v1/me/security/reauth — step-up reauthentication
 * (Prompt 30 §114/§116/§117, §162).
 *
 * Verifies the CURRENT password (and, when MFA is enabled, the current
 * TOTP) and records durable step-up events. Destructive flows then rely on
 * requireRecentPasswordAuth()/requireRecentStrongAuth() with the configured
 * recent-auth window (§115 — MFA_STEP_UP_MAX_AGE_SECONDS, default 10 min).
 *
 * §116/§117 — the server alone decides recency (SecurityEvent.createdAt);
 * no client timestamp, boolean or localStorage is trusted, and the JWT is
 * not expanded with auth state.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { StepUpError, verifyPasswordNow, verifyMfaNow } from "@/lib/auth/step-up";
import { stepUpMaxAgeSeconds } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1).max(200),
  /** Required when the account has MFA enabled (strong reauth). */
  mfaCode: z.string().trim().min(6).max(64).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  const ip = getClientIp(req);

  const rl = rateLimit(`stepup:${userId}:${ip}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment.");
  }

  const input = await parseBody(req, bodySchema);

  const meta = { ip, userAgent: req.headers.get("user-agent") };

  try {
    await verifyPasswordNow(userId, input.password, meta);
  } catch (error) {
    if (error instanceof StepUpError && error.code === "INVALID_CURRENT_PASSWORD") {
      throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "The password is incorrect.");
    }
    throw error;
  }

  // Strong reauth when MFA is active on the account (§113/§147-analog).
  const credential = await db.mfaCredential.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });
  let mfaVerified = false;
  if (credential?.enabledAt != null) {
    if (!input.mfaCode) {
      throw new ApiError(400, "MFA_CODE_REQUIRED", "Enter your authentication code to continue.");
    }
    try {
      await verifyMfaNow(userId, input.mfaCode, meta, { allowRecoveryCode: true });
      mfaVerified = true;
    } catch (error) {
      if (error instanceof StepUpError && error.code === "MFA_INVALID_CODE") {
        throw new ApiError(400, "MFA_INVALID_CODE", "Invalid authentication code.");
      }
      throw error;
    }
  }

  return ok({
    passwordVerified: true,
    mfaVerified,
    windowSeconds: stepUpMaxAgeSeconds(),
  });
});
