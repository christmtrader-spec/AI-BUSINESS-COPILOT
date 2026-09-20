/**
 * PATCH  /api/v1/businesses/[id]/members/[memberId] — change role
 *        (members:manage; hierarchy + last-owner protection).
 * DELETE /api/v1/businesses/[id]/members/[memberId] — remove member
 *        (members:manage; cannot remove the last OWNER).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ROLES, ROLE_RANK, asRole } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; memberId: string }> };

const updateSchema = z.object({ role: z.enum(ROLES) });

async function loadMember(businessId: string, memberId: string) {
  const member = await db.businessMember.findFirst({
    where: { id: memberId, businessId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!member) throw new ApiError(404, "NOT_FOUND", "Member not found.");
  return member;
}

async function ownerCount(businessId: string): Promise<number> {
  return db.businessMember.count({ where: { businessId, role: "OWNER" } });
}

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, memberId } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "members:manage");

  const input = await parseBody(req, updateSchema);
  const member = await loadMember(ctx.businessId, memberId);
  const targetRole = asRole(member.role);

  if (member.id === ctx.member.id) {
    throw new ApiError(400, "CANNOT_MODIFY_SELF", "You cannot change your own role here.");
  }
  // Hierarchy: actors can only modify members below their own rank,
  // except the OWNER who can manage everyone.
  if (ctx.role !== "OWNER" && ROLE_RANK[targetRole] >= ROLE_RANK[ctx.role]) {
    throw new ApiError(403, "ROLE_TOO_HIGH", "You cannot modify a member at or above your rank.");
  }
  if (input.role === "OWNER" && ctx.role !== "OWNER") {
    throw new ApiError(403, "ROLE_TOO_HIGH", "Only the business owner can grant the OWNER role.");
  }
  // Last-owner protection
  if (targetRole === "OWNER" && input.role !== "OWNER" && (await ownerCount(ctx.businessId)) <= 1) {
    throw new ApiError(400, "LAST_OWNER", "A business must keep at least one owner.");
  }

  const updated = await db.$transaction(async (tx) => {
    const m = await tx.businessMember.update({
      where: { id: member.id },
      data: { role: input.role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "member.role_change",
        entityType: "BusinessMember",
        entityId: m.id,
        before: { role: member.role },
        after: { role: m.role },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return m;
  });

  return ok({
    id: updated.id,
    role: updated.role,
    createdAt: updated.createdAt,
    user: updated.user,
    isOwner: updated.userId === ctx.business.ownerId,
  });
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, memberId } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "members:manage");

  const member = await loadMember(ctx.businessId, memberId);
  const targetRole = asRole(member.role);

  if (member.id === ctx.member.id) {
    throw new ApiError(400, "CANNOT_REMOVE_SELF", "You cannot remove yourself here.");
  }
  if (ctx.role !== "OWNER" && ROLE_RANK[targetRole] >= ROLE_RANK[ctx.role]) {
    throw new ApiError(403, "ROLE_TOO_HIGH", "You cannot remove a member at or above your rank.");
  }
  if (targetRole === "OWNER" && (await ownerCount(ctx.businessId)) <= 1) {
    throw new ApiError(400, "LAST_OWNER", "A business must keep at least one owner.");
  }

  await db.$transaction(async (tx) => {
    await tx.businessMember.delete({ where: { id: member.id } });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "member.remove",
        entityType: "BusinessMember",
        entityId: member.id,
        before: { email: member.user.email, role: member.role },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ removed: true });
});
