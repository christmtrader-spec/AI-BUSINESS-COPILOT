/**
 * POST /api/v1/auth/email-verification/resend — AUTHENTICATED resend
 * (Prompt 30 §21/§22/§23, §139).
 *
 * Identity is the SESSION (never a body email — §22/§201: no public
 * resend-by-email endpoint exists). Only meaningful for UNVERIFIED
 * accounts; a verified account gets a safe no-op (no token, no email —
 * §249 duplicate protection).
 *
 * Delivery law (§12/§13/§221): SEND-BEFORE-PERSIST — the token row is
 * created only after provider.send() resolves; a failed send is an honest
 * { sent: false } with no token persisted, and a failed PERSIST after a
 * successful send is also reported as { sent: false } (documented §222
 * edge — the emailed link would be unusable).
 *
 * Rate limits (§21/§23/§139): per user+IP AND per user (no email bombing);
 * state is exposed via the status endpoint as canResend/nextAllowedAt.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getOrCreateRequestId } from "@/lib/observability/request-id";
import { logError, logInfo } from "@/lib/observability/logger";
import { maskAddress } from "@/lib/email";
import {
  cleanupEmailVerificationTokens,
  emailVerificationMode,
  buildEmailVerificationLink,
} from "@/lib/auth/email-verification/service";
import { EMAIL_VERIFICATION_TTL_MINUTES } from "@/lib/auth/config";
import { buildEmailVerificationEmail, getEmailProvider } from "@/lib/email";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const { assertFreshSession } = await import("@/lib/auth-security");
  const userId = await assertFreshSession(session);
  const ip = getClientIp(req);

  const mode = emailVerificationMode();
  if (mode === "OFF") {
    // Feature disabled — honest 503, never a fake send.
    throw new ApiError(503, "EMAIL_VERIFICATION_UNAVAILABLE", "Email verification is not available.");
  }

  // §21/§23/§139 — dual-dimension limiter.
  const rlUserIp = rateLimit(`email-verify-resend:${userId}:${ip}`, 3, 15 * 60_000);
  const rlUser = rateLimit(`email-verify-resend-u:${userId}`, 6, 60 * 60_000);
  if (!rlUserIp.allowed || !rlUser.allowed) {
    throw new ApiError(429, "EMAIL_VERIFICATION_RATE_LIMITED", "Too many requests. Please wait before requesting another email.", {
      retryAfterMs: rlUserIp.allowed ? rlUser.retryAfterMs : rlUserIp.retryAfterMs,
    });
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, locale: true, emailVerifiedAt: true },
  });
  if (!user) {
    throw new ApiError(401, "SESSION_INVALIDATED", "This session is no longer valid. Please sign in again.");
  }
  if (user.emailVerifiedAt !== null) {
    // §249 — already verified: safe no-op, no email, no token.
    return ok({ sent: false, alreadyVerified: true });
  }

  const requestId = getOrCreateRequestId(req);
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.emailVerificationRequested,
    userId: user.id,
    success: true,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  // §22/§161 — authenticated-only; transport resolved BEFORE token work.
  let provider;
  try {
    provider = getEmailProvider();
  } catch {
    throw new ApiError(503, "EMAIL_VERIFICATION_UNAVAILABLE", "Email delivery is temporarily unavailable. Please try again later.");
  }

  const { generateResetToken } = await import("@/lib/auth-security");
  const rawVerificationToken = generateResetToken();
  // Prompt 30-F §52 — the link builder needs a CONFIGURED base URL. When it
  // is missing this is a deployment misconfiguration: honest 503 under the
  // EMAIL-VERIFICATION vocabulary (never the password-reset code that
  // appBaseUrl throws — error contracts never cross flows, §314).
  let verificationUrl: string;
  try {
    verificationUrl = buildEmailVerificationLink(rawVerificationToken);
  } catch (error) {
    if (error instanceof ApiError && error.code === "RESET_DELIVERY_UNAVAILABLE") {
      throw new ApiError(503, "EMAIL_VERIFICATION_UNAVAILABLE", "Email delivery is temporarily unavailable. Please try again later.");
    }
    throw error;
  }
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60_000);

  const message = buildEmailVerificationEmail({
    to: user.email,
    recipientName: user.name,
    verificationUrl,
    minutes: EMAIL_VERIFICATION_TTL_MINUTES,
    locale: user.locale === "fa" ? "fa" : "en",
    appName: "AI Business Copilot",
  });

  const startedAt = Date.now();
  try {
    await provider.send(message);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const code = (error as { code?: string } | null)?.code ?? "DELIVERY_FAILED";
    logError("auth.email_verification.failed", {
      requestId,
      operation: "email_verification.send",
      provider: provider.name,
      recipient: maskAddress(user.email),
      durationMs,
      errorCode: typeof code === "string" ? code.slice(0, 60) : "DELIVERY_FAILED",
    });
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.emailVerificationFailed,
      userId: user.id,
      success: false,
      reasonCode: "DELIVERY_FAILED",
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    // Honest failure — no token persisted, nothing pretends to be sent.
    return ok({ sent: false, alreadyVerified: false });
  }
  logInfo(SECURITY_EVENTS.emailVerificationSent, {
    requestId,
    operation: "email_verification.send",
    provider: provider.name,
    recipient: maskAddress(user.email),
    durationMs: Date.now() - startedAt,
  });

  // Send resolved — NOW persist via the shared service (§7/§12): the SAME
  // rawToken is persisted so the emailed link matches the stored hash.
  try {
    const { issueEmailVerificationToken } = await import("@/lib/auth/email-verification/service");
    await issueEmailVerificationToken({
      userId: user.id,
      rawToken: rawVerificationToken,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    await cleanupEmailVerificationTokens(user.id).catch(() => undefined);
  } catch {
    // §221/§222 — persist failure after a successful send: the emailed link
    // would be unusable. Honest { sent: false }; the user simply retries.
    logError("auth.email_verification.failed", {
      requestId,
      operation: "email_verification.persist",
      reason: "persist_failed_after_send",
    });
    return ok({ sent: false, alreadyVerified: false });
  }

  void rlUserIp;
  return ok({
    sent: true,
    alreadyVerified: false,
    expiresAt: expiresAt.toISOString(),
    ttlMinutes: EMAIL_VERIFICATION_TTL_MINUTES,
  });
});
