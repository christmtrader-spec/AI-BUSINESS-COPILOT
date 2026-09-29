/**
 * GET /api/v1/auth/email-verification/status — authenticated status only
 * (Prompt 30 §24, §161, §201/§202).
 *
 * Identity is the SESSION. No public per-email status exists (§201). The
 * response carries NO token, NO token hash, NO SMTP information (§24).
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { emailVerificationMode } from "@/lib/auth/email-verification/service";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const { assertFreshSession } = await import("@/lib/auth-security");
  const userId = await assertFreshSession(session);

  // Light abuse bound even for a read (§141-analog) — ENFORCED (Prompt 30-F
  // §11): an exhausted caller gets an honest 429, never a silent pass.
  const rl = rateLimit(`email-verify-status:${userId}:${getClientIp(req)}`, 60, 5 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });
  const verified = user?.emailVerifiedAt != null;
  const mode = emailVerificationMode();

  // §24 — canResend is a coarse policy signal (no limiter internals leak).
  const canResend = mode !== "OFF" && !verified;

  return ok({
    verified,
    verificationMode: mode,
    canResend,
    // nextAllowedAt intentionally omitted (§24: "if policy exposes it") —
    // the rate limiter internals are not part of the public contract.
  });
});
