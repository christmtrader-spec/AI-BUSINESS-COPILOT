/**
 * DELETE /api/v1/businesses/[id]/invites/[inviteId] — revoke a pending
 * invite (members:manage). Accepted invites are historical records and
 * cannot be revoked; already-revoked invites are idempotent 200.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; inviteId: string }> };

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, inviteId } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "members:manage");

  const invite = await db.businessInvite.findUnique({
    where: { id: inviteId },
  });
  if (!invite || invite.businessId !== ctx.businessId) {
    throw new ApiError(404, "NOT_FOUND", "Invite not found.");
  }
  if (invite.acceptedAt !== null) {
    throw new ApiError(409, "ALREADY_ACCEPTED", "This invite has already been used.");
  }

  if (invite.revokedAt === null) {
    await db.$transaction(async (tx) => {
      await tx.businessInvite.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() },
      });
      await audit(
        {
          businessId: ctx.businessId,
          actorId: ctx.userId,
          action: "invite.revoke",
          entityType: "BusinessInvite",
          entityId: invite.id,
          before: { status: "PENDING" },
          after: { status: "REVOKED" },
          ip: req.headers.get("x-forwarded-for"),
          userAgent: req.headers.get("user-agent"),
        },
        tx,
      );
    });
  }

  return ok({ id: invite.id, revoked: true });
});
