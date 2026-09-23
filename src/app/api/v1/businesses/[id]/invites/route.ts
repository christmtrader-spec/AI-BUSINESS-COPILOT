/**
 * GET  /api/v1/businesses/[id]/invites — list invites (members:read).
 * POST /api/v1/businesses/[id]/invites — mint an invite link
 *        (members:manage). ONE-TIME tokens with an expiry; the full token
 *        is returned exactly ONCE at creation and never again from the
 *        list endpoint (it is already shared with the invitee).
 *
 * OWNER is intentionally NOT grantable via invites — ownership transfer
 * needs a dedicated flow, not a link that can be forwarded.
 */
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ROLES, ROLE_RANK } from "@/lib/rbac";
import { assertWithinLimitIn, getEntitlementContextTx } from "@/lib/billing";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const createSchema = z.object({
  role: z.enum(ROLES).default("VIEWER"),
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
});

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "members:read");

  const invites = await db.businessInvite.findMany({
    where: { businessId: ctx.businessId },
    include: {
      createdBy: { select: { name: true, email: true } },
      acceptedBy: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Tokens are NEVER included here — only a harmless tail for recognition.
  return ok(
    invites.map((inv) => ({
      id: inv.id,
      role: inv.role,
      tokenTail: inv.token.slice(-4),
      status:
        inv.revokedAt !== null
          ? ("REVOKED" as const)
          : inv.acceptedAt !== null
            ? ("ACCEPTED" as const)
            : inv.expiresAt.getTime() < Date.now()
              ? ("EXPIRED" as const)
              : ("PENDING" as const),
      createdBy: inv.createdBy
        ? { name: inv.createdBy.name, email: inv.createdBy.email }
        : null,
      acceptedBy: inv.acceptedBy
        ? { name: inv.acceptedBy.name, email: inv.acceptedBy.email }
        : null,
      expiresAt: inv.expiresAt.toISOString(),
      acceptedAt: inv.acceptedAt?.toISOString() ?? null,
      createdAt: inv.createdAt.toISOString(),
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

  // Audit hardening: bound invite-token minting per manager/business.
  const rl = rateLimit(`invite:create:${ctx.userId}:${ctx.businessId}`, 30, 60 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many invites created. Please try again later.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, createSchema);

  // Role hierarchy (mirrors member add): never above the actor's rank, and
  // NEVER the OWNER role through an invite link.
  if (input.role === "OWNER") {
    throw new ApiError(
      422,
      "ROLE_NOT_INVITABLE",
      "Ownership cannot be granted through an invite link.",
    );
  }
  if (ROLE_RANK[input.role] >= ROLE_RANK[ctx.role] && ctx.role !== "OWNER") {
    throw new ApiError(403, "ROLE_TOO_HIGH", "You cannot invite a role at or above your own.");
  }

  const token = randomBytes(36).toString("base64url"); // 48 chars, opaque
  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const invite = await db.$transaction(
    async (tx) => {
      // Billing gate (§31): an accepted invite becomes an active member, so
      // minting checks TEAM_MEMBERS_MAX against ACTIVE members (owner
      // included; pending invites do NOT count — documented policy).
      const bctx = await getEntitlementContextTx(tx, ctx.businessId);
      const usage = await tx.businessMember.count({ where: { businessId: ctx.businessId } });
      assertWithinLimitIn(bctx, "TEAM_MEMBERS_MAX", usage);

      const created = await tx.businessInvite.create({
        data: {
          businessId: ctx.businessId,
          token,
          role: input.role,
          createdById: ctx.userId,
          expiresAt,
        },
      });

      await audit(
        {
          businessId: ctx.businessId,
          actorId: ctx.userId,
          action: "invite.create",
          entityType: "BusinessInvite",
          entityId: created.id,
          after: { role: input.role, expiresInDays: input.expiresInDays },
          ip: req.headers.get("x-forwarded-for"),
          userAgent: req.headers.get("user-agent"),
        },
        tx,
      );

      return created;
    },
    { isolationLevel: "Serializable" },
  );

  return ok(
    {
      id: invite.id,
      role: invite.role,
      token, // returned exactly once
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    },
    201,
  );
});
