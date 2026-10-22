/**
 * DELETE /api/v1/platform/operators/[id]/sessions/[sessionId] — surgical
 * single-session revocation for an operator account (R64).
 *
 * The mechanism is the EXISTING Prompt-30 primitive (per-device revokedAt
 * on the UserSession registry row — validated on EVERY request by the sid
 * freshness gate), NOT sessionVersion++: one device dies, the operator's
 * other sessions survive. The bulk kill-switch (invalidate-sessions) stays
 * available for account-level incidents.
 *
 * Guards — mirrored from users/[id]/invalidate-sessions (§22):
 *   platform:security:manage + canInvalidateSessions role check
 *   + reason-mandatory + reauthentication (§56) + per-operator rate limit
 *   + transactional audit (platform.operator_session_revoked) + durable
 *   SecurityEvent (auth.session.revoked — the ورود و خروج ledger).
 * A foreign session id under a valid operator id yields the SAME 404 as a
 * nonexistent one (no existence oracle, §126/§283).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, getClientIp } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { canInvalidateSessions } from "@/lib/platform/rbac";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ id: string; sessionId: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:security:manage");
  if (!canInvalidateSessions(ctx.role)) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.");
  }
  const { id, sessionId } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:revoke-session`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const operator = await db.platformOperator.findUnique({
    where: { id },
    select: { id: true, userId: true, role: true },
  });
  if (!operator) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "Operator not found.");
  }

  // Ownership is part of the lookup — no existence oracle (§126/§283).
  const target = await db.userSession.findFirst({
    where: { id: sessionId, userId: operator.userId },
    select: { id: true, revokedAt: true, deviceLabel: true },
  });
  if (!target) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "Session not found.");
  }

  const requestId = requestIdOf(req);
  let alreadyRevoked = target.revokedAt !== null;
  if (!alreadyRevoked) {
    await db.$transaction(async (tx) => {
      const claimed = await tx.userSession.updateMany({
        where: { id: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 1) {
        await platformAudit(
          {
            operatorId: ctx.operatorId,
            operatorRole: ctx.role,
            action: "platform.operator_session_revoked",
            entityType: "UserSession",
            entityId: target.id,
            targetUserId: operator.userId,
            reason: body.reason,
            before: { revoked: false, deviceLabel: target.deviceLabel },
            after: { revoked: true },
            requestId,
            ip: getClientIp(req),
            userAgent: req.headers.get("user-agent"),
          },
          tx as Parameters<typeof platformAudit>[1],
        );
      } else {
        // Lost a concurrent race — the session is dead either way; keep the
        // operation idempotent and honest instead of double-auditing.
        alreadyRevoked = true;
      }
    });
    if (!alreadyRevoked) {
      await recordSecurityEvent({
        eventType: SECURITY_EVENTS.sessionRevoked,
        userId: operator.userId,
        sessionId: target.id,
        success: true,
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      });
    }
  }

  return platformOk({
    revoked: true,
    alreadyRevoked,
    requestId,
  });
});
