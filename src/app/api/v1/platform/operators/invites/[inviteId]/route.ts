/**
 * DELETE /api/v1/platform/operators/invites/[inviteId] — revoke a pending
 * operator invitation (R67). Super admin ONLY, reauthentication (§56),
 * mandatory reason, audited. Idempotent on an already-revoked invite (§210
 * — no existence oracle games; a second revoke reports success without a
 * state change). Accepting a revoked invite is impossible server-side.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { isOperatorManagerRole } from "@/lib/platform/rbac";
import { recordSecurityEvent, SECURITY_EVENTS } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const revokeSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200),
});

export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ inviteId: string }> }) => {
  const { inviteId } = await params;
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:operators:manage");
  if (!isOperatorManagerRole(ctx.role)) {
    throw new ApiError(403, "PLATFORM_PERMISSION_DENIED", "Only a super admin can manage operators.");
  }
  const body = await parsePlatformBody(req, revokeSchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:operator-invite-revoke`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const invite = await db.platformOperatorInvite.findUnique({
    where: { id: inviteId },
    select: { id: true, email: true, role: true, revokedAt: true, acceptedAt: true },
  });
  // §126 — 404 for a foreign/unknown id; no content disclosure.
  if (!invite) {
    throw new ApiError(404, "NOT_FOUND", "Invitation not found.");
  }

  const alreadyRevoked = invite.revokedAt !== null;
  const requestId = requestIdOf(req);

  if (!alreadyRevoked && invite.acceptedAt === null) {
    await db.$transaction(async (tx) => {
      await tx.platformOperatorInvite.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() },
      });
      await platformAudit(
        {
          operatorId: ctx.operatorId,
          operatorRole: ctx.role,
          action: "platform.operator_invite_revoked",
          entityType: "PlatformOperatorInvite",
          entityId: invite.id,
          targetUserId: null,
          reason: body.reason,
          before: { status: "PENDING" },
          after: { status: "REVOKED" },
          requestId,
          ip: getClientIp(req),
          userAgent: req.headers.get("user-agent"),
        },
        tx as Parameters<typeof platformAudit>[1],
      );
    });
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.operatorInviteRevoked,
      userId: null,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
      success: true,
      reasonCode: null,
    });
  }

  // §210 — idempotent: revoking an already-revoked (or accepted) invite is a
  // no-op success; the client renders the honest state from the DTO.
  return platformOk({ revoked: true, alreadyRevoked, requestId });
});
