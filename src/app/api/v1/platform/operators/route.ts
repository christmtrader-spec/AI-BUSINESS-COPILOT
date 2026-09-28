/**
 * /api/v1/platform/operators — operator management (§54/§55/§56).
 *
 * GET  — list operators (platform:operators:read).
 * POST — create an operator (PLATFORM_SUPER_ADMIN only). Requires an
 *        EXISTING user (by email — no user is created here), a valid
 *        platform role, a reason and reauthentication (§56).
 * Bootstrap happens OFFLINE via scripts/platform-operator.ts (§61) — there
 * is deliberately NO public HTTP bootstrap route (§61/§62).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { PLATFORM_ROLES, isOperatorManagerRole } from "@/lib/platform/rbac";
import { platformOperatorDto } from "@/lib/platform/serializers";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:operators:read");

  const p = parsePagination(req.nextUrl.searchParams);
  const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "true";
  const where = includeInactive ? {} : { active: true };

  const [rows, total] = await Promise.all([
    db.platformOperator.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: p.pageSize,
      skip: p.skip,
      include: { user: { select: { email: true, name: true } } },
    }),
    db.platformOperator.count({ where }),
  ]);

  return platformOk({
    operators: rows.map(platformOperatorDto),
    page: pageMeta(p, total),
  });
});

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(PLATFORM_ROLES),
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:operators:manage");
  if (!isOperatorManagerRole(ctx.role)) {
    throw new ApiError(403, "PLATFORM_PERMISSION_DENIED", "Only a super admin can manage operators.");
  }
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:operator-create`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const user = await db.user.findUnique({ where: { email: body.email }, select: { id: true, email: true } });
  if (!user) {
    // No enumeration games for an internal endpoint: the operator console
    // addresses EXISTING users only (§61 — bootstrap requires existing user).
    throw new ApiError(404, "PLATFORM_INVALID_OPERATION", "No user exists with this email.");
  }
  const existing = await db.platformOperator.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (existing) {
    throw new ApiError(422, "PLATFORM_INVALID_OPERATION", "This user already has an operator record.");
  }

  const requestId = requestIdOf(req);
  const created = await db.$transaction(async (tx) => {
    const op = await tx.platformOperator.create({
      data: { userId: user.id, role: body.role, active: true },
      include: { user: { select: { email: true, name: true } } },
    });
    await platformAudit(
      {
        operatorId: ctx.operatorId,
        operatorRole: ctx.role,
        action: "platform.operator_created",
        entityType: "PlatformOperator",
        entityId: op.id,
        targetUserId: user.id,
        reason: body.reason,
        after: { role: body.role, active: true },
        requestId,
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      tx as Parameters<typeof platformAudit>[1],
    );
    return op;
  });

  return platformOk({ operator: platformOperatorDto(created), requestId }, 201);
});
