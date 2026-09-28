/**
 * POST /api/v1/auth/password-reset/request — begin credential recovery
 * (Prompt 18 §7/§11/§12/§22 · Prompt 29 §12/§13/§19/§20/§21).
 *
 * Enumeration law: the response is GENERIC and identical for existing and
 * non-existing emails. Distinguishing failures happen only where they leak
 * nothing: an unavailable email transport fails BEFORE the user lookup so
 * both kinds of address get the same 503.
 *
 * Token law: raw token (32 random bytes, base64url) lives ONLY inside the
 * emailed link; the DB stores SHA-256(tokenHash). Never logged, never in
 * audit metadata, never returned by any API.
 *
 * Delivery law (Prompt 29 §13): the reset token row is persisted ONLY AFTER
 * provider.send() resolves successfully. If delivery definitively fails, no
 * token is created that "appears usable" while no email went out. Delivery
 * failure is still a GENERIC 200 (existence is never revealed) — but no
 * token is persisted. A single send attempt per request (§21); no automatic
 * retry inside the HTTP request path.
 *
 * Observability law (§19/§80): structured email events carry operation,
 * provider name, masked recipient, requestId, success/failure, durationMs,
 * errorCode. NEVER the reset URL, the raw token, or SMTP details.
 *
 * Cleanup law (§22): expired/consumed tokens are swept opportunistically —
 * no job queue on a single-node deployment.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { getOrCreateRequestId } from "@/lib/observability/request-id";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  PASSWORD_RESET_TTL_MINUTES,
  appBaseUrl,
  buildResetLink,
  generateResetToken,
  hashResetToken,
} from "@/lib/auth-security";
import { buildPasswordResetEmail, getEmailProvider, maskAddress } from "@/lib/email";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
});

/** Generic anti-enumeration copy — identical in every 200 path. */
function genericResponse() {
  return ok({
    message:
      "If an account exists for this email, instructions have been sent. Please check your inbox.",
  });
}

export const POST = route(async (req: NextRequest) => {
  const requestId = getOrCreateRequestId(req);
  const input = await parseBody(req, bodySchema);
  const ip = getClientIp(req);

  // §12/§20 — abuse guards on BOTH dimensions: per IP (spray) and per account
  // (targeted lockout-style bombing of one inbox). Unchanged by Prompt 29.
  const rlIp = rateLimit(`pwd-reset-ip:${ip}`, 5, 15 * 60_000);
  if (!rlIp.allowed) {
    logWarn(OPERATIONAL_EVENTS.apiRequestRateLimited, {
      requestId,
      route: "/api/v1/auth/password-reset/request",
      scope: "ip",
    });
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later.", {
      retryAfterMs: rlIp.retryAfterMs,
    });
  }
  const rlEmail = rateLimit(`pwd-reset-email:${input.email}`, 3, 60 * 60_000);
  if (!rlEmail.allowed) {
    logWarn(OPERATIONAL_EVENTS.apiRequestRateLimited, {
      requestId,
      route: "/api/v1/auth/password-reset/request",
      scope: "email",
    });
    // Same generic 429 for existing AND non-existing accounts.
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later.", {
      retryAfterMs: rlEmail.retryAfterMs,
    });
  }

  // §13/§14 — resolve the transport BEFORE any user lookup so an unconfigured
  // production deployment fails uniformly (no existence oracle). In dev this
  // is the console transport; in production without EMAIL_* config this is a
  // 503 for every caller.
  let provider;
  try {
    provider = getEmailProvider();
    appBaseUrl(); // also validates the configured base URL up-front
  } catch {
    logWarn(OPERATIONAL_EVENTS.authPasswordResetFailed, {
      requestId,
      operation: "password_reset.request",
      reason: "transport_unavailable",
    });
    throw new ApiError(
      503,
      "RESET_DELIVERY_UNAVAILABLE",
      "Password reset is temporarily unavailable. Please try again later.",
    );
  }

  logInfo(OPERATIONAL_EVENTS.authPasswordResetRequested, {
    requestId,
    operation: "password_reset.request",
    // Uniform event — does not assert whether the account exists.
  });

  const user = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, name: true, locale: true },
  });

  if (user) {
    // §22 — opportunistic cleanup: this user's dead tokens + global expired.
    const now = new Date();
    await db.passwordResetToken.deleteMany({
      where: { userId: user.id, OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    });
    await db.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } });

    // Invalidate any tokens still outstanding — one live link at a time.
    await db.passwordResetToken.deleteMany({ where: { userId: user.id } });

    const rawToken = generateResetToken();
    const resetUrl = buildResetLink(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000);

    const message = buildPasswordResetEmail({
      to: input.email,
      recipientName: user.name,
      resetUrl,
      minutes: PASSWORD_RESET_TTL_MINUTES,
      locale: user.locale === "fa" ? "fa" : "en",
      appName: "AI Business Copilot",
    });

    // Prompt 29 §13 — DELIVER FIRST, persist only on success. Single
    // bounded attempt (§21). The URL/token NEVER reach any log here.
    const startedAt = Date.now();
    try {
      await provider.send(message);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const code = (error as { code?: string } | null)?.code ?? "DELIVERY_FAILED";
      logError(OPERATIONAL_EVENTS.authPasswordResetFailed, {
        requestId,
        operation: "password_reset.send",
        provider: provider.name,
        recipient: maskAddress(input.email),
        durationMs,
        errorCode: typeof code === "string" ? code.slice(0, 60) : "DELIVERY_FAILED",
      });
      // Generic 200 — existence is not revealed — but NO token persisted.
      return genericResponse();
    }
    logInfo(OPERATIONAL_EVENTS.authPasswordResetSent, {
      requestId,
      operation: "password_reset.send",
      provider: provider.name,
      recipient: maskAddress(input.email),
      durationMs: Date.now() - startedAt,
    });

    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashResetToken(rawToken),
        expiresAt,
        requestedIp: ip,
        userAgent: req.headers.get("user-agent")?.slice(0, 255) ?? null,
      },
    });

    await audit({
      businessId: null,
      actorId: user.id,
      // §20/§21 — the token itself is NEVER written here.
      action: "auth.password_reset_requested",
      entityType: "User",
      entityId: user.id,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
  }

  return genericResponse();
});
