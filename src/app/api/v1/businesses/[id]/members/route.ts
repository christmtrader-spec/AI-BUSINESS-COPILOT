/**
 * GET  /api/v1/businesses/[id]/members — list members (members:read).
 * POST /api/v1/businesses/[id]/members — add an existing registered user
 *        as a member (members:manage). Assignee role must be lower than
 *        the actor's rank.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ROLES, ROLE_RANK } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const addSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES).default("VIEWER"),
});

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "members:read");

  const members = await db.businessMember.findMany({
    where: { businessId: ctx.businessId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return ok(
    members.map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      user: m.user,
      isOwner: m.userId === ctx.business.ownerId,
    })),
  );
});

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "members:manage");

  const input = await parseBody(req, addSchema);

  // Role hierarchy: cannot grant a role at or above your own rank.
  if (ROLE_RANK[input.role] >= ROLE_RANK[ctx.role] && ctx.role !== "OWNER") {
    throw new ApiError(403, "ROLE_TOO_HIGH", "You cannot assign a role at or above your own.");
  }
  if (input.role === "OWNER" && ctx.role !== "OWNER") {
    throw new ApiError(403, "ROLE_TOO_HIGH", "Only the business owner can grant the OWNER role.");
  }

  const user = await db.user.findUnique({ where: { email: input.email } });
  if (!user) {
    throw new ApiError(
      404,
      "USER_NOT_FOUND",
      "No registered account with this email. Ask them to sign up first.",
    );
  }

  const existing = await db.businessMember.findUnique({
    where: { businessId_userId: { businessId: ctx.businessId, userId: user.id } },
  });
  if (existing) {
    throw new ApiError(409, "ALREADY_MEMBER", "This user is already a member of the business.");
  }

  const member = await db.$transaction(async (tx) => {
    const created = await tx.businessMember.create({
      data: { businessId: ctx.businessId, userId: user.id, role: input.role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "member.add",
        entityType: "BusinessMember",
        entityId: created.id,
        after: { email: user.email, role: input.role },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return created;
  });

  return ok(
    {
      id: member.id,
      role: member.role,
      createdAt: member.createdAt,
      user: member.user,
      isOwner: false,
    },
    201,
  );
});
