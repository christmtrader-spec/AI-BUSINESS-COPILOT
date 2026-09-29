/**
 * GET /api/v1/me/security — Account Security summary (Prompt 30 §121, §159,
 * §202, §324).
 *
 * Identity is the SESSION (§127) — userId from the browser is never
 * accepted. Response is an explicit DTO with NO secrets (§121/§198):
 * verification state, MFA state, recovery-code COUNT (not codes, §64),
 * current session + count, and a coarse activity summary.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession, assertSessionRegistry } from "@/lib/auth-security";
import { emailVerificationMode } from "@/lib/auth/email-verification/service";
import { remainingRecoveryCodeCount } from "@/lib/auth/mfa/service";
import { toSessionDTO } from "@/lib/auth/sessions/service";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  rateLimit(`me-security:${userId}:${getClientIp(req)}`, 120, 5 * 60_000);

  // §81 — resolve the CURRENT session's registry id (server-side, §77).
  const currentRegistryId = await assertSessionRegistry(session, userId);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      emailVerifiedAt: true,
      mfaCredential: { select: { enabledAt: true } },
    },
  });
  if (!user) {
    const err = new (await import("@/lib/api-helpers")).ApiError(
      401,
      "SESSION_INVALIDATED",
      "This session is no longer valid. Please sign in again.",
    );
    throw err;
  }

  const [recoveryCodeCount, sessionCount, activity30d] = await Promise.all([
    remainingRecoveryCodeCount(user.id),
    db.userSession.count({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
    db.securityEvent.count({
      where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    }),
  ]);

  // Current session row for the DTO (bounded select, §198).
  const currentSessionRow = currentRegistryId
    ? await db.userSession.findUnique({
        where: { id: currentRegistryId },
        select: {
          id: true,
          deviceLabel: true,
          createdAt: true,
          lastSeenAt: true,
          expiresAt: true,
          revokedAt: true,
        },
      })
    : null;

  return ok({
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    emailVerificationMode: emailVerificationMode(),
    mfaEnabled: user.mfaCredential?.enabledAt != null,
    recoveryCodeCount,
    currentSession: currentSessionRow
      ? toSessionDTO(currentSessionRow, currentRegistryId)
      : // §230 — legacy JWT (compat window): honest "not registered" state.
        null,
    sessionCount,
    securityEventsSummary: {
      last30Days: activity30d,
    },
  });
});
