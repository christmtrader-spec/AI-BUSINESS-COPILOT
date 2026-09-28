/**
 * PATCH /api/v1/platform/operators/[id] — role / active management
 * (§54/§55/§56/§120).
 *
 * PLATFORM_SUPER_ADMIN only, reauthentication + reason required, audited.
 * LAST-SUPER-ADMIN PROTECTION (§55): deactivating, demoting (or any change
 * that would leave zero ACTIVE super admins) is rejected server-side —
 * the platform can never lock itself out of operator management.
 * Deactivating an operator leaves the user's tenant memberships untouched
 * (§120). Identity is server-derived; role fields from a browser session
 * can never grant this (§79/§132).
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
import { PLATFORM_ROLES, isOperatorManagerRole, permissionsOfPlatformRole, type PlatformRole } from "@/lib/platform/rbac";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    role: z.enum(PLATFORM_ROLES).optional(),
    active: z.boolean().optional(),
    reason: z.string().trim().min(3).max(300),
    password: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.role !== undefined || v.active !== undefined, {
    message: "Nothing to change — provide role and/or active.",
  });

export const PATCH = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:operators:manage");
  if (!isOperatorManagerRole(ctx.role)) {
    throw new ApiError(403, "PLATFORM_PERMISSION_DENIED", "Only a super admin can manage operators.");
  }
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:operator-update`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const target = await db.platformOperator.findUnique({ where: { id } });
  if (!target) {
    throw new ApiError(404, "PLATFORM_INVALID_OPERATION", "Operator not found.");
  }

  const nextRole = body.role ?? target.role;
  const nextActive = body.active ?? target.active;

  // LAST SUPER-ADMIN PROTECTION (§55) — server-side only, always enforced.
  // Applies when the change would remove THIS operator from the set of
  // active super admins (deactivation OR demotion).
  const removesActiveSuperAdmin =
    target.role === "PLATFORM_SUPER_ADMIN" &&
    target.active &&
    (nextRole !== "PLATFORM_SUPER_ADMIN" || !nextActive);
  if (removesActiveSuperAdmin) {
    const activeSuperAdmins = await db.platformOperator.count({
      where: { role: "PLATFORM_SUPER_ADMIN", active: true, NOT: { id: target.id } },
    });
    if (activeSuperAdmins === 0) {
      throw new ApiError(
        409,
        "PLATFORM_LAST_ADMIN_PROTECTED",
        "The last active super admin cannot be deactivated or demoted.",
      );
    }
  }

  const requestId = requestIdOf(req);
  const updated = await db.$transaction(async (tx) => {
    const op = await tx.platformOperator.update({
      where: { id },
      data: { role: nextRole, active: nextActive },
      include: { user: { select: { email: true, name: true } } },
    });
    await platformAudit(
      {
        operatorId: ctx.operatorId,
        operatorRole: ctx.role,
        action: body.active === false ? "platform.operator_deactivated" : "platform.operator_updated",
        entityType: "PlatformOperator",
        entityId: id,
        targetUserId: target.userId,
        reason: body.reason,
        before: { role: target.role, active: target.active },
        after: { role: nextRole, active: nextActive, permissions: permissionsOfPlatformRole(nextRole as PlatformRole).length },
        requestId,
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      tx as Parameters<typeof platformAudit>[1],
    );
    return op;
  });

  return platformOk({ operator: { id: updated.id, role: updated.role, active: updated.active }, requestId });
});
