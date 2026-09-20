/**
 * GET  /api/v1/invites/[token] — preview an invite (session required).
 * POST /api/v1/invites/[token] — accept the invite as the caller.
 *
 * SECURITY MODEL (differs from business-scoped routes on purpose):
 * the invitee may NOT be a member of any business yet, so this route
 * authenticates the SESSION only (never trusts x-business-id) and
 * authorizes via the opaque one-time token. The token grants nothing
 * besides the described membership, and only while PENDING + unexpired.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { asRole, ROLES } from "@/lib/rbac";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ token: string }> };

type InviteWithMeta = Awaited<ReturnType<typeof findInvite>>;

async function findInvite(token: string) {
  return db.businessInvite.findUnique({
    where: { token },
    include: {
      business: { select: { id: true, name: true, slug: true } },
      createdBy: { select: { name: true, email: true } },
    },
  });
}

function statusOf(
  invite: NonNullable<InviteWithMeta>,
): "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED" {
  if (invite.revokedAt !== null) return "REVOKED";
  if (invite.acceptedAt !== null) return "ACCEPTED";
  if (invite.expiresAt.getTime() < Date.now()) return "EXPIRED";
  return "PENDING";
}

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { token } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  const invite = await findInvite(token);
  if (!invite || !ROLES.includes(asRole(invite.role) as never)) {
    throw new ApiError(404, "NOT_FOUND", "This invitation link is invalid.");
  }

  const membership = await db.businessMember.findUnique({
    where: { businessId_userId: { businessId: invite.businessId, userId } },
  });

  return ok({
    businessName: invite.business.name,
    role: invite.role,
    inviter: invite.createdBy ? { name: invite.createdBy.name, email: invite.createdBy.email } : null,
    expiresAt: invite.expiresAt.toISOString(),
    status: statusOf(invite),
    callerIsMember: membership !== null,
  });
});

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { token } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  // Brute-force guard: token guessing is capped hard.
  const rl = rateLimit(`invite-accept:${userId}`, 10, 5 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const invite = await findInvite(token);
  if (!invite || !ROLES.includes(asRole(invite.role) as never)) {
    throw new ApiError(404, "NOT_FOUND", "This invitation link is invalid.");
  }
  if (invite.revokedAt !== null) {
    throw new ApiError(410, "INVITE_REVOKED", "This invitation has been revoked.");
  }
  if (invite.acceptedAt !== null) {
    throw new ApiError(410, "INVITE_ACCEPTED", "This invitation has already been used.");
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, "INVITE_EXPIRED", "This invitation has expired.");
  }
  // Defense in depth: an invite must never carry the OWNER role, even if a
  // database row was tampered with.
  if (invite.role === "OWNER") {
    throw new ApiError(422, "ROLE_NOT_INVITABLE", "Ownership cannot be granted via invite.");
  }

  const existing = await db.businessMember.findUnique({
    where: { businessId_userId: { businessId: invite.businessId, userId } },
  });
  if (existing) {
    throw new ApiError(409, "ALREADY_MEMBER", "You are already a member of this business.");
  }

  const member = await db.$transaction(async (tx) => {
    const created = await tx.businessMember.create({
      data: {
        businessId: invite.businessId,
        userId,
        role: invite.role,
      },
      include: { business: { select: { id: true, name: true, slug: true } } },
    });

    await tx.businessInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedById: userId },
    });

    await audit(
      {
        businessId: invite.businessId,
        actorId: userId,
        action: "member.invite_accept",
        entityType: "BusinessMember",
        entityId: created.id,
        after: { role: invite.role, via: "invite", inviteId: invite.id },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return created;
  });

  return ok(
    {
      business: member.business,
      role: member.role,
    },
    201,
  );
});
