/**
 * GET /api/v1/platform/users/[id] — single user detail (§21).
 * Same DTO law as the list — passwordHash can never appear because the
 * serializer is an explicit allowlist.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { platformError, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { platformUserDto } from "@/lib/platform/serializers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:users:read");
  const { id } = await params;

  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true, name: true, email: true, locale: true,
      createdAt: true, updatedAt: true, sessionVersion: true,
      _count: { select: { ownedBusinesses: true, memberships: true } },
      platformOperator: { select: { id: true, active: true, role: true } },
      ownedBusinesses: { select: { id: true, name: true, slug: true, currencyCode: true } },
    },
  });
  if (!user) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "User not found.");
  }

  return platformOk({
    user: platformUserDto(
      user,
      { ownedBusinesses: user._count.ownedBusinesses, memberships: user._count.memberships },
      user.platformOperator != null,
    ),
    platformOperator: user.platformOperator
      ? { id: user.platformOperator.id, role: user.platformOperator.role, active: user.platformOperator.active }
      : null,
    ownedBusinesses: user.ownedBusinesses,
  });
});
