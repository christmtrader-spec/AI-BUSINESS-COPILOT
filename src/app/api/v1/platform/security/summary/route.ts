/**
 * GET /api/v1/platform/security/summary — Security Center counters (R63-P).
 *
 * The auth-lifecycle (ورود و خروج) headline for the platform console:
 * login success/failure volume, rate-limited login attempts, MFA failures,
 * session revocations, suspended accounts, active operators and live
 * tracked sessions — all server-derived COUNTS only (no identities, no
 * money, no secrets — §18/§90 honesty laws).
 *
 * Guards (deny-by-default, same chain as every platform route):
 *   session → sessionVersion → PlatformOperator(active)
 *   → platform:security:read (SUPER_ADMIN + SECURITY + READONLY)
 *   → per-operator rate limit (reads are bounded too — defense in depth).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { SECURITY_EVENTS } from "@/lib/auth/security-events/service";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:security:read");

  const rl = rateLimit(`platform:${ctx.operatorId}:security-read`, 60, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many requests. Try again later.");
  }

  const now = new Date();
  const from24h = new Date(now.getTime() - 86_400_000);
  const from7d = new Date(now.getTime() - 7 * 86_400_000);

  const [
    logins24h,
    failedLogins24h,
    rateLimitedLogins24h,
    mfaFailures24h,
    sessionRevocations7d,
    suspendedUsers,
    activeOperators,
    activeSessions,
    eventsByType,
  ] = await Promise.all([
    db.securityEvent.count({
      where: { eventType: SECURITY_EVENTS.loginSuccess, createdAt: { gte: from24h } },
    }),
    db.securityEvent.count({
      where: { eventType: SECURITY_EVENTS.loginFailed, createdAt: { gte: from24h } },
    }),
    db.securityEvent.count({
      where: {
        eventType: SECURITY_EVENTS.loginFailed,
        reasonCode: "RATE_LIMITED",
        createdAt: { gte: from24h },
      },
    }),
    db.securityEvent.count({
      where: { eventType: SECURITY_EVENTS.mfaLoginFailed, createdAt: { gte: from24h } },
    }),
    db.securityEvent.count({
      where: {
        eventType: { in: [SECURITY_EVENTS.sessionRevoked, SECURITY_EVENTS.sessionRevokedAll] },
        createdAt: { gte: from7d },
      },
    }),
    db.user.count({ where: { suspendedAt: { not: null } } }),
    db.platformOperator.count({ where: { active: true } }),
    // Tracked sessions still live: never revoked AND not yet expired.
    db.userSession.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
    db.securityEvent.groupBy({
      by: ["eventType"],
      where: { createdAt: { gte: from24h } },
      _count: { _all: true },
    }),
  ]);

  const eventTypes24h: Record<string, number> = Object.fromEntries(
    eventsByType.map((g) => [g.eventType, g._count._all]),
  );

  return platformOk({
    generatedAt: now.toISOString(),
    logins24h,
    failedLogins24h,
    rateLimitedLogins24h,
    mfaFailures24h,
    sessionRevocations7d,
    suspendedUsers,
    activeOperators,
    activeSessions,
    eventTypes24h,
  });
});
