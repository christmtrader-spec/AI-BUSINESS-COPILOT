/**
 * POST /api/v1/platform/users/[id]/invalidate-sessions (Prompt 28 §22).
 *
 * ONLY PLATFORM_SECURITY and PLATFORM_SUPER_ADMIN. Requires a reason and
 * reauthentication (current password, §56), is rate-limited per operator
 * (§57) and audited as platform.user_sessions_invalidated (§34). The
 * mechanism is the existing Prompt-18 primitive: User.sessionVersion++ so
 * every previously issued JWT fails the freshness checkpoints (§106).
 * Support is delivered through controlled metadata ONLY — no flow
 * in the platform layer ever assumes another user's identity (§23).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { canInvalidateSessions } from "@/lib/platform/rbac";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  // §22 — precise role gate (not a permission-catalog entry).
  requirePlatformPermission(ctx, "platform:security:manage");
  if (!canInvalidateSessions(ctx.role)) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.");
  }
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:invalidate-sessions`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const target = await db.user.findUnique({ where: { id }, select: { id: true, email: true, sessionVersion: true } });
  if (!target) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "User not found.");
  }

  const requestId = requestIdOf(req);
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: target.id },
      data: { sessionVersion: { increment: 1 } },
      select: { id: true, sessionVersion: true },
    });
    await platformAudit(
      {
        operatorId: ctx.operatorId,
        operatorRole: ctx.role,
        action: "platform.user_sessions_invalidated",
        entityType: "User",
        entityId: target.id,
        targetUserId: target.id,
        reason: body.reason,
        before: { sessionVersion: target.sessionVersion },
        after: { sessionVersion: u.sessionVersion },
        requestId,
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      tx as Parameters<typeof platformAudit>[1],
    );
    return u;
  });

  return platformOk({ invalidated: true, sessionVersion: updated.sessionVersion, requestId });
});
